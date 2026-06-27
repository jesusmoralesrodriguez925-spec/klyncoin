# KLYNCoin — Render Deployment Guide

## Prerequisites

A push to GitHub is done at:
- **Repo**: https://github.com/jesusmoralesrodriguez925-spec/klyncoin

## Deploy Steps (Render Dashboard)

1. Go to https://render.com and log in
2. Click **New +** → **Web Service**
3. Connect your GitHub account and select `jesusmoralesrodriguez925-spec/klyncoin`
4. Configure:

| Setting | Value |
|---------|-------|
| **Name** | `klyncoin` |
| **Runtime** | `Node` |
| **Branch** | `main` |
| **Build Command** | `npm install` |
| **Start Command** | `node server.js` |
| **Plan** | Free |

5. Add these **Environment Variables**:

```
JWT_SECRET=<generate-a-random-secret>
MASTER_WALLET_ADDRESS=<your-bsc-wallet-address>
BSCSCAN_API_KEY=<your-bscscan-api-key>
```

6. Click **Create Web Service**

Your URL will be: `https://klyncoin.onrender.com`

## ⚠️ Important Notes

### SQLite on Render (Ephemeral Filesystem)
Render's free tier has an **ephemeral filesystem** — any data written to disk (like our `database.sqlite`) is **lost every time the service restarts** (deploys, sleeps, crashes).

- The test account `test@klyncoin.com` / `password123` will be auto-created on each fresh start
- For production, consider migrating to a persistent database (PostgreSQL via Render's managed DB or Supabase)

### What was checked before deploy
- ✅ **Port**: `server.js` already uses `process.env.PORT || 3456`
- ✅ **No hardcoded URLs**: Frontend uses relative paths (`/api/...`)
- ✅ **Dependencies**: `npm install` will pull everything from `package.json`
- ✅ **Root route**: Express serves `public/index.html` for all routes

## First-Time Test After Deploy

```bash
# Health check
curl https://klyncoin.onrender.com/api/health

# Login with test account
curl -X POST https://klyncoin.onrender.com/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@klyncoin.com","password":"password123"}'
```