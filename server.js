const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3456;
const JWT_SECRET = process.env.JWT_SECRET || 'klyncoin-secret-key-2024';
const DB_PATH = path.join('/tmp', 'database.sqlite');

// --- Environment Configuration ---
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const MASTER_WALLET_ADDRESS = (process.env.MASTER_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000').toLowerCase();
const USDT_CONTRACT = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase();
const BSCSCAN_API = 'https://api.bscscan.com/api';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL || '60000', 10);
const FRONTEND_POLL_MS = parseInt(process.env.FRONTEND_POLL || '10000', 10);

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Setup ---
let db;
const SALT_ROUNDS = 10;

// Mining constants
const BASE_SPEED = 0.0001; // KLYN/sec
const SPEED_PER_USDT = 0.00005; // KLYN/sec per USDT
const KLYN_TO_USDT_RATE = 0.001; // 1 KLYN = 0.001 USDT

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      wallet_address TEXT DEFAULT '',
      balance_usdt REAL DEFAULT 0,
      balance_klyn REAL DEFAULT 0,
      mining_speed REAL DEFAULT 0.0001,
      mined_unclaimed REAL DEFAULT 0,
      total_deposited REAL DEFAULT 0,
      last_mine_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Enhanced deposits table with reference_code and deposit_address
  db.run(`
    CREATE TABLE IF NOT EXISTS deposits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      txid TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      reference_code TEXT DEFAULT '',
      deposit_address TEXT DEFAULT '',
      checked_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Migrate old deposits table: add columns if they don't exist
  try { db.run(`ALTER TABLE deposits ADD COLUMN reference_code TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE deposits ADD COLUMN deposit_address TEXT DEFAULT ''`); } catch(e) {}
  try { db.run(`ALTER TABLE deposits ADD COLUMN checked_count INTEGER DEFAULT 0`); } catch(e) {}

  db.run(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount_klyn REAL NOT NULL,
      amount_usdt REAL NOT NULL,
      wallet_address TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  saveDB();
}

function saveDB() {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (err) {
      console.error('saveDB error:', err);
    }
  }
}

// --- Reference Code Generation ---
function generateReferenceCode(userId) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `KLYN-${userId}-${timestamp}-${random}`;
}

// --- BSCScan API Polling ---
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

    // Track the latest tx hash to avoid re-checking
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

// --- Background Deposit Checker ---
async function processPendingDeposits() {
  const result = db.exec(
    `SELECT d.id, d.user_id, d.amount, d.reference_code, d.created_at,
            u.email, u.mining_speed
     FROM deposits d
     JOIN users u ON d.user_id = u.id
     WHERE d.status = 'pending'
     ORDER BY d.created_at ASC`
  );

  if (!result.length || !result[0].values.length) return;

  const cols = result[0].columns;
  const pendingDeposits = result[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });

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
    // Mode B: No BSCScan configured — check for pending deposits that can be auto-verified
    // via other mechanisms (e.g., mark deposits that match the reference code pattern)
    if (bscscanPollCount % 5 === 0 && bscscanPollCount > 0) {
      console.log('Deposit checker: BSCScan not configured. Waiting for manual verification or reference-based deposits.');
    }
  }

  // Increment checked_count for all pending deposits
  for (const deposit of pendingDeposits) {
    db.run(`UPDATE deposits SET checked_count = checked_count + 1 WHERE id = ?`, {
      bind: [deposit.id]
    });
  }
  saveDB();
}

async function findMatchingBSCTransaction(deposit, bscTxs) {
  const amountTolerance = 0.5; // Allow 0.5 USDT tolerance for fees
  const depositTime = new Date(deposit.created_at + 'Z').getTime();

  for (const tx of bscTxs) {
    // Check: is this a transfer TO our master wallet?
    if (tx.to.toLowerCase() !== MASTER_WALLET_ADDRESS) continue;

    // Check: does the amount match?
    const txAmount = parseFloat(tx.value) / 1e18;
    if (Math.abs(txAmount - deposit.amount) > amountTolerance) continue;

    // Check: was this transaction after the deposit request?
    const txTime = parseInt(tx.timeStamp, 10) * 1000;
    if (txTime < depositTime - 300000) continue; // Within 5 min before (time sync tolerance)

    // Check: reference in input data (if the user included a memo)
    if (deposit.reference_code && tx.input && tx.input !== '0x') {
      try {
        const inputHex = tx.input.toLowerCase();
        const refHex = Buffer.from(deposit.reference_code).toString('hex').toLowerCase();
        // Some wallets embed reference in the input data
        if (inputHex.includes(refHex)) {
          return tx;
        }
      } catch(e) {}
    }

    // If no reference match, just match by amount (if this deposit is the only one with this amount)
    const sameAmount = db.exec(
      `SELECT COUNT(*) as cnt FROM deposits
       WHERE amount = ? AND status = 'pending' AND id != ?`,
      { bind: [deposit.amount, deposit.id] }
    );
    const count = sameAmount.length ? sameAmount[0].values[0][0] : 0;
    if (count === 0) {
      return tx;
    }
  }

  return null;
}

async function verifyDepositById(depositId, txid) {
  // Get the deposit
  const depResult = db.exec(`SELECT * FROM deposits WHERE id = ?`, { bind: [depositId] });
  if (!depResult.length || !depResult[0].values.length) return;

  const depCols = depResult[0].columns;
  const depVals = depResult[0].values[0];
  const deposit = {};
  depCols.forEach((c, i) => deposit[c] = depVals[i]);

  if (deposit.status !== 'pending') return;

  const newSpeed = deposit.amount * SPEED_PER_USDT;

  // Update deposit
  db.run(`UPDATE deposits SET status = 'confirmed', txid = ? WHERE id = ?`, {
    bind: [txid || 'auto-verified', depositId]
  });

  // Boost user
  db.run(`
    UPDATE users SET
      balance_usdt = balance_usdt + ?,
      total_deposited = total_deposited + ?,
      mining_speed = mining_speed + ?
    WHERE id = ?
  `, {
    bind: [deposit.amount, deposit.amount, newSpeed, deposit.user_id]
  });
  saveDB();

  console.log(`✅ Deposit #${depositId} verified: +${deposit.amount} USDT, +${newSpeed} KLYN/s mining speed`);
}

// --- Auth Middleware ---
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// --- Mining Logic ---
function calculateMining(userId) {
  const user = db.exec(`SELECT * FROM users WHERE id = ?`, { bind: [userId] });
  if (!user.length || !user[0].values.length) return null;

  const cols = user[0].columns;
  const vals = user[0].values[0];
  const u = {};
  cols.forEach((c, i) => u[c] = vals[i]);

  const lastMine = new Date(u.last_mine_at + 'Z');
  const now = new Date();
  const elapsedSec = Math.max(0, (now - lastMine) / 1000);

  const mined = elapsedSec * u.mining_speed;

  db.run(`UPDATE users SET mined_unclaimed = mined_unclaimed + ?, last_mine_at = datetime('now') WHERE id = ?`, {
    bind: [mined, userId]
  });
  saveDB();

  return {
    minedThisPeriod: mined,
    newUnclaimed: u.mined_unclaimed + mined,
    miningSpeed: u.mining_speed
  };
}

function getUserData(userId) {
  calculateMining(userId);
  const result = db.exec(`SELECT * FROM users WHERE id = ?`, { bind: [userId] });
  if (!result.length || !result[0].values.length) return null;

  const cols = result[0].columns;
  const vals = result[0].values[0];
  const u = {};
  cols.forEach((c, i) => u[c] = vals[i]);

  // Count pending deposits
  const pendingCount = db.exec(`SELECT COUNT(*) as cnt FROM deposits WHERE user_id = ? AND status = 'pending'`, { bind: [userId] });
  const pendingDeposits = pendingCount.length ? pendingCount[0].values[0][0] : 0;

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
}

// --- API Routes ---

// POST /api/register
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, walletAddress } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Check if user exists
    const existing = db.exec(`SELECT id FROM users WHERE email = ?`, { bind: [email] });
    if (existing.length && existing[0].values.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    db.run(`INSERT INTO users (email, password, wallet_address, mining_speed) VALUES (?, ?, ?, ?)`, {
      bind: [email, hashedPassword, walletAddress || '', BASE_SPEED]
    });
    saveDB();

    const userId = db.exec(`SELECT last_insert_rowid() as id`);
    const id = userId[0].values[0][0];

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

    const result = db.exec(`SELECT * FROM users WHERE email = ?`, { bind: [email] });
    if (!result.length || !result[0].values.length) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const cols = result[0].columns;
    const vals = result[0].values[0];
    const user = {};
    cols.forEach((c, i) => user[c] = vals[i]);

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
app.get('/api/user', authMiddleware, (req, res) => {
  const user = getUserData(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

// GET /api/deposit/address - Get deposit instructions with reference code
app.get('/api/deposit/address', authMiddleware, (req, res) => {
  try {
    const user = getUserData(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Generate a fresh reference for display
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

// POST /api/deposit - Create a deposit request
app.post('/api/deposit', authMiddleware, (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1.00) {
      return res.status(400).json({ error: 'Minimum deposit is 1.00 USDT' });
    }

    // Generate a unique reference code for this deposit
    const referenceCode = generateReferenceCode(req.userId);

    db.run(`INSERT INTO deposits (user_id, amount, reference_code, deposit_address, status) VALUES (?, ?, ?, ?, 'pending')`, {
      bind: [req.userId, amount, referenceCode, MASTER_WALLET_ADDRESS]
    });
    saveDB();

    const depositId = db.exec(`SELECT last_insert_rowid() as id`);
    const id = depositId[0].values[0][0];

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

// GET /api/deposit/check - Poll for deposit status updates (called by frontend)
app.get('/api/deposit/check', authMiddleware, (req, res) => {
  try {
    // Get the most recent pending deposit for this user
    const result = db.exec(
      `SELECT id, amount, reference_code, deposit_address, status, checked_count, created_at
       FROM deposits
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      { bind: [req.userId] }
    );

    if (!result.length || !result[0].values.length) {
      return res.json({ hasDeposit: false });
    }

    const cols = result[0].columns;
    const vals = result[0].values[0];
    const deposit = {};
    cols.forEach((c, i) => deposit[c] = vals[i]);

    // Get all deposits for this user
    const allResult = db.exec(
      `SELECT id, amount, reference_code, status, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
      { bind: [req.userId] }
    );

    const allDeposits = [];
    if (allResult.length) {
      const aCols = allResult[0].columns;
      allResult[0].values.forEach(row => {
        const obj = {};
        aCols.forEach((c, i) => obj[c] = row[i]);
        allDeposits.push(obj);
      });
    }

    res.json({
      hasDeposit: true,
      deposit: {
        id: deposit.id,
        amount: deposit.amount,
        referenceCode: deposit.reference_code,
        depositAddress: deposit.deposit_address,
        status: deposit.status,
        checkedCount: deposit.checked_count,
        createdAt: deposit.created_at
      },
      allDeposits
    });
  } catch (err) {
    console.error('Deposit check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/deposits
app.get('/api/deposits', authMiddleware, (req, res) => {
  const result = db.exec(
    `SELECT id, amount, txid, status, reference_code, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    { bind: [req.userId] }
  );

  const deposits = [];
  if (result.length) {
    const cols = result[0].columns;
    result[0].values.forEach(row => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      deposits.push(obj);
    });
  }

  res.json(deposits);
});

// POST /api/withdraw
app.post('/api/withdraw', authMiddleware, (req, res) => {
  try {
    const { amount, walletAddress } = req.body;
    console.log('Withdraw request:', { amount, walletAddress });

    if (!amount || amount < 3.00) {
      return res.status(400).json({ error: 'Minimum withdrawal is 3.00 USDT' });
    }

    if (!walletAddress) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    // Calculate KLYN needed
    const amountUsdt = parseFloat(amount);
    const amountKlyn = amountUsdt / KLYN_TO_USDT_RATE;

    const user = getUserData(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    console.log('User balance KLYN:', user.balanceKlyn, 'Needed:', amountKlyn);

    if (user.balanceKlyn < amountKlyn) {
      return res.status(400).json({
        error: `Insufficient KLYN balance. You need ${amountKlyn.toFixed(4)} KLYN but have ${user.balanceKlyn.toFixed(4)} KLYN`
      });
    }

    db.run(`UPDATE users SET balance_klyn = balance_klyn - ? WHERE id = ?`, {
      bind: [amountKlyn, req.userId]
    });

    db.run(`INSERT INTO withdrawals (user_id, amount_klyn, amount_usdt, wallet_address, status) VALUES (?, ?, ?, ?, 'pending')`, {
      bind: [req.userId, amountKlyn, amountUsdt, walletAddress]
    });
    saveDB();

    res.json({ message: `Withdrawal of ${amountUsdt.toFixed(2)} USDT (${amountKlyn.toFixed(4)} KLYN) submitted` });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/withdrawals
app.get('/api/withdrawals', authMiddleware, (req, res) => {
  const result = db.exec(
    `SELECT id, amount_klyn, amount_usdt, wallet_address, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    { bind: [req.userId] }
  );

  const withdrawals = [];
  if (result.length) {
    const cols = result[0].columns;
    result[0].values.forEach(row => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      withdrawals.push(obj);
    });
  }

  res.json(withdrawals);
});

// GET /api/mining/status
app.get('/api/mining/status', authMiddleware, (req, res) => {
  const user = getUserData(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    balanceKlyn: user.balanceKlyn,
    balanceUsdt: user.balanceUsdt,
    miningSpeed: user.miningSpeed,
    minedUnclaimed: user.minedUnclaimed,
    totalDeposited: user.totalDeposited
  });
});

// POST /api/mining/claim
app.post('/api/mining/claim', authMiddleware, (req, res) => {
  try {
    const user = getUserData(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.minedUnclaimed <= 0) {
      return res.status(400).json({ error: 'Nothing to claim' });
    }

    const amount = user.minedUnclaimed;
    db.run(`UPDATE users SET balance_klyn = balance_klyn + ?, mined_unclaimed = 0 WHERE id = ?`, {
      bind: [amount, req.userId]
    });
    saveDB();

    res.json({ message: `Claimed ${amount.toFixed(8)} KLYN`, amount });
  } catch (err) {
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/deposit/verify (admin/simulation endpoint - kept for backward compat)
app.post('/api/deposit/verify', authMiddleware, (req, res) => {
  try {
    const { depositId } = req.body;
    if (!depositId) return res.status(400).json({ error: 'Deposit ID required' });

    // Get the deposit
    const depResult = db.exec(`SELECT * FROM deposits WHERE id = ?`, { bind: [depositId] });
    if (!depResult.length || !depResult[0].values.length) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    const depCols = depResult[0].columns;
    const depVals = depResult[0].values[0];
    const deposit = {};
    depCols.forEach((c, i) => deposit[c] = depVals[i]);

    if (deposit.status !== 'pending') {
      return res.status(400).json({ error: 'Deposit already processed' });
    }

    const newSpeed = deposit.amount * SPEED_PER_USDT;

    // Update deposit status
    db.run(`UPDATE deposits SET status = 'confirmed' WHERE id = ?`, { bind: [depositId] });

    // Update user
    db.run(`
      UPDATE users SET
        balance_usdt = balance_usdt + ?,
        total_deposited = total_deposited + ?,
        mining_speed = mining_speed + ?
      WHERE id = ?
    `, {
      bind: [deposit.amount, deposit.amount, newSpeed, deposit.user_id]
    });
    saveDB();

    res.json({
      message: `Deposit of ${deposit.amount} USDT confirmed. Mining speed boosted!`,
      speedIncrease: newSpeed
    });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/config - Expose public config to frontend
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

// GET /api/health - Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    bscscanConfigured: !!(BSCSCAN_API_KEY && MASTER_WALLET_ADDRESS !== '0x'.padEnd(42, '0')),
    pendingDeposits: db.exec(`SELECT COUNT(*) as cnt FROM deposits WHERE status = 'pending'`)[0].values[0][0] || 0,
    totalUsers: db.exec(`SELECT COUNT(*) as cnt FROM users`)[0].values[0][0] || 0
  });
});

// --- Frontend catch-all ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ---
async function start() {
  await initDB();

  // Create default test user if not exists
  const existing = db.exec(`SELECT id FROM users WHERE email = 'test@klyncoin.com'`);
  if (!existing.length || !existing[0].values.length) {
    const pw = await bcrypt.hash('password123', SALT_ROUNDS);
    db.run(`INSERT OR IGNORE INTO users (email, password, mining_speed) VALUES (?, ?, ?)`, {
      bind: ['test@klyncoin.com', pw, BASE_SPEED]
    });
    saveDB();
    console.log('Test user created: test@klyncoin.com / password123');
  }

  // Start background deposit checker
  const bscMode = !!(BSCSCAN_API_KEY && MASTER_WALLET_ADDRESS !== '0x'.padEnd(42, '0'));
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║     🪙 KLYNCoin Server v2.0            ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  Deposit mode: ${bscMode ? 'BSCScan Auto ✅' : 'Manual / Reference 📝'}      ║`);
  if (bscMode) {
    console.log(`║  Master wallet: ${MASTER_WALLET_ADDRESS.substring(0, 10)}...  ║`);
  }
  console.log(`║  Check interval: ${CHECK_INTERVAL_MS / 1000}s                  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Run deposit checker every CHECK_INTERVAL_MS
  setInterval(processPendingDeposits, CHECK_INTERVAL_MS);
  // Also run once at startup after a short delay
  setTimeout(processPendingDeposits, 5000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KLYNCoin server running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});