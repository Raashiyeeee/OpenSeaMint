# OpenSea NFT Trading Bot

An automated trading bot for OpenSea that monitors collection floors, submits Seaport v1.6 offers, and automatically relists purchased NFTs for profit. Built with TypeScript and ethers.js, with multi-wallet support on Robinhood Chain, Ink, and Ethereum.

---

## What It Does

- **Automated Bidding**: Scans collections, checks recent sales volume/liquidity, and places top offers below the floor using Seaport.
- **Profit Checks Before Bidding**: Automatically calculates marketplace fees (OpenSea + creator royalties + gas) to ensure an offer actually yields profit upon resale.
- **Instant Relisting**: Once an offer is accepted, the bot detects the purchase and immediately creates a floor listing.
- **Multi-Wallet Support**: Can run two or more wallets concurrently in a single process without them bidding against each other (Queue Stacking).
- **Auto WETH Wrap**: Automatically wraps native ETH back into WETH after sales to keep offer balances funded.
- **Safety Filters**: Includes rate-limiting retries (OpenSea 429 backoff), circuit breakers for sudden floor crashes, and wash-trading / same-buyer filters.

---

## Supported Networks

| Network | Chain ID | Default RPC | Gas Range |
| :--- | :--- | :--- | :--- |
| **Robinhood Chain** | `4663` | `https://rpc.mainnet.chain.robinhood.com` | < $0.01 |
| **Ink Mainnet** | `57073` | `https://rpc-gel.inkonchain.com` | < $0.01 |
| **Ethereum Mainnet** | `1` | `https://ethereum-rpc.publicnode.com` | Network dependent |

> **Tip:** Public RPCs can be slow or rate-limited. For live runs, plug in private RPC URLs (Alchemy, Infura, etc.) in your `.env`.

---

## Quick Start

### 1. Requirements
- Node.js 18+
- npm or yarn
- OpenSea API key (from OpenSea Developer Portal)

### 2. Installation
```bash
git clone https://github.com/Raashiyeeee/OpenSeaMint.git
cd OpenSeaMint
npm install
```

### 3. Environment Setup
Copy the sample env file:
```bash
cp .env.example .env
```

Open `.env` and fill in your keys:
```env
# Mode: SIMULATION (safe, no real funds used) or LIVE
BOT_MODE=SIMULATION

# Networks to monitor (comma-separated)
ACTIVE_NETWORKS=robinhood,ink

# Your OpenSea API key
OPENSEA_API_KEY=your_key_here

# Single Wallet
PRIVATE_KEY=0xyour_private_key_here

# Or Multi-Wallet (optional)
# PRIVATE_KEY_1=0x...
# CAPITAL_USD_1=25.0
# PRIVATE_KEY_2=0x...
# CAPITAL_USD_2=25.0
```

> **Security Reminder:** Never commit your `.env` file or paste private keys into `config/default.json`. Keep `.env` in `.gitignore`.

---

## Running the Bot

### 1. Run Tests First
Before deploying or using real capital, run the built-in test suite to make sure all trading logic and calculations pass:
```bash
npm test
```

### 2. Dry Run / Simulation Mode
Keep `BOT_MODE=SIMULATION` in your `.env`. The bot will fetch live market data, calculate bids, and simulate fills and listings without signing any on-chain transactions:
```bash
npm run dev
# or
npx ts-node src/index.ts
```

### 3. Prepare Your Wallet (Live Mode)
If you are ready for live trading, use the helper script to check balances, wrap ETH to WETH, and approve the OpenSea Seaport Conduit:
```bash
# Check and setup wallet for Robinhood Chain
npx ts-node scripts/prepareWallet.ts robinhood

# Or for Ink
npx ts-node scripts/prepareWallet.ts ink
```

### 4. Start in Production
Build the TypeScript code and run:
```bash
npm run build
npm start
```

---

## Configuration

Core trading settings live in `config/default.json`:

- `capital.totalTradingCapitalUsd`: Maximum capital allocated per wallet.
- `capital.maxBuyPriceUsd`: Ceiling price for any single NFT purchase.
- `liquidity.minSales3Hours`: Minimum number of sales required in the last 3 hours before considering a collection.
- `profitTargets.defaultMinMarginPercent`: Minimum profit margin required after all fees (default: 40%).
- `general.loopIntervalMs`: How often the scan loop runs (default: 15 seconds).

---

## Project Structure

```text
├── config/
│   └── default.json          # Trading parameters and chain config
├── scripts/
│   └── prepareWallet.ts      # ETH/WETH wrapping & Seaport approval helper
├── src/
│   ├── index.ts              # Entry point & worker orchestrator
│   ├── config/               # Config parser & schema validation
│   ├── security/             # Circuit breaker & key management
│   ├── services/             # Seaport, OpenSea API, & inventory trackers
│   ├── strategies/           # Bidder and relister logic
│   └── utils/                # Rate limiter & logging
├── tests/                    # Pricing, multi-wallet & rule tests
└── .env.example              # Template environment variables
```

---

## License

MIT. Use at your own risk. Always test in `SIMULATION` mode first to verify your strategy and parameters before trading with real funds.
