const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || 'klyncoin-secret-2024-seguro';

// --- Environment Configuration ---
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const MASTER_WALLET_ADDRESS = (process.env.MASTER_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000').toLowerCase();
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase();
const BSCSCAN_API = 'https://api.bscscan.com/api';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL || '60000', 10);
const FRONTEND_POLL_MS = parseInt(process.env.FRONTEND_POLL || '10000', 10);

// Mining constants
const BASE_SPEED = 0.0001; // KLYN/sec
const SPEED_PER_USDT = 0.00005; // KLYN/sec per USDT
const KLYN_TO_USDT_RATE = 0.001; // 1 KLYN = 0.001 USDT

// --- Supabase PostgreSQL Connection ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Middleware ---
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId || decoded.id;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Reference Code Generation ---
function generateReferenceCode(userId) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `KLYN-${userId}-${timestamp}-${random}`;
}

// ────────────────────────────────────────────────────────────────────────────
// DATABASE INITIALIZATION
// ────────────────────────────────────────────────────────────────────────────

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        wallet_address TEXT DEFAULT '',
        balance_usdt REAL DEFAULT 0,
        balance_klyn REAL DEFAULT 0,
        mining_speed REAL DEFAULT 0.0001,
        mined_unclaimed REAL DEFAULT 0,
        total_deposited REAL DEFAULT 0,
        last_mine_at TIMESTAMP DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ users table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS deposits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount REAL NOT NULL,
        txid TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        reference_code TEXT DEFAULT '',
        deposit_address TEXT DEFAULT '',
        checked_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ deposits table ready');

    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount_klyn REAL NOT NULL,
        amount_usdt REAL NOT NULL,
        wallet_address TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('✅ withdrawals table ready');

    // Create test user if not exists
    const existing = await client.query(
      "SELECT id FROM users WHERE email = 'test@klyncoin.com'"
    );

    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash('password123', 10);
      await client.query(
        `INSERT INTO users (email, password, wallet_address, balance_usdt, balance_klyn, mining_speed, mined_unclaimed, total_deposited)
         VALUES ('test@klyncoin.com', $1, '0xTestWallet', 10, 100, 0.0006, 5, 10)`,
        [hash]
      );
      console.log('✅ Test user created: test@klyncoin.com / password123');
    } else {
      console.log('ℹ️  Test user already exists, skipping');
    }

    console.log('✅ Database tables initialized successfully\n');
  } finally {
    client.release();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// MINING LOGIC
// ────────────────────────────────────────────────────────────────────────────

/**
 * Calculate mining earnings since last mine and update the user's record.
 * Returns the updated user data with camelCase fields (matching original API).
 */
async function calculateAndGetUser(userId) {
  const client = await pool.connect();
  try {
    // Fetch current user state
    const userRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!userRes.rows.length) return null;

    const user = userRes.rows[0];

    const lastMine = user.last_mine_at ? new Date(user.last_mine_at) : new Date();
    const now = new Date();
    const elapsedSec = Math.max(0, (now - lastMine) / 1000);

    const mined = elapsedSec * user.mining_speed;

    // Update mined_unclaimed and last_mine_at
    await client.query(
      `UPDATE users SET mined_unclaimed = mined_unclaimed + $1, last_mine_at = NOW() WHERE id = $2`,
      [mined, userId]
    );

    // Re-fetch updated values
    const updatedRes = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    const u = updatedRes.rows[0];

    // Count pending deposits
    const pendingRes = await client.query(
      "SELECT COUNT(*)::int AS cnt FROM deposits WHERE user_id = $1 AND status = 'pending'",
      [userId]
    );
    const pendingDeposits = pendingRes.rows[0].cnt;

    return {
      id: u.id,
      email: u.email,
      walletAddress: u.wallet_address,
      balanceUsdt: u.balance_usdt,
      balanceKlyn: u.balance_klyn,
      miningSpeed: u.mining_speed,
      minedUnclaimed: u.mined_unclaimed,
      totalDeposited: u.total_deposited,
      lastMineAt: u.last_mine_at,
      pendingDeposits,
      createdAt: u.created_at
    };
  } finally {
    client.release();
  }
}

/**
 * Simple mining calculation that updates and returns just the mining-related fields.
 * Used by /api/mining/status and /api/mining/claim.
 */
async function calculateMining(userId) {
  const user = await calculateAndGetUser(userId);
  return user;
}

// ────────────────────────────────────────────────────────────────────────────
// BSCSCAN DEPOSIT CHECKING
// ────────────────────────────────────────────────────────────────────────────

let lastCheckedTx = '';
let bscscanPollCount = 0;

async function checkBSCScanDeposits() {
  if (!BSCSCAN_API_KEY || MASTER_WALLET_ADDRESS === '0x'.padEnd(42, '0')) {
    return [];
  }

  try {
    const url = `${BSCSCAN_API}?module=account&action=tokentx` +
      `&contractaddress=${USDT_CONTRACT}` +
      `&address=${MASTER_WALLET_ADDRESS}` +
      `&sort=desc&limit=25` +
      `&apikey=${BSCSCAN_API_KEY}`;

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`BSCScan API HTTP error: ${response.status}`);
      return [];
    }

    const data = await response.json();
    if (data.status !== '1') {
      console.error(`BSCScan API error: ${data.message || data.result}`);
      return [];
    }

    const txs = data.result || [];
    if (!txs.length) return [];

    if (!lastCheckedTx && txs.length > 0) {
      lastCheckedTx = txs[0].hash;
    }

    bscscanPollCount++;
    if (bscscanPollCount % 10 === 0) {
      console.log(`BSCScan: Found ${txs.length} recent USDT transfers to master wallet`);
    }

    return txs;
  } catch (err) {
    console.error('BSCScan fetch error:', err.message);
    return [];
  }
}

async function findMatchingBSCTransaction(deposit, bscTxs) {
  const amountTolerance = 0.5;
  const depositTime = new Date(deposit.created_at).getTime();

  for (const tx of bscTxs) {
    if (tx.to.toLowerCase() !== MASTER_WALLET_ADDRESS) continue;

    const txAmount = parseFloat(tx.value) / 1e18;
    if (Math.abs(txAmount - deposit.amount) > amountTolerance) continue;

    const txTime = parseInt(tx.timeStamp, 10) * 1000;
    if (txTime < depositTime - 300000) continue;

    if (deposit.reference_code && tx.input && tx.input !== '0x') {
      try {
        const inputHex = tx.input.toLowerCase();
        const refHex = Buffer.from(deposit.reference_code).toString('hex').toLowerCase();
        if (inputHex.includes(refHex)) {
          return tx;
        }
      } catch (e) {
        // ignore
      }
    }

    // If no reference match, check if this amount is unique among pending deposits
    const sameAmountRes = await pool.query(
      "SELECT COUNT(*)::int AS cnt FROM deposits WHERE amount = $1 AND status = 'pending' AND id != $2",
      [deposit.amount, deposit.id]
    );
    const count = sameAmountRes.rows[0].cnt;
    if (count === 0) {
      return tx;
    }
  }

  return null;
}

async function verifyDepositById(depositId, txid) {
  // Get the deposit
  const depRes = await pool.query('SELECT * FROM deposits WHERE id = $1', [depositId]);
  if (!depRes.rows.length) return;

  const deposit = depRes.rows[0];
  if (deposit.status !== 'pending') return;

  const newSpeed = deposit.amount * SPEED_PER_USDT;

  // Update deposit
  await pool.query(
    "UPDATE deposits SET status = 'confirmed', txid = $1 WHERE id = $2",
    [txid || 'auto-verified', depositId]
  );

  // Boost user
  await pool.query(
    `UPDATE users SET
      balance_usdt = balance_usdt + $1,
      total_deposited = total_deposited + $1,
      mining_speed = mining_speed + $2
     WHERE id = $3`,
    [deposit.amount, newSpeed, deposit.user_id]
  );

  console.log(`✅ Deposit #${depositId} verified: +${deposit.amount} USDT, +${newSpeed} KLYN/s mining speed`);
}

async function processPendingDeposits() {
  try {
    const pendingRes = await pool.query(
      `SELECT d.id, d.user_id, d.amount, d.reference_code, d.created_at,
              u.email, u.mining_speed
       FROM deposits d
       JOIN users u ON d.user_id = u.id
       WHERE d.status = 'pending'
       ORDER BY d.created_at ASC`
    );

    if (!pendingRes.rows.length) return;

    const pendingDeposits = pendingRes.rows;
    console.log(`Deposit checker: ${pendingDeposits.length} pending deposits found`);

    // Try BSCScan matching first (Mode A)
    const bscTxs = await checkBSCScanDeposits();

    if (bscTxs.length > 0) {
      for (const deposit of pendingDeposits) {
        const matched = await findMatchingBSCTransaction(deposit, bscTxs);
        if (matched) {
          console.log(`Auto-verifying deposit #${deposit.id} for ${deposit.email}: ${deposit.amount} USDT (tx: ${matched.hash})`);
          await verifyDepositById(deposit.id, matched.hash);
        }
      }
    } else if (!BSCSCAN_API_KEY || MASTER_WALLET_ADDRESS === '0x'.padEnd(42, '0')) {
      if (bscscanPollCount % 5 === 0 && bscscanPollCount > 0) {
        console.log('Deposit checker: BSCScan not configured. Waiting for manual verification.');
      }
    }

    // Increment checked_count for all pending deposits
    await pool.query(
      "UPDATE deposits SET checked_count = checked_count + 1 WHERE status = 'pending'"
    );

  } catch (err) {
    console.error('processPendingDeposits error:', err);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// API ROUTES
// ────────────────────────────────────────────────────────────────────────────

// POST /api/register
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, walletAddress } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password, wallet_address, mining_speed) VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, hashedPassword, walletAddress || '', BASE_SPEED]
    );

    const id = result.rows[0].id;
    const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id, email } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/user
app.get('/api/user', authMiddleware, async (req, res) => {
  try {
    const user = await calculateAndGetUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('User fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/deposit/address
app.get('/api/deposit/address', authMiddleware, async (req, res) => {
  try {
    const user = await calculateAndGetUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const referenceCode = generateReferenceCode(req.userId);

    res.json({
      depositAddress: MASTER_WALLET_ADDRESS,
      referenceCode,
      minDeposit: 1.00,
      network: 'BSC (BEP20)',
      token: 'USDT',
      contractAddress: USDT_CONTRACT,
      bscscanMode: !!(BSCSCAN_API_KEY && MASTER_WALLET_ADDRESS !== '0x'.padEnd(42, '0'))
    });
  } catch (err) {
    console.error('Deposit address error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/deposit
app.post('/api/deposit', authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1.00) {
      return res.status(400).json({ error: 'Minimum deposit is 1.00 USDT' });
    }

    const referenceCode = generateReferenceCode(req.userId);

    const result = await pool.query(
      `INSERT INTO deposits (user_id, amount, reference_code, deposit_address, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
      [req.userId, amount, referenceCode, MASTER_WALLET_ADDRESS]
    );

    const id = result.rows[0].id;

    res.json({
      message: 'Deposit request created! Send USDT and check status below.',
      depositId: id,
      referenceCode,
      depositAddress: MASTER_WALLET_ADDRESS,
      amount,
      network: 'BSC (BEP20)'
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/deposit/check
app.get('/api/deposit/check', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount, reference_code, deposit_address, status, checked_count, created_at
       FROM deposits
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.userId]
    );

    if (!result.rows.length) {
      return res.json({ hasDeposit: false });
    }

    const dep = result.rows[0];

    const allResult = await pool.query(
      `SELECT id, amount, reference_code, status, created_at
       FROM deposits
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [req.userId]
    );

    res.json({
      hasDeposit: true,
      deposit: {
        id: dep.id,
        amount: dep.amount,
        referenceCode: dep.reference_code,
        depositAddress: dep.deposit_address,
        status: dep.status,
        checkedCount: dep.checked_count,
        createdAt: dep.created_at
      },
      allDeposits: allResult.rows.map(d => ({
        id: d.id,
        amount: d.amount,
        reference_code: d.reference_code,
        status: d.status,
        created_at: d.created_at
      }))
    });
  } catch (err) {
    console.error('Deposit check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/deposits
app.get('/api/deposits', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount, txid, status, reference_code, created_at
       FROM deposits
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId]
    );

    res.json(result.rows.map(d => ({
      id: d.id,
      amount: d.amount,
      txid: d.txid,
      status: d.status,
      reference_code: d.reference_code,
      created_at: d.created_at
    })));
  } catch (err) {
    console.error('Deposits fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/withdraw
app.post('/api/withdraw', authMiddleware, async (req, res) => {
  try {
    const { amount, walletAddress } = req.body;
    console.log('Withdraw request:', { amount, walletAddress });

    if (!amount || amount < 3.00) {
      return res.status(400).json({ error: 'Minimum withdrawal is 3.00 USDT' });
    }

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    const amountUsdt = parseFloat(amount);
    const amountKlyn = amountUsdt / KLYN_TO_USDT_RATE;

    const user = await calculateAndGetUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    console.log('User balance KLYN:', user.balanceKlyn, 'Needed:', amountKlyn);

    if (user.balanceKlyn < amountKlyn) {
      return res.status(400).json({
        error: `Insufficient KLYN balance. You need ${amountKlyn.toFixed(4)} KLYN but have ${user.balanceKlyn.toFixed(4)} KLYN`
      });
    }

    await pool.query(
      'UPDATE users SET balance_klyn = balance_klyn - $1 WHERE id = $2',
      [amountKlyn, req.userId]
    );

    await pool.query(
      `INSERT INTO withdrawals (user_id, amount_klyn, amount_usdt, wallet_address, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [req.userId, amountKlyn, amountUsdt, walletAddress]
    );

    res.json({ message: `Withdrawal of ${amountUsdt.toFixed(2)} USDT (${amountKlyn.toFixed(4)} KLYN) submitted` });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/withdrawals
app.get('/api/withdrawals', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, amount_klyn, amount_usdt, wallet_address, status, created_at
       FROM withdrawals
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.userId]
    );

    res.json(result.rows.map(w => ({
      id: w.id,
      amount_klyn: w.amount_klyn,
      amount_usdt: w.amount_usdt,
      wallet_address: w.wallet_address,
      status: w.status,
      created_at: w.created_at
    })));
  } catch (err) {
    console.error('Withdrawals fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mining/status
app.get('/api/mining/status', authMiddleware, async (req, res) => {
  try {
    const user = await calculateAndGetUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      balanceKlyn: user.balanceKlyn,
      balanceUsdt: user.balanceUsdt,
      miningSpeed: user.miningSpeed,
      minedUnclaimed: user.minedUnclaimed,
      totalDeposited: user.totalDeposited
    });
  } catch (err) {
    console.error('Mining status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/mining/claim
app.post('/api/mining/claim', authMiddleware, async (req, res) => {
  try {
    const user = await calculateAndGetUser(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.minedUnclaimed <= 0) {
      return res.status(400).json({ error: 'Nothing to claim' });
    }

    const amount = user.minedUnclaimed;
    await pool.query(
      'UPDATE users SET balance_klyn = balance_klyn + $1, mined_unclaimed = 0 WHERE id = $2',
      [amount, req.userId]
    );

    res.json({ message: `Claimed ${amount.toFixed(8)} KLYN`, amount });
  } catch (err) {
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/deposit/verify (admin/simulation endpoint)
app.post('/api/deposit/verify', authMiddleware, async (req, res) => {
  try {
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ error: 'Deposit ID required' });

    const depRes = await pool.query('SELECT * FROM deposits WHERE id = $1', [depositId]);
    if (!depRes.rows.length) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    const deposit = depRes.rows[0];
    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: 'Deposit already processed' });
    }

    const newSpeed = deposit.amount * SPEED_PER_USDT;

    await pool.query(
      "UPDATE deposits SET status = 'confirmed' WHERE id = $1",
      [depositId]
    );

    await pool.query(
      `UPDATE users SET
        balance_usdt = balance_usdt + $1,
        total_deposited = total_deposited + $1,
        mining_speed = mining_speed + $2
       WHERE id = $3`,
      [deposit.amount, newSpeed, deposit.user_id]
    );

    res.json({
      message: `Deposit of ${deposit.amount} USDT confirmed. Mining speed boosted!`,
      speedIncrease: newSpeed
    });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/config
app.get('/api/config', (req, res) => {
  res.json({
    minDeposit: 1.00,
    minWithdrawal: 3.00,
    klynToUsdtRate: KLYN_TO_USDT_RATE,
    baseSpeed: BASE_SPEED,
    speedPerUsdt: SPEED_PER_USDT,
    bscscanMode: !!(BSCSCAN_API_KEY && MASTER_WALLET_ADDRESS !== '0x'.padEnd(42, '0')),
    masterWalletAddress: MASTER_WALLET_ADDRESS,
    checkIntervalMs: CHECK_INTERVAL_MS,
    frontendPollMs: FRONTEND_POLL_MS
  });
});

// GET /api/health
app.get('/api/health', async (req, res) => {
  try {
    const userCountRes = await pool.query("SELECT COUNT(*)::int AS cnt FROM users");
    const depCountRes = await pool.query("SELECT COUNT(*)::int AS cnt FROM deposits WHERE status = 'pending'");

    res.json({
      status: 'ok',
      uptime: process.uptime(),
      bscscanConfigured: !!(BSCSCAN_API_KEY && MASTER_WALLET_ADDRESS !== '0x'.padEnd(42, '0')),
      pendingDeposits: depCountRes.rows[0].cnt,
      totalUsers: userCountRes.rows[0].cnt
    });
  } catch (err) {
    console.error('Health check error:', err);
    res.json({ status: 'ok', uptime: process.uptime() });
  }
});

// --- Frontend catch-all ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ────────────────────────────────────────────────────────────────────────────
// START SERVER
// ────────────────────────────────────────────────────────────────────────────

async function start() {
  await initDB();

  // Log startup banner
  const bscMode = !!(BSCSCAN_API_KEY && MASTER_WALLET_ADDRESS !== '0x'.padEnd(42, '0'));
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     🪙 KLYNCoin Server v3.0            ║`);
  console.log(`║     Database: PostgreSQL (Supabase)     ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Deposit mode: ${bscMode ? 'BSCScan Auto ✅' : 'Manual / Reference 📝'}      ║`);
  if (bscMode) {
    console.log(`║  Master wallet: ${MASTER_WALLET_ADDRESS.substring(0, 10)}...  ║`);
  }
  console.log(`║  Check interval: ${CHECK_INTERVAL_MS / 1000}s                  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Run deposit checker every CHECK_INTERVAL_MS
  setInterval(processPendingDeposits, CHECK_INTERVAL_MS);
  setTimeout(processPendingDeposits, 5000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KLYNCoin server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});