# OpenSea Automated NFT Trading Bot ($10 Capital & Multi-Chain)

A production-grade, secure, and event-driven NFT trading bot designed to trade on **Robinhood Chain** and **Ethereum Mainnet** using the Seaport protocol, strictly enforcing **$10 Capital Allocation** and **Capital Preservation & Profitability Rules**.

---

## 1. Supported Networks

| Parameter | Robinhood Chain | Ethereum Mainnet |
| :--- | :--- | :--- |
| **Network Name** | Robinhood Chain | Ethereum Mainnet |
| **Chain ID** | `4663` | `1` |
| **RPC URL** | `https://rpc.mainnet.chain.robinhood.com` (public, rate-limited; override with `ROBINHOOD_RPC_URL`) | `https://ethereum-rpc.publicnode.com` (override with `ETHEREUM_RPC_URL`) |
| **Currency** | `ETH` | `ETH` |
| **Block Explorer** | [Robinhood Explorer](https://robinhoodchain.blockscout.com) | [Etherscan](https://etherscan.io) |
| **Estimated Gas** | ~$0.01 (Micro-fee friendly) | ~$3.50+ (Gas check protects capital) |

Select networks with `ACTIVE_NETWORKS=robinhood` or `ACTIVE_NETWORKS=robinhood,mainnet` in `.env`.

**RPC keys:** never put provider API keys in `config/default.json`. Set private RPC URLs (e.g. `https://robinhood-mainnet.g.alchemy.com/v2/<YOUR_KEY>`) only via `ROBINHOOD_RPC_URL` / `ETHEREUM_RPC_URL` in your untracked `.env`.

---

## 2. Capital Allocation & Profitability Rules

### Rule 1: Total Trading Capital ($10 Limit)
* The bot has a maximum trading capital of **$10**.
* Capital cannot be allocated to multiple active positions simultaneously.
* **Rule**: «One active trade at a time when the available capital is fully allocated.»

### Rule 2: Offer Price vs. Floor Price
* The bot **never** places an offer simply because `floor > offer`.
* The bot calculates the realistic net resale value after all applicable costs:
  * **Bad Trade Example**:
    * Offer: $10, Floor: $11, Creator Royalty: 10%
    * Resale at $11 − 10% royalty = $9.90
    * Net profit = $9.90 − $10.00 = **−$0.10** (Loss before gas or marketplace fees!)
    * Decision: **REJECT TRADE ❌**
  * **Profitable Trade Example**:
    * Offer: $10, Realistic Sale: $15, Royalty: 5% ($0.75), Fees (0.5%): $0.08, Gas: $0.01
    * Net Profit = $15 − $0.75 − $0.08 − $10 − $0.01 = **+$4.16**
    * Decision: **ACCEPT TRADE ✅**

### Rule 3: Minimum Profitability Requirement (`MIN_NET_PROFIT = $2`)
Before placing an offer:
$$\text{Expected Net Profit} = \text{Realistic Net Resale Proceeds} - \text{Total Acquisition Cost} - \text{Fees} - \text{Network Gas}$$
* If $\text{Net Profit} \le 0$ $\rightarrow$ **DO NOT BID ❌**
* If $\text{Net Profit} < \text{MIN\_NET\_PROFIT}$ $\rightarrow$ **DO NOT BID ❌**
* If $\text{Net Profit} \ge \text{MIN\_NET\_PROFIT}$ $\rightarrow$ **BID MAY BE PLACED ✅**

### Rule 4: Floor Price $\neq$ Guaranteed Sale Price
The bot discounts the floor price (undercut percentage) to account for liquidity and ensure quick execution.

### Rule 5: Dual Check (Check A & Check B)
Before every offer, both checks must pass:
1. **Check A (Capital)**: Is sufficient capital available within the $10 limit and complying with the 70% capital allocation limit (active offers + purchased NFTs; 30% always reserved)?
2. **Check B (Profitability)**: Is expected net profit $\ge \$0.20$ after royalties, marketplace fees, and network gas?

Only when **BOTH** pass is an offer placed.

### Rule 6: NFT Re-Bidding & Simultaneous Offers Rule
1. **Same NFT Re-Bidding Restriction**: Once an offer is accepted and the bot acquires an NFT, the bot must not place another offer on that same NFT while it is owned or while the previous trade remains unresolved.
2. **No Re-Bidding Before Sale**: The bot must never place another offer on the same NFT before the previously acquired NFT has been sold and the sale has been confirmed.
3. **Simultaneous Offers on Different NFTs**: The bot may place offers on multiple different NFT items simultaneously, even while an earlier NFT purchase is awaiting resale. Every new offer must independently pass all required criteria and comply with the 70% capital allocation limit (30% reserved).
4. **Independent NFT Tracking**: The bot tracks each NFT separately, including its token ID, collection, active offers, ownership status, listing status, and sale confirmation.
* **Core Rule**: Never place another offer on the same NFT before its previous position is sold. After confirmed sale, re-bidding is allowed only if all criteria pass again. Offers on different eligible NFTs may run simultaneously within the capital limit.

### Rule 7: Failed Mint & Market Dump Protection Rules

#### Condition 1: Incomplete Public Mint — Strict Rejection
The bot must never place an offer on an NFT collection whose public mint has not completed successfully.
* **Pre-Offer Verifications**:
  * The public mint has ended or the collection has demonstrably completed its intended mint phase.
  * The project has achieved its intended mint completion status.
  * The collection is not still struggling to sell its available mint supply.
  * Actual secondary-market demand exists.
* **Mandatory Rejection Conditions**:
  * Public mint is still active and the intended mint supply remains significantly incomplete.
  * The project has failed to attract sufficient mint demand.
  * The collection has low or unreliable secondary-market liquidity.
  * A collection is never considered safe merely because some buyers purchase at floor.
* **Strict Rule**: If the public mint is incomplete and the collection fails required mint-demand checks, **DO NOT PLACE AN OFFER ❌**.

#### Condition 2: Market Dump Protection
The bot evaluates the collection's floor-price decline before placing an offer using recent pre-decline market reference price:
$$\text{Floor Decline \%} = \left(\frac{\text{Reference Floor} - \text{Current Floor}}{\text{Reference Floor}}\right) \times 100$$
* **$\le 30\%$ Floor Decline**: Eligible for consideration **only** if all existing liquidity, sales volume, wallet diversity, and profitability requirements pass (no automatic approval).
* **$\ge 40\%$ Floor Decline**: **Automatically reject** the collection and do not place an offer.
* **Extreme Decline / $\approx 99\%$ Collapse ($\ge 90\%$)**: **Permanently exclude** the collection from new offers unless explicitly reviewed and re-enabled by the user (`reEnableCollection`).

#### Final Mandatory Rule
* **NEVER BID** on an incompletely minted collection that fails its mint-demand requirements.
* **NEVER BID** on a collection whose floor has declined by 40% or more from its valid reference price.
* Only collections that pass both protections and every existing liquidity, native ETH sales, profitability, and capital-allocation requirement may receive an offer.

---

## 3. Required Trading Logic Flow

```
SCAN NFT
   ↓
Check Available Capital (Check A)
   ↓
Is capital available (<= $10, no active trade)?
   ↓ YES
Calculate Expected Resale Value (Liquidity discounted)
   ↓
Calculate Creator Royalty (e.g. 5% - 10%)
   ↓
Calculate Marketplace Fees (OpenSea 0.5% - 2.5%)
   ↓
Estimate Network Gas (Robinhood ~$0.01 vs ETH ~$3.50)
   ↓
Calculate Expected Net Profit
   ↓
Is Net Profit ≥ MIN_NET_PROFIT ($2.00)? (Check B)
   ↓ YES
PLACE OFFER (Off-chain Seaport EIP-712)
   ↓
Offer Accepted?
   ↓ YES
Acquire NFT
   ↓
List NFT for Sale
   ↓
NFT Sold
   ↓
Capital Released & Actual Profit Banked
   ↓
Start Next Trade
```

---

## 4. Quick Start & Execution

### 1. Installation
```bash
npm install
```

### 2. Environment Setup
```bash
cp .env.example .env
```
Edit `.env` to select network:
```env
ACTIVE_NETWORKS=robinhood
ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com   # or your private provider URL (keep it in .env only)
ETHEREUM_RPC_URL=https://ethereum-rpc.publicnode.com
OPENSEA_API_KEY=your_opensea_api_key_here
INVENTORY_STATE_PATH=./data/inventory-state.json            # persisted owned-NFT / pause state
BOT_MODE=SIMULATION # Or LIVE
PRIVATE_KEY=your_private_key_here
```

### 3. Run Unit Tests (Mathematical & Capital Rules)
```bash
npm run test
```
Validates:
* Example 5: Bad Trade rejection
* Example 6: Profitable Trade acceptance
* Profit Safety Margin ($0.20 rejection against $2 target)
* Capital Constraint Check A ($12 offer rejection)
* Single Active Trade lifecycle in InventoryManager
* Gas difference between Robinhood Chain and Ethereum Mainnet

### 4. Run Dry-Run Simulation
```bash
npm run dry-run
```
Simulates full end-to-end lifecycle: scan $\rightarrow$ offer $\rightarrow$ capital lock $\rightarrow$ relist $\rightarrow$ sale $\rightarrow$ capital release.

### 5. Start Bot
```bash
npm run start
```

## Profitability & Auto-Listing Rules (A-E)

- **40% net margin**: every offer must yield net profit >= 40% of the offer price at the expected floor sale, after marketplace fee, the applicable (non-disableable) creator fee and gas. `profitTargets.defaultMinMarginPercent` / per-target `minMarginPercent` can only make this stricter (values below 40 are raised to 40).
- **Minimum acceptable floor**: `minFloor = (offer * 1.40 + gas) / ((1 - undercut) * (1 - marketplaceFee - creatorFee))`; offers require `floor >= minFloor` **and** `floor >= offer * 1.30` (the 1.30x rule is kept; the 40% rule is always stricter, so they never conflict).
- **Creator fee**: optional creator fees are excluded from signed offers and listings and verified absent before posting; mandatory creator fees are counted in net profit.
- **Final validation**: right before every offer (incl. re-offers and single-token offers) fresh market data is re-fetched and mint-out, recent sales, dump protection, creator-fee status and profitability are re-checked at the exact bid.
- **Auto-listing**: bought NFTs are listed at the lowest competitive price that still keeps the 40% margin; listed NFTs are monitored each cycle and repriced just under a cheaper competing listing when still profitable (previous listing cancelled off-chain). If matching is unprofitable the existing listing is kept (never below the 40%-margin price). Reprices are rate-limited by `general.relistCooldownMinutes` (default 10) and a 0.2% minimum price change.

## OpenSea Rate Limiting & Caching

All OpenSea API calls go through one process-wide limiter (`src/utils/OpenSeaRateLimiter.ts`) and always send the `x-api-key` header (`OPENSEA_API_KEY`). Optional config block (defaults shown):

```json
"opensea": {
  "requestsPerSecond": 3, "maxConcurrent": 2,
  "maxRetries": 4, "baseRetryDelayMs": 1000, "maxRetryDelayMs": 30000,
  "cacheTtlMs": { "collection": 600000, "stats": 60000, "offers": 20000, "salesEvents": 120000, "mintComplete": 21600000, "mintIncomplete": 120000 }
}
```

- 429 / 5xx / network errors are retried with exponential backoff + jitter, honouring `Retry-After` (a 429 pauses the shared limiter for every caller). 4xx errors such as 404 are not retried.
- Per-collection data is cached; only successful results are cached. Verified fully-minted results are cached for 6h.
- Collections are evaluated sequentially in stages: fees, then mint-out, then the creator-fee ceiling, then floor stats, then offers, and only then the paginated sales events. Cheap rejections never trigger the sales fetch.
- If data still can't be fetched, the collection is logged as `SKIPPED (data unavailable, will retry)` and no offer is placed.
- Strategy cycles never overlap. If a cycle runs longer than `loopIntervalMs`, the next tick is skipped.
