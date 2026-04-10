# 🤖 Solana LP Agent

An autonomous concentrated liquidity agent for **SOL-USDC** and **HYPE-USDC** pools on **Meteora DLMM**, controllable via Telegram.

---

## Architecture

```
src/
├── index.js           ← Main agent orchestrator + loop
├── logger.js          ← Winston structured logging
├── price-monitor.js   ← Jupiter + Birdeye price feeds
├── strategy-engine.js ← Range calculation + APR simulation
├── lp-manager.js      ← Meteora DLMM position management
├── rebalance-engine.js← Rebalance logic + fakeout protection
├── risk-manager.js    ← Capital protection + volatility guards
├── compound-engine.js ← Fee reinvestment allocation
├── state-manager.js   ← Persistent state (JSON)
└── telegram-bot.js    ← Bot commands + alerts
```

---

## VPS Setup (Ubuntu 22.04)

### 1. System Requirements

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (process manager)
sudo npm install -g pm2

# Install build tools (needed for native Solana deps)
sudo apt install -y build-essential python3
```

### 2. Clone and Install

```bash
# Clone the repo
git clone https://github.com/yourname/solana-lp-agent.git
cd solana-lp-agent

# Install dependencies
npm install
```

### 3. Configure Environment

```bash
# Copy and edit the env file
cp .env.example .env
nano .env
```

Fill in:
- `WALLET_PRIVATE_KEY` — your Solana wallet private key (base58)
- `SOLANA_RPC_URL` — Helius/QuickNode RPC endpoint
- `SOL_USDC_POOL` — Meteora DLMM SOL-USDC pool address
- `HYPE_USDC_POOL` — Meteora DLMM HYPE-USDC pool address
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHAT_ID` — your Telegram chat ID
- `MAX_CAPITAL_SOL_USDC` — max USD to deploy in SOL-USDC
- `MAX_CAPITAL_HYPE_USDC` — max USD to deploy in HYPE-USDC

### 4. Create Required Directories

```bash
mkdir -p logs data
```

### 5. Start with PM2

```bash
# Start agent
npm run pm2

# Check status
pm2 status

# View logs
pm2 logs lp-agent

# Enable auto-restart on reboot
pm2 startup
pm2 save
```

---

## Telegram Bot Setup

1. **Create bot**: Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. **Get your Chat ID**: Message [@userinfobot](https://t.me/userinfobot) → copy the ID
3. **Add to .env**:
   ```
   TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
   TELEGRAM_CHAT_ID=987654321
   TELEGRAM_ALLOWED_USERS=987654321
   ```

### Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Initialize and check agent |
| `/status` | Live dashboard: prices, positions, earnings |
| `/positions` | Detailed LP breakdown with ranges |
| `/apr` | Estimated APR per pool |
| `/strategy [pool] [mode]` | Switch strategy (2-position / 3-position) |
| `/rebalance [pool?]` | Force rebalance |
| `/compound [mode?]` | Set compound mode or trigger now |
| `/risk` | Risk manager status |
| `/stop` | Stop agent (positions stay open) |
| `/help` | Command reference |

---

## Strategy Configuration

### 2-Position Mode (Default)

```
Capital: $10,000
  ├─ Core (40%): ±2.5% from price   → safety net
  └─ Sniper (60%): ±0.35% from price → high fee density
```

### 3-Position Mode

```
Capital: $10,000
  ├─ Core (25%):   ±3.0% → wide safety net
  ├─ Inner (35%):  ±1.2% → main fee zone
  └─ Sniper (40%): ±0.35% → ultra-tight fee density
```

Switch via: `/strategy SOL-USDC 3-position`

---

## Advanced Features

### Liquidity Gravity Well
The strategy engine analyzes recent price history to find the most frequently visited price levels. The sniper position is centered on this "gravity well" rather than just current price, improving fee capture.

### Sniper Repositioning
When price exits the sniper range OR drifts >50% from sniper center, the sniper is repositioned without triggering a full core rebalance. This reduces $5 position costs.

### Fakeout Protection
Rebalances are only executed after a signal has persisted for `FAKEOUT_DELAY_MS` (default 10 min). If price returns to center before that, the signal is cancelled.

### APR Simulation
Before opening any position, the agent simulates expected APR based on:
- Pool fee tier
- Estimated daily volume
- Liquidity concentration multiplier
- Position creation cost ($5 minimum fee)

If APR is too low to justify costs, the position is skipped.

---

## Compounding Modes

| Mode | Reinvest | USDC Reserve | Realized Profit |
|------|----------|-------------|-----------------|
| balanced | 50% | 30% | 20% |
| aggressive | 100% | 0% | 0% |
| conservative | 30% | 50% | 20% |

Set via: `/compound aggressive` or edit `COMPOUND_MODE` in .env

---

## Security Notes

- 🔒 Private key is **only** in `.env` — never committed to git
- 🛡️ `.gitignore` excludes `.env`, `logs/`, `data/`
- 🤝 Telegram whitelist via `TELEGRAM_ALLOWED_USERS`
- ⚠️ Use a **dedicated wallet** with only the capital you intend to LP
- 💰 Keep SOL in wallet for transaction fees (0.01–0.05 SOL per tx)

---

## Finding Pool Addresses

1. Go to [app.meteora.ag](https://app.meteora.ag)
2. Search for "SOL-USDC" or "HYPE-USDC" in the DLMM section
3. Click the pool → copy the pool address from the URL or pool info
4. Paste into `.env`

---

## Troubleshooting

**"Meteora DLMM SDK not available"**
→ Running in simulation mode. Install `@meteora-ag/dlmm`:
```bash
npm install @meteora-ag/dlmm
```

**"WALLET_PRIVATE_KEY not set"**
→ Ensure `.env` file exists and is properly filled

**"Failed to fetch price"**
→ Check `SOLANA_RPC_URL` and `BIRDEYE_API_KEY`

**Telegram bot not responding**
→ Verify `TELEGRAM_BOT_TOKEN` is correct and bot is started

---

## Logs

```bash
# Real-time
tail -f logs/agent-$(date +%Y-%m-%d).log

# Errors only
tail -f logs/error-$(date +%Y-%m-%d).log

# Via PM2
pm2 logs lp-agent --lines 100
```
