# KLYNCoin Deployment Guide

## Quick Start (Development)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your BSCScan API key and master wallet address

# 3. Start the server
npm start
```

The server runs on `http://localhost:3456` by default.

## Test Account
- Email: `test@klyncoin.com`
- Password: `password123`

---

## 🔗 Permanent Deployment Options

### Option A: Cloudflare Tunnel (Recommended — Free & Permanent)

1. **Install cloudflared**:
   ```bash
   # Linux (x86_64)
   wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
   chmod +x /usr/local/bin/cloudflared
   
   # macOS
   brew install cloudflare/cloudflare/cloudflared
   
   # Windows (via winget)
   winget install cloudflare.cloudflared
   ```

2. **Authenticate with Cloudflare**:
   ```bash
   cloudflared tunnel login
   ```
   This opens a browser. Log in to your Cloudflare account and authorize.

3. **Create a tunnel**:
   ```bash
   cloudflared tunnel create klyncoin
   ```
   This creates a tunnel UUID and credentials file at `~/.cloudflared/`.

4. **Configure the tunnel**:
   Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: YOUR-TUNNEL-UUID
   credentials-file: /root/.cloudflared/YOUR-TUNNEL-UUID.json
   
   ingress:
     - hostname: klyncoin.yourdomain.com
       service: http://localhost:3456
     - service: http_status:404
   ```

5. **Add DNS record** (via Cloudflare Dashboard or CLI):
   ```bash
   cloudflared tunnel route dns klyncoin klyncoin.yourdomain.com
   ```

6. **Run the tunnel**:
   ```bash
   cloudflared tunnel run klyncoin
   ```
   
   For persistent operation, set up as a systemd service:
   ```bash
   cloudflared service install
   ```

### Option B: Render (Free Tier)

1. Push the code to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set:
   - **Name**: `klyncoin`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan**: Free
5. Add Environment Variables (see `.env.example`)
6. Deploy! Your URL will be `https://klyncoin.onrender.com`

### Option C: Railway (Free Tier)

1. Push to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Connect repo
4. Add environment variables from `.env.example`
5. Deploy — Railway auto-detects Node.js

### Option D: Fly.io (Free Tier)

```bash
# Install flyctl
curl -fsSL https://fly.io/install.sh | sh

# Create fly.toml
fly launch

# Deploy
fly deploy

# Set env vars
fly secrets set BSCSCAN_API_KEY=your_key MASTER_WALLET_ADDRESS=your_address
```

---

## 💰 Setting Up Real BSCScan Auto-Detection

1. **Get a BSCScan API Key**:
   - Go to https://bscscan.com/register and create an account
   - Go to https://bscscan.com/myapikey and create a free API key
   - Free tier: 5 calls/sec, 100K calls/day — enough for 60s polling

2. **Create a Master BSC Wallet**:
   - Use MetaMask or similar to create a new BSC wallet
   - Fund it with ~0.01 BNB for gas (for forwarding if needed)
   - Set `MASTER_WALLET_ADDRESS` in `.env` to this address
   - Users will send USDT BEP20 to this address

3. **How it works**:
   - Every 60 seconds, the system queries BSCScan for USDT token transfers
   - When a transfer to the master wallet matches a pending deposit, it auto-verifies
   - Matching is by amount (within 0.5 USDT tolerance)
   - Users should include their reference code in the transaction memo/note

---

## 📝 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3456` | Server port |
| `JWT_SECRET` | No | `klyncoin-secret-key-2024` | JWT signing secret |
| `BSCSCAN_API_KEY` | No | — | BSCScan API key for auto-detection |
| `MASTER_WALLET_ADDRESS` | No | `0x00...0000` | BSC wallet for USDT deposits |
| `CHECK_INTERVAL` | No | `60000` | Background checker interval (ms) |
| `FRONTEND_POLL` | No | `10000` | Frontend poll interval (ms) |

---

## 💡 Architecture

```
User → Frontend (HTML/CSS/JS) → Express API → SQLite DB
                                         ↓
User sends USDT BEP20 → Master Wallet → BSCScan API → Auto-verify
                                         ↓
                              Background Checker (60s)
```

- Mining simulation: `BASE_SPEED = 0.0001 KLYN/s`, boosts `+0.00005 KLYN/s per USDT`
- Reference codes: `KLYN-{userId}-{timestamp}-{random}` for each deposit
- Two deposit modes: BSCScan auto (if API key set) or manual/verify