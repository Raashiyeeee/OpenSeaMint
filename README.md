# OpenSea Automated NFT Trading Bot ($10 Capital & Multi-Chain)

A production-grade, secure, and event-driven NFT trading bot designed to trade on **Robinhood Chain** and **Ethereum Mainnet** using the Seaport protocol, strictly enforcing **$10 Capital Allocation** and **Capital Preservation & Profitability Rules**.

---

## 1. Supported Networks

| Parameter | Robinhood Chain | Ethereum Mainnet |
| :--- | :--- | :--- |
| **Network Name** | Robinhood Chain | Ethereum Mainnet |
| **Chain ID** | `466` | `1` |
| **RPC URL** | `https://rpc.robinhoodchain.com` | `https://ethereum-rpc.publicnode.com` |
| **Currency** | `ETH` | `ETH` |
| **Block Explorer** | [Robinhood Explorer](https://explorer.robinhoodchain.com) | [Etherscan](https://etherscan.io) |
| **Estimated Gas** | ~$0.01 (Micro-fee friendly) | ~$3.50+ (Gas check protects capital) |

Switch networks simply by setting `NETWORK=robinhood` or `NETWORK=mainnet` in `.env`.

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
1. **Check A (Capital)**: Is sufficient capital available within the $10 limit and complying with the configured 60% capital allocation limit?
2. **Check B (Profitability)**: Is expected net profit $\ge \$0.20$ after royalties, marketplace fees, and network gas?

Only when **BOTH** pass is an offer placed.

### Rule 6: NFT Re-Bidding & Simultaneous Offers Rule
1. **Same NFT Re-Bidding Restriction**: Once an offer is accepted and the bot acquires an NFT, the bot must not place another offer on that same NFT while it is owned or while the previous trade remains unresolved.
2. **No Re-Bidding Before Sale**: The bot must never place another offer on the same NFT before the previously acquired NFT has been sold and the sale has been confirmed.
3. **Simultaneous Offers on Different NFTs**: The bot may place offers on multiple different NFT items simultaneously, even while an earlier NFT purchase is awaiting resale. Every new offer must independently pass all required criteria and comply with the configured 60% capital allocation limit.
4. **Independent NFT Tracking**: The bot tracks each NFT separately, including its token ID, collection, active offers, ownership status, listing status, and sale confirmation.
* **Core Rule**: Never place another offer on the same NFT before its previous position is sold. After confirmed sale, re-bidding is allowed only if all criteria pass again. Offers on different eligible NFTs may run simultaneously within the capital limit.

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
NETWORK=robinhood
RPC_URL=https://rpc.robinhoodchain.com
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
