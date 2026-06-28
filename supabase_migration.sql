-- KLYNCoin Supabase Migration
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- Or use: psql -h db.gmhiblcjxwqdurltwzrv.supabase.co -U postgres -d postgres -f supabase_migration.sql

-- ================================================================
-- USERS TABLE
-- ================================================================
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
);

-- ================================================================
-- DEPOSITS TABLE
-- ================================================================
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
);

-- ================================================================
-- WITHDRAWALS TABLE
-- ================================================================
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_klyn REAL NOT NULL,
  amount_usdt REAL NOT NULL,
  wallet_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

-- ================================================================
-- SEED DATA: Test User
-- ================================================================
-- Email: test@klyncoin.com
-- Password: password123 (bcrypt hash below)
-- Balance: 10 USDT, 100 KLYN, Mining speed: 0.0006 KLYN/s
INSERT INTO users (email, password, wallet_address, balance_usdt, balance_klyn, mining_speed, mined_unclaimed, total_deposited)
VALUES (
  'test@klyncoin.com',
  '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy',
  '0xTestWallet',
  10,
  100,
  0.0006,
  5,
  10
)
ON CONFLICT (email) DO NOTHING;

-- ================================================================
-- INDEXES (for performance)
-- ================================================================
CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ================================================================
-- VERIFICATION
-- ================================================================
SELECT 'Migration complete!' AS status;
SELECT COUNT(*) AS user_count FROM users;
SELECT COUNT(*) AS deposit_count FROM deposits;
SELECT COUNT(*) AS withdrawal_count FROM withdrawals;