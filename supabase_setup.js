/**
 * KLYNCoin Supabase Setup Script
 *
 * Connects to Supabase PostgreSQL and creates all required tables.
 * Run this after setting up your Supabase project:
 *
 *   1. Copy .env.example to .env
 *   2. Set DATABASE_URL to your Supabase connection string
 *   3. Run: node supabase_setup.js
 *
 * Alternatively, paste supabase_migration.sql into the Supabase SQL Editor.
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  const client = await pool.connect();
  try {
    console.log('🔌 Connected to Supabase PostgreSQL\n');

    // ── Create Users Table ─────────────────────────────────────────
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
    console.log('✅  users table ready');

    // ── Create Deposits Table ──────────────────────────────────────
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
    console.log('✅  deposits table ready');

    // ── Create Withdrawals Table ───────────────────────────────────
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
    console.log('✅  withdrawals table ready');

    // ── Create Indexes ─────────────────────────────────────────────
    await client.query('CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
    console.log('✅  indexes created');

    // ── Seed Test User ────────────────────────────────────────────
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('password123', 10);

    const seedResult = await client.query(
      `INSERT INTO users (email, password, wallet_address, balance_usdt, balance_klyn, mining_speed, mined_unclaimed, total_deposited)
       VALUES ('test@klyncoin.com', $1, '0xTestWallet', 10, 100, 0.0006, 5, 10)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [hash]
    );

    if (seedResult.rows.length > 0) {
      console.log('✅  test user created: test@klyncoin.com / password123');
    } else {
      console.log('ℹ️   test user already exists, skipping');
    }

    // ── Summary ───────────────────────────────────────────────────
    const userCount = await client.query('SELECT COUNT(*)::int AS count FROM users');
    const depCount = await client.query('SELECT COUNT(*)::int AS count FROM deposits');
    const wdCount = await client.query('SELECT COUNT(*)::int AS count FROM withdrawals');

    console.log(`\n📊  Summary:`);
    console.log(`     Users:       ${userCount.rows[0].count}`);
    console.log(`     Deposits:    ${depCount.rows[0].count}`);
    console.log(`     Withdrawals: ${wdCount.rows[0].count}`);
    console.log(`\n🎉  Supabase setup complete!`);
  } finally {
    client.release();
    await pool.end();
  }
}

setup().catch(err => {
  console.error('❌  Setup failed:', err.message);
  process.exit(1);
});