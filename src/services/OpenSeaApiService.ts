import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { BotConfig, CollectionMarketData, FeeRecipient, MintSupplySources } from '../types';
import { logger } from '../utils/logger';

export class OpenSeaApiService {
  private client: AxiosInstance;
  private config: BotConfig;
  private ethPriceCache: { price: number; timestamp: number } | null = null;
  private mockOrderStates: Map<string, { isCancelled: boolean; cancellationFails?: boolean; verificationFails?: boolean }> = new Map();
  private saleOrderSideCache: Map<string, 'LISTING' | 'OFFER' | 'UNKNOWN'> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
    const apiKey = process.env.OPENSEA_API_KEY || '';

    this.client = axios.create({
      baseURL: 'https://api.opensea.io/api/v2',
      timeout: 10000,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {})
      }
    });

    if (!apiKey) {
      logger.warn('OPENSEA_API_KEY not found in environment. Using public endpoints / simulated fallback data where required.');
    }
  }

  /**
   * Maps internal network keys to OpenSea API chain identifiers (per OpenSea API ChainIdentifier enum:
   * 'ethereum', 'robinhood', 'base', 'polygon', ...). 'mainnet' is the only internal alias.
   */
  public static toOpenSeaChain(networkKey?: string): string {
    if (!networkKey || networkKey === 'mainnet') return 'ethereum';
    return networkKey;
  }

  /**
   * 100% Mint-Out Rule — pure decision over all available supply sources.
   * - Any source reporting an active mint, or total < max, => NOT minted out (verified incomplete).
   * - Verified complete only when a max supply AND a total supply are known and total >= max.
   *   On-chain totalSupply() is preferred over API totals.
   * - Otherwise status is unverifiable (=> reject).
   */
  public static evaluateMintSupply(src: MintSupplySources): {
    verified: boolean;
    completed: boolean;
    isMinting: boolean;
    totalSupply?: number;
    maxSupply?: number;
    source: string;
    reason?: string;
  } {
    const isMinting = src.dropIsMinting === true || src.collectionIsMinting === true;
    const maxCandidates = [src.onChainMaxSupply, src.dropMaxSupply].filter((v): v is number => typeof v === 'number' && v > 0);
    const totalCandidates = [src.onChainTotalSupply, src.dropTotalSupply, src.collectionTotalSupply].filter((v): v is number => typeof v === 'number' && v >= 0);
    const maxSupply = maxCandidates.length > 0 ? Math.max(...maxCandidates) : undefined;
    const totalSupply = totalCandidates.length > 0 ? totalCandidates[0] : undefined;
    const source = [
      src.onChainTotalSupply !== undefined || src.onChainMaxSupply !== undefined ? 'on-chain' : '',
      src.dropMaxSupply !== undefined || src.dropTotalSupply !== undefined ? 'opensea-drop' : '',
      src.collectionTotalSupply !== undefined ? 'opensea-collection' : ''
    ].filter(Boolean).join('+') || 'none';

    if (isMinting) {
      return { verified: true, completed: false, isMinting, totalSupply, maxSupply, source, reason: 'Public mint is currently active (is_minting: true).' };
    }
    if (maxSupply !== undefined && totalSupply !== undefined) {
      // Every known total must have reached the (largest) known max supply
      const allReached = totalCandidates.every((t) => t >= maxSupply);
      if (!allReached) {
        const minTotal = Math.min(...totalCandidates);
        return { verified: true, completed: false, isMinting, totalSupply: minTotal, maxSupply, source, reason: `Mint has not reached 100% of max supply (${minTotal}/${maxSupply}).` };
      }
      return { verified: true, completed: true, isMinting, totalSupply, maxSupply, source };
    }
    return {
      verified: false, completed: false, isMinting, totalSupply, maxSupply, source,
      reason: `Mint-out status could not be verified (total_supply: ${totalSupply ?? 'unknown'}, max_supply: ${maxSupply ?? 'unknown'}).`
    };
  }

  /**
   * Reads totalSupply() and a max-supply getter directly from the NFT contract via the network RPC.
   * Common max getters are tried in order; all calls are read-only (eth_call).
   */
  public async readOnChainSupply(contractAddress: string, networkKey?: string): Promise<{ totalSupply?: number; maxSupply?: number }> {
    const net = networkKey || this.config.general.network || 'robinhood';
    const rpcUrl = this.config.networks?.[net]?.rpcUrl;
    if (!rpcUrl || !contractAddress || !/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) return {};
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    const abi = [
      'function totalSupply() view returns (uint256)',
      'function maxSupply() view returns (uint256)',
      'function MAX_SUPPLY() view returns (uint256)',
      'function maxTokens() view returns (uint256)',
      'function MAX_TOKENS() view returns (uint256)',
      'function collectionSize() view returns (uint256)'
    ];
    const c = new ethers.Contract(contractAddress, abi, provider);
    const toNum = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined);
    const result: { totalSupply?: number; maxSupply?: number } = {};
    try {
      result.totalSupply = toNum(await c.totalSupply());
    } catch {
      /* not ERC721Enumerable / no totalSupply */
    }
    for (const fn of ['maxSupply', 'MAX_SUPPLY', 'maxTokens', 'MAX_TOKENS', 'collectionSize']) {
      try {
        const v = toNum(await (c as any)[fn]());
        if (v !== undefined && v > 0) {
          result.maxSupply = v;
          break;
        }
      } catch {
        /* getter not implemented */
      }
    }
    provider.destroy();
    return result;
  }

  /**
   * OpenSea Drops API (/api/v2/drops/{slug}): max_supply, total_supply, is_minting for drops minted on OpenSea.
   * Returns {} when the collection is not an OpenSea drop or the call fails.
   */
  public async getDropSupply(collectionSlug: string): Promise<{ totalSupply?: number; maxSupply?: number; isMinting?: boolean }> {
    try {
      const res = await this.client.get(`/drops/${collectionSlug}`);
      const d = res.data || {};
      const num = (v: any) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
      return {
        totalSupply: num(d.total_supply),
        maxSupply: num(d.max_supply),
        isMinting: typeof d.is_minting === 'boolean' ? d.is_minting : undefined
      };
    } catch {
      return {};
    }
  }

  /**
   * Fetches latest ETH/USD price from CoinGecko or fallback
   */
  public async getEthPriceUsd(): Promise<number> {
    const now = Date.now();
    if (this.ethPriceCache && now - this.ethPriceCache.timestamp < 60000) {
      return this.ethPriceCache.price;
    }

    try {
      const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
        timeout: 5000
      });
      const price = res.data?.ethereum?.usd || 2700;
      this.ethPriceCache = { price, timestamp: now };
      return price;
    } catch {
      return this.ethPriceCache ? this.ethPriceCache.price : 2700;
    }
  }

  /**
   * Fetches collection stats and floor price from OpenSea v2 API
   */
  public async getCollectionMarketData(collectionSlug: string, contractAddress: string, networkKey?: string): Promise<CollectionMarketData> {
    const ethPriceUsd = await this.getEthPriceUsd();

    try {
      // 1. Fetch collection metadata & fees with fresh, un-cached data
      const collectionRes = await this.client.get(`/collections/${collectionSlug}`, {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      const collectionData = collectionRes.data;

      // Fees in basis points and full fee recipients array
      let openseaFeeBps = this.config.fees.openseaFeeBps;
      let mandatoryRoyaltyFeeBps = 0;
      let optionalRoyaltyFeeBps = 0;
      let creatorFeeDisabled = false;
      const rawFees: FeeRecipient[] = [];

      if (collectionData?.fees && Array.isArray(collectionData.fees) && collectionData.fees.length > 0) {
        for (const f of collectionData.fees) {
          const bps = Math.round((f.fee || 0) * 100);
          const isOpensea = f.recipient?.toLowerCase().includes('opensea') ||
            f.recipient?.toLowerCase() === '0x0000a26b00c1f0df003000390027140000faa719';

          if (isOpensea) {
            openseaFeeBps = bps;
            rawFees.push({
              fee: f.fee,
              recipient: f.recipient,
              required: true,
              disabled: false
            });
          } else {
            // Mandatory vs Optional Creator Fee Rule:
            // - Optional: If creator fee can be disabled (f.required === false), disable it before proceeding.
            // - Mandatory: If creator fee cannot be disabled (f.required === true), include in profitability calculations.
            // - Unverified: If status cannot be verified (required === undefined), never assume zero!
            if (f.required === false) {
              optionalRoyaltyFeeBps += bps;
              creatorFeeDisabled = true;
              rawFees.push({
                fee: f.fee,
                recipient: f.recipient,
                required: false,
                disabled: true
              });
              logger.info(
                { collectionSlug, recipient: f.recipient, feeBps: bps },
                `[Creator Fee Rule] Optional creator fee detected (${bps} bps). Automatically DISABLED (set to 0% in Seaport consideration & profit calculations).`
              );
            } else {
              mandatoryRoyaltyFeeBps += bps;
              rawFees.push({
                fee: f.fee,
                recipient: f.recipient,
                required: true,
                disabled: false
              });
              logger.info(
                { collectionSlug, recipient: f.recipient, feeBps: bps, required: f.required },
                `[Creator Fee Rule] Mandatory creator fee detected (${bps} bps). Included in all profitability calculations and order considerations.`
              );
            }
          }
        }
      } else {
        // If fee metadata cannot be verified from marketplace API, DO NOT assume zero!
        // Core rule: Never assume a fee is zero without verification.
        mandatoryRoyaltyFeeBps = this.config.fees.defaultRoyaltyBps;
        logger.warn(
          { collectionSlug, defaultRoyaltyBps: this.config.fees.defaultRoyaltyBps },
          `[Creator Fee Rule] Fee metadata could not be verified from marketplace API. Applying default creator fee (${this.config.fees.defaultRoyaltyBps} bps) in calculations.`
        );
      }

      // The applicable creator fee in all profitability calculations:
      // Includes only mandatory royalties (optional fees were disabled to 0)
      const royaltyFeeBps = mandatoryRoyaltyFeeBps;

      // 2. Fetch best listings & floor from stats
      let floorPriceEth = 0.05; // Fallback
      let sales24Hours = 0;
      try {
        const statsRes = await this.client.get(`/collections/${collectionSlug}/stats`);
        const statsFloor = statsRes.data?.total?.floor_price;
        const symbol = statsRes.data?.total?.floor_price_symbol || 'ETH';
        const intervalSales = statsRes.data?.intervals?.find((i: any) => i.interval === 'one_day')?.sales;
        if (intervalSales !== undefined) {
          sales24Hours = intervalSales;
        }
        if (statsFloor !== undefined && statsFloor !== null && (symbol === 'ETH' || symbol === 'WETH')) {
          floorPriceEth = parseFloat(statsFloor);
        } else {
          const listingsRes = await this.client.get(`/listings/collection/${collectionSlug}/all?limit=5`);
          const listings = listingsRes.data?.listings || [];
          if (listings.length > 0) {
            const rawPrice = listings[0]?.price?.current?.value;
            const decimals = listings[0]?.price?.current?.decimals || 18;
            floorPriceEth = parseFloat(rawPrice) / Math.pow(10, decimals);
          }
        }
      } catch (err: any) {
        logger.debug(`Could not fetch active listings via API for ${collectionSlug}: ${err.message}`);
      }

      // 3. Fetch best offers
      let topOfferEth = 0; // Default 0 (never default to dummy 0.04 ETH)
      try {
        const offersRes = await this.client.get(`/offers/collection/${collectionSlug}/all?limit=100`);
        const offers = offersRes.data?.offers || [];
        for (const off of offers) {
          const offerEth = OpenSeaApiService.perUnitOfferPriceEth(off);
          // Only compete with valid collection offers that are strictly below floor price
          if (offerEth > 0 && offerEth < floorPriceEth && offerEth > topOfferEth) {
            topOfferEth = offerEth;
          }
        }
      } catch (err: any) {
        logger.debug(`Could not fetch active offers via API for ${collectionSlug}: ${err.message}`);
      }

      // 4. Fetch Liquidity Metrics with floor reference
      const liquidity = await this.getCollectionLiquidity(collectionSlug, floorPriceEth, sales24Hours);

      // 5. Incomplete Public Mint & 100% Mint-Out Metrics — combine on-chain supply, OpenSea Drops API and
      //    OpenSea collection data. Reject unless 100% mint-out is positively verified.
      const collectionTotalSupply = typeof collectionData?.total_supply === 'number' ? collectionData.total_supply : undefined;
      const [drop, onChain] = await Promise.all([
        this.getDropSupply(collectionSlug),
        this.readOnChainSupply(contractAddress, networkKey).catch(() => ({} as { totalSupply?: number; maxSupply?: number }))
      ]);
      const mint = OpenSeaApiService.evaluateMintSupply({
        collectionTotalSupply,
        collectionIsMinting: collectionData?.is_minting === true ? true : undefined,
        dropTotalSupply: drop.totalSupply,
        dropMaxSupply: drop.maxSupply,
        dropIsMinting: drop.isMinting,
        onChainTotalSupply: onChain.totalSupply,
        onChainMaxSupply: onChain.maxSupply
      });
      const isMinting = mint.isMinting;
      const totalSupply = mint.totalSupply;
      const maxSupply = mint.maxSupply;
      const mintCompleted = mint.verified && mint.completed;
      const mintStatusVerified = mint.verified;
      let mintDemandPassed = mintCompleted;
      let mintDemandReason: string | undefined = mintCompleted
        ? undefined
        : `${mint.reason} (sources: ${mint.source}). Core rule: If mint-out is not 100% complete or cannot be verified, DO NOT OFFER ❌`;

      if (!liquidity.liquidityPassed) {
        mintDemandPassed = false;
        if (!mintDemandReason) {
          mintDemandReason = `Collection lacks reliable secondary-market liquidity (${liquidity.liquidityReason || 'low sales/wallets'}).`;
        }
      }

      return {
        slug: collectionSlug,
        contractAddress,
        floorPriceEth,
        topOfferEth,
        numListings: 10,
        openseaFeeBps,
        royaltyFeeBps,
        mandatoryRoyaltyFeeBps,
        optionalRoyaltyFeeBps,
        creatorFeeDisabled,
        ethPriceUsd,
        timestamp: Date.now(),
        fees: rawFees,
        sales1Hour: liquidity.sales1Hour,
        uniqueWallets1Hour: liquidity.uniqueWallets1Hour,
        sales3Hours: liquidity.sales3Hours,
        uniqueWallets3Hours: liquidity.uniqueWallets3Hours,
        sales24Hours,
        floorSalesCount: liquidity.sales3Hours,
        liquidityPassed: liquidity.liquidityPassed,
        liquidityReason: liquidity.liquidityReason,
        isMinting,
        mintCompleted,
        mintStatusVerified,
        totalSupply,
        maxSupply,
        mintDemandPassed,
        mintDemandReason
      };
    } catch (err: any) {
      logger.warn({ slug: collectionSlug, error: err.message }, 'Failed to fetch OpenSea market data via API, generating conservative market estimate');
      
      // Conservative fallback
      return {
        slug: collectionSlug,
        contractAddress,
        floorPriceEth: 0.045,
        topOfferEth: 0.038,
        numListings: 20,
        openseaFeeBps: this.config.fees.openseaFeeBps,
        royaltyFeeBps: this.config.fees.defaultRoyaltyBps,
        ethPriceUsd,
        timestamp: Date.now(),
        sales1Hour: 0,
        uniqueWallets1Hour: 0,
        sales3Hours: 0,
        uniqueWallets3Hours: 0,
        liquidityPassed: false,
        liquidityReason: 'Conservative fallback on error',
        isMinting: false,
        mintCompleted: false,
        mintStatusVerified: false,
        mintDemandPassed: false,
        mintDemandReason: 'Conservative fallback on error'
      };
    }
  }

  /**
   * Fetch 3-hour completed floor-level sales and unique wallets for liquidity verification
   * MANDATORY NFT OFFER ELIGIBILITY RULES:
   * Rule 1. Native ETH Sales: At least 10 completed floor-price sales within the last 3 hours, paid in native ETH. WETH sales must not count.
   * Rule 2. Actual Floor Sales: Genuine completed sales must occur at or around the current floor price. Offer acceptances and WETH sales must not count toward this requirement.
   * Rule 5. Mandatory Rejection: If any condition fails, the bot must not place an offer.
   */
  public async getCollectionLiquidity(
    collectionSlug: string,
    floorPriceEth: number = 0,
    sales24Hours: number = 0
  ): Promise<{
    sales3Hours: number;
    uniqueWallets3Hours: number;
    sales1Hour: number;
    uniqueWallets1Hour: number;
    liquidityPassed: boolean;
    liquidityReason?: string;
  }> {
    const minSales = this.config.liquidity?.minSales3Hours ?? 10;
    const minWallets = this.config.liquidity?.minUniqueWallets3Hours ?? 5;
    const threeHoursAgo = Math.floor(Date.now() / 1000) - (3 * 3600);
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    const floorMinPercent = (this.config.liquidity?.floorRangeMinPercent ?? 80.0) / 100;
    const floorMaxPercent = (this.config.liquidity?.floorRangeMaxPercent ?? 135.0) / 100;
    const minFloorAllowed = floorPriceEth > 0 ? floorPriceEth * floorMinPercent : 0;
    const maxFloorAllowed = floorPriceEth > 0 ? floorPriceEth * floorMaxPercent : Infinity;

    try {
      // Fetch ALL sale events from the last 3 hours (paginated, bounded) so busy collections are not undercounted
      const nowSec = Math.floor(Date.now() / 1000);
      const events: any[] = [];
      let next: string | undefined;
      for (let page = 0; page < 10; page++) {
        const url = `/events/collection/${collectionSlug}?event_type=sale&after=${threeHoursAgo}&limit=200` + (next ? `&next=${encodeURIComponent(next)}` : '');
        const res = await this.client.get(url);
        events.push(...(res.data?.asset_events || []));
        next = res.data?.next;
        if (!next) break;
      }

      // Filter events to strictly last 3 hours (anything older, or without a valid timestamp, never counts)
      const sales3HoursRaw = events.filter((e: any) => {
        const ts = Number(e.event_timestamp);
        return Number.isFinite(ts) && ts >= threeHoursAgo && ts <= nowSec + 60;
      });

      const qualifiedSales: any[] = [];
      const wallets3Hours = new Set<string>();

      for (const sale of sales3HoursRaw) {
        // Must be an actual completed sale (exclude pending, cancelled, or failed events)
        if (sale.event_type && sale.event_type.toLowerCase() !== 'sale') {
          continue;
        }
        const status = (sale.status || '').toLowerCase();
        if (status === 'pending' || status === 'cancelled' || status === 'failed' || status === 'reverted' || sale.is_completed === false) {
          continue;
        }

        // Rule 1: Paid in native ETH. WETH sales and other non-native currencies must not count.
        const symbol = (sale.payment?.symbol || sale.payment_token?.symbol || '').toUpperCase();
        const tokenName = (sale.payment?.name || sale.payment_token?.name || '').toUpperCase();
        const tokenAddr = (sale.payment?.token_address || sale.payment_token?.address || '').toLowerCase();
        const wethAddresses = ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'];

        // Native ETH is reported with the zero address as payment token; any other token address is not native ETH
        const isNativeTokenAddr = tokenAddr === '' || tokenAddr === '0x0000000000000000000000000000000000000000';
        if (symbol !== 'ETH' || tokenName.includes('WRAPPED') || wethAddresses.includes(tokenAddr) || !isNativeTokenAddr) {
          // WETH sales strictly excluded
          continue;
        }

        // Rule 2: Accepted offers and non-completed sales must not count toward floor sales requirement
        const isOfferAcceptance =
          sale.order_type === 'offer' ||
          sale.order_type === 'collection_offer' ||
          sale.order_type === 'criteria_offer' ||
          sale.is_offer === true ||
          sale.criteria_offer === true ||
          sale.offer_type !== undefined ||
          (sale.event_type && sale.event_type.toLowerCase().includes('offer'));

        if (isOfferAcceptance) {
          continue; // Offer acceptances must not count toward this requirement
        }

        // Sale events do not carry an order type, so the filled Seaport order is looked up by order_hash:
        // a filled OFFER (offerer gives ERC20/WETH, or criteria offer) is an accepted offer and is excluded.
        // (Seaport offers cannot pay in native ETH, so the native-ETH filter above already removes nearly all of them.)
        if (sale.order_hash) {
          const side = await this.getSaleOrderSide(sale.order_hash, sale.chain, sale.protocol_address);
          if (side === 'OFFER') {
            continue;
          }
        }

        // Parse price
        let salePriceEth = 0;
        if (sale.payment?.quantity && sale.payment?.decimals) {
          salePriceEth = parseFloat(sale.payment.quantity) / Math.pow(10, sale.payment.decimals);
        } else if (sale.payment_token?.eth_price) {
          salePriceEth = parseFloat(sale.payment_token.eth_price);
        } else if (sale.total_price) {
          const dec = sale.payment_token?.decimals || 18;
          salePriceEth = parseFloat(sale.total_price) / Math.pow(10, dec);
        }

        // Rule 3: Must be actual completed sales at the floor price.
        // If floorPriceEth <= 0 or salePriceEth <= 0, genuine floor sale cannot be verified
        if (floorPriceEth <= 0 || salePriceEth <= 0) {
          continue;
        }

        // Exclude below-floor offer sales (< minFloorAllowed) and high outliers (> maxFloorAllowed)
        if (salePriceEth < minFloorAllowed || salePriceEth > maxFloorAllowed) {
          continue;
        }

        qualifiedSales.push(sale);
        if (sale.buyer) wallets3Hours.add(sale.buyer.toLowerCase());
        if (sale.seller) wallets3Hours.add(sale.seller.toLowerCase());
      }

      const sales3Hours = qualifiedSales.length;
      const uniqueWallets3Hours = wallets3Hours.size;
      const sales1HourList = qualifiedSales.filter((e: any) => Number(e.event_timestamp) >= oneHourAgo);
      const wallets1Hour = new Set<string>();
      for (const s of sales1HourList) {
        if (s.buyer) wallets1Hour.add(s.buyer.toLowerCase());
        if (s.seller) wallets1Hour.add(s.seller.toLowerCase());
      }

      // Recent Floor Sales Requirement: Requires at least 10 completed native ETH floor sales within 3h AND 5+ unique wallets around floor
      const liquidityPassed = sales3Hours >= minSales && uniqueWallets3Hours >= minWallets;

      let liquidityReason = `Passed 3-hour native ETH floor liquidity check (${sales3Hours}/${minSales} sales, ${uniqueWallets3Hours}/${minWallets} unique wallets)`;
      if (!liquidityPassed) {
        if (sales3Hours < minSales) {
          liquidityReason = `Offer Rejected ❌: Only ${sales3Hours}/${minSales} genuine native ETH floor-price sales in the last 3 hours (minimum ${minSales} required, WETH and offer acceptances excluded).`;
        } else {
          liquidityReason = `Offer Rejected ❌: Only ${uniqueWallets3Hours}/${minWallets} unique wallets in the last 3 hours (minimum ${minWallets} required).`;
        }
      }

      return {
        sales3Hours,
        uniqueWallets3Hours,
        sales1Hour: sales1HourList.length,
        uniqueWallets1Hour: wallets1Hour.size,
        liquidityPassed,
        liquidityReason
      };
    } catch (err: any) {
      logger.warn({ slug: collectionSlug, error: err.message }, 'Failed to fetch liquidity events from OpenSea');
      return {
        sales3Hours: 0,
        uniqueWallets3Hours: 0,
        sales1Hour: 0,
        uniqueWallets1Hour: 0,
        liquidityPassed: false,
        liquidityReason: `API error fetching liquidity: ${err.message}`
      };
    }
  }

  /**
   * Post a signed collection offer order to OpenSea (/offers)
   */
  public async postCollectionOffer(signedOrderPayload: any): Promise<any> {
    if (process.env.BOT_MODE === 'SIMULATION') {
      logger.info({ payload: signedOrderPayload }, '[SIMULATION] Pretending to submit collection offer to OpenSea');
      return { order_hash: `sim_offer_${Date.now()}`, status: 'success' };
    }

    try {
      const response = await this.client.post('/offers', signedOrderPayload);
      return response.data;
    } catch (err: any) {
      const errorDetail = err.response?.data?.errors || err.response?.data || err.message;
      logger.error({ status: err.response?.status, details: errorDetail }, 'OpenSea rejected offer');
      throw new Error(`OpenSea API Error: ${JSON.stringify(errorDetail)}`);
    }
  }

  /**
   * Post a single token buy order (Part Time Larry offerSingle style)
   */
  public async postSingleOffer(chain: string, signedOrderPayload: any): Promise<any> {
    if (process.env.BOT_MODE === 'SIMULATION') {
      logger.info({ chain, payload: signedOrderPayload }, '[SIMULATION] Pretending to submit single token offer to OpenSea');
      return { order_hash: `sim_single_${Date.now()}`, status: 'success' };
    }

    try {
      const response = await this.client.post(`/orders/${chain}/seaport/offers`, signedOrderPayload);
      return response.data;
    } catch (err: any) {
      const errorDetail = err.response?.data?.errors || err.response?.data || err.message;
      logger.error({ status: err.response?.status, details: errorDetail }, 'OpenSea rejected single token offer');
      throw new Error(`OpenSea API Error: ${JSON.stringify(errorDetail)}`);
    }
  }

  /**
   * Set mock state for an order hash (used in automated testing of cancellation and verification)
   */
  public setMockOrderState(orderHash: string, state: { isCancelled: boolean; cancellationFails?: boolean; verificationFails?: boolean }): void {
    this.mockOrderStates.set(orderHash, state);
  }

  /**
   * Clear all mock order states
   */
  public clearMockOrderStates(): void {
    this.mockOrderStates.clear();
  }

  /**
   * Automatic Offer Cancellation: Initiates cancellation of an active offer via OpenSea API / Seaport
   */
  public async cancelOffer(orderHash: string, chain: string = 'robinhood'): Promise<{ success: boolean; error?: string; fillableUntil?: number }> {
    // 1. Mock state check for testing
    const mock = this.mockOrderStates.get(orderHash);
    if (mock) {
      if (mock.cancellationFails) {
        logger.warn({ orderHash, chain }, 'Mock cancellation failed as configured for test.');
        return { success: false, error: 'Simulated cancellation network/API failure' };
      }
      mock.isCancelled = true;
      return { success: true };
    }

    // 2. Simulation mode
    if (process.env.BOT_MODE === 'SIMULATION') {
      if (orderHash.includes('fail_cancel')) {
        logger.warn({ orderHash, chain }, '[SIMULATION] Simulated offer cancellation failure.');
        return { success: false, error: 'Simulated offer cancellation rejection' };
      }
      logger.info({ orderHash, chain }, '[SIMULATION] Offer cancellation submitted successfully.');
      return { success: true };
    }

    // 3. Live OpenSea v2 API cancellation
    try {
      const chainSlug = OpenSeaApiService.toOpenSeaChain(chain);
      const seaportAddress = this.config.seaport.contractAddress;
      const res = await this.client.post(`/orders/chain/${chainSlug}/protocol/${seaportAddress}/${orderHash}/cancel`, {});
      // Per OpenSea docs: a fulfillment signature issued before the offchain cancel stays valid until
      // last_signature_issued_valid_until ("0" = none issued). The order is still fillable until then.
      const validUntilRaw = res.data?.last_signature_issued_valid_until;
      let fillableUntil: number | undefined;
      if (validUntilRaw && validUntilRaw !== '0') {
        const parsed = Date.parse(validUntilRaw);
        fillableUntil = Number.isFinite(parsed) ? parsed : Date.now() + 5 * 60 * 1000;
      }
      logger.info({ orderHash, chain: chainSlug, data: res.data, fillableUntil }, 'OpenSea accepted offer cancellation request');
      return { success: true, fillableUntil };
    } catch (err: any) {
      const errorDetail = err.response?.data?.errors || err.response?.data || err.message;
      logger.error({ orderHash, chain, error: errorDetail }, 'OpenSea failed to cancel offer');
      return { success: false, error: typeof errorDetail === 'string' ? errorDetail : JSON.stringify(errorDetail) };
    }
  }

  /**
   * Cancellation Verification: Verifies that the offer is no longer active before treating it as cancelled.
   * If verification fails or order is still active, must return isInactive: false.
   */
  public async verifyOfferInactive(orderHash: string, chain: string = 'robinhood'): Promise<{ isInactive: boolean; status?: string; error?: string }> {
    // 1. Mock state check for testing
    const mock = this.mockOrderStates.get(orderHash);
    if (mock) {
      if (mock.verificationFails) {
        return { isInactive: false, status: 'ACTIVE', error: 'Verification failed: Order remains active on marketplace.' };
      }
      if (mock.isCancelled) {
        return { isInactive: true, status: 'CANCELLED' };
      }
      return { isInactive: false, status: 'ACTIVE', error: 'Order is still active in marketplace.' };
    }

    // 2. Simulation mode
    if (process.env.BOT_MODE === 'SIMULATION') {
      if (orderHash.includes('fail_verify') || orderHash.includes('still_active')) {
        return { isInactive: false, status: 'ACTIVE', error: '[SIMULATION] Simulated verification failure: offer still active' };
      }
      return { isInactive: true, status: 'CANCELLED' };
    }

    // 3. Live OpenSea v2 Get Order: GET /orders/chain/{chain}/protocol/{protocol}/{order_hash} -> { order: { status } }
    //    status enum (OpenSea docs): ACTIVE | INACTIVE | FULFILLED | EXPIRED | CANCELLED
    try {
      const chainSlug = OpenSeaApiService.toOpenSeaChain(chain);
      const seaportAddress = this.config.seaport.contractAddress;
      const res = await this.client.get(`/orders/chain/${chainSlug}/protocol/${seaportAddress}/${orderHash}`);
      const order = res.data?.order;
      const status = String(order?.status || '').toUpperCase();

      if (status === 'CANCELLED' || status === 'EXPIRED') {
        return { isInactive: true, status };
      }
      if (status === 'FULFILLED') {
        // The offer was ACCEPTED (NFT bought) — inactive, but this is a fill, not a cancellation
        return { isInactive: true, status: 'FULFILLED' };
      }
      if (status === 'ACTIVE' || status === 'INACTIVE') {
        // INACTIVE = temporarily unfillable (e.g. balance/approval) and can revalidate — NOT cancelled
        return { isInactive: false, status, error: `Offer ${orderHash} is still ${status} on OpenSea (not cancelled).` };
      }
      return { isInactive: false, status, error: `Unverified offer status: ${status || 'missing'}` };
    } catch (err: any) {
      // 404 does not prove cancellation (the order may simply be unknown/unindexed): treat as unverified.
      // The strategy falls back to the on-chain Seaport getOrderStatus check.
      const errorMsg = err.response?.data?.errors || err.message;
      return {
        isInactive: false,
        status: err.response?.status === 404 ? 'NOT_FOUND' : undefined,
        error: `Could not verify offer status via API: ${JSON.stringify(errorMsg)}`
      };
    }
  }

  /**
   * Per-unit price (ETH) of an OpenSea offer object. price.value covers the whole order quantity,
   * so it is divided by the number of NFTs requested (consideration[0].startAmount) for multi-quantity offers.
   */
  public static perUnitOfferPriceEth(off: any): number {
    const rawPrice = off?.price?.value ?? off?.price?.current?.value;
    const decimals = off?.price?.decimals ?? off?.price?.current?.decimals ?? 18;
    const total = parseFloat(rawPrice) / Math.pow(10, decimals);
    if (!Number.isFinite(total) || total <= 0) return 0;
    const qtyRaw = off?.protocol_data?.parameters?.consideration?.[0]?.startAmount;
    const qty = qtyRaw !== undefined && Number(qtyRaw) > 0 ? Number(qtyRaw) : 1;
    return total / qty;
  }

  /**
   * Best offer on a specific NFT (OpenSea: GET /offers/collection/{slug}/nfts/{identifier}/best).
   * Returns per-unit price in ETH and the order hash, or undefined if none / unavailable.
   */
  /**
   * Lowest active listing in the collection that is NOT ours (GET /listings/collection/{slug}/best, sorted by
   * price ascending). Returns null when no competing listing exists, undefined when the lookup failed.
   */
  public async getLowestCompetingListing(
    collectionSlug: string,
    ourAddress: string
  ): Promise<{ priceEth: number; orderHash?: string } | null | undefined> {
    try {
      const res = await this.client.get(`/listings/collection/${collectionSlug}/best?limit=50`);
      const listings: any[] = res.data?.listings || [];
      const ours = (ourAddress || '').toLowerCase();
      for (const l of listings) {
        const params = l?.protocol_data?.parameters;
        if ((params?.offerer || '').toLowerCase() === ours) continue;
        const cur = l?.price?.current;
        if (!cur?.value) continue;
        const qty = Number(params?.offer?.[0]?.startAmount || 1) || 1;
        const priceEth = Number(cur.value) / Math.pow(10, cur.decimals ?? 18) / qty;
        if (priceEth > 0) return { priceEth, orderHash: l.order_hash };
      }
      return null;
    } catch (err: any) {
      logger.warn({ slug: collectionSlug, err: err.message }, 'Failed to fetch competing listings');
      return undefined;
    }
  }

    public async getBestNftOffer(collectionSlug: string, tokenId: string): Promise<{ priceEth: number; orderHash?: string } | undefined> {
    try {
      const res = await this.client.get(`/offers/collection/${collectionSlug}/nfts/${tokenId}/best`);
      const priceEth = OpenSeaApiService.perUnitOfferPriceEth(res.data);
      if (priceEth <= 0) return undefined;
      return { priceEth, orderHash: res.data?.order_hash };
    } catch (err: any) {
      logger.debug({ collectionSlug, tokenId, err: err.message }, 'Could not fetch best NFT offer');
      return undefined;
    }
  }

  /**
   * Classifies the Seaport order filled by a sale: LISTING (seller's ask filled — a genuine buy) or
   * OFFER (a bid was accepted). Uses GET /orders/... on the sale's order_hash. Cached per order hash.
   */
  public async getSaleOrderSide(orderHash: string, chain?: string, protocolAddress?: string): Promise<'LISTING' | 'OFFER' | 'UNKNOWN'> {
    const cached = this.saleOrderSideCache.get(orderHash);
    if (cached) return cached;
    let side: 'LISTING' | 'OFFER' | 'UNKNOWN' = 'UNKNOWN';
    try {
      const chainSlug = chain || 'ethereum';
      const protocol = protocolAddress || this.config.seaport.contractAddress;
      const res = await this.client.get(`/orders/chain/${chainSlug}/protocol/${protocol}/${orderHash}`);
      const order = res.data?.order;
      if (order) {
        const offerItems: any[] = order.protocol_data?.parameters?.offer || [];
        const firstType = offerItems.length > 0 ? Number(offerItems[0].itemType) : undefined;
        if (order.criteria || firstType === 1) {
          side = 'OFFER'; // offerer supplies ERC20 (WETH) => bid
        } else if (firstType !== undefined && firstType >= 2) {
          side = 'LISTING'; // offerer supplies the NFT => ask
        } else if (order.type) {
          side = 'LISTING'; // Listing schema carries `type` (basic/english/...)
        }
      }
    } catch {
      side = 'UNKNOWN';
    }
    if (side !== 'UNKNOWN') this.saleOrderSideCache.set(orderHash, side);
    return side;
  }

  /**
   * Confirms a SALE of a specific NFT by our wallet (seller) since `afterSec`, via
   * GET /events/chain/{chain}/contract/{address}/nfts/{identifier}?event_type=sale&after=...
   * Returns the sale, null if no sale (e.g. a plain transfer), or undefined if it could not be checked.
   */
  public async getConfirmedNftSale(
    contractAddress: string,
    tokenId: string,
    sellerAddress: string,
    networkKey?: string,
    afterSec?: number
  ): Promise<{ salePriceEth: number; txHash?: string; timestamp: number; paymentSymbol: string } | null | undefined> {
    try {
      const chainSlug = OpenSeaApiService.toOpenSeaChain(networkKey);
      const after = afterSec ? `&after=${Math.max(0, Math.floor(afterSec) - 60)}` : '';
      const res = await this.client.get(`/events/chain/${chainSlug}/contract/${contractAddress}/nfts/${tokenId}?event_type=sale&limit=50${after}`);
      const events: any[] = res.data?.asset_events || [];
      const sale = events.find(
        (e) => (!e.event_type || String(e.event_type).toLowerCase() === 'sale') &&
          String(e.seller || '').toLowerCase() === sellerAddress.toLowerCase()
      );
      if (!sale) return null;
      const quantity = sale.payment?.quantity;
      const decimals = sale.payment?.decimals ?? 18;
      const salePriceEth = quantity ? parseFloat(quantity) / Math.pow(10, decimals) : 0;
      return {
        salePriceEth,
        txHash: sale.transaction,
        timestamp: Number(sale.event_timestamp) || 0,
        paymentSymbol: String(sale.payment?.symbol || '').toUpperCase()
      };
    } catch (err: any) {
      logger.debug({ contractAddress, tokenId, err: err.message }, 'Could not query NFT sale events');
      return undefined;
    }
  }


  /**
   * Fetches latest minted tokens in a collection (Larry's COLLECTION_ASSETS_URL idea)
   */
  public async getLatestMintedTokens(collectionSlug: string, limit: number = 10): Promise<Array<{ tokenId: string; name: string }>> {
    try {
      const res = await this.client.get(`/collection/${collectionSlug}/nfts?limit=${limit}`);
      const nfts = res.data?.nfts || [];
      return nfts.map((nft: any) => ({
        tokenId: nft.identifier,
        name: nft.name || `#${nft.identifier}`
      }));
    } catch (err: any) {
      logger.debug(`Could not fetch minted tokens for ${collectionSlug}: ${err.message}`);
      return [];
    }
  }

  /**
   * Post a signed listing order to OpenSea
   */
  public async postListing(chain: string, signedListingPayload: any): Promise<any> {
    if (process.env.BOT_MODE === 'SIMULATION') {
      logger.info({ chain, payload: signedListingPayload }, '[SIMULATION] Pretending to submit listing to OpenSea');
      return { order_hash: `sim_listing_${Date.now()}`, status: 'success' };
    }

    try {
      const response = await this.client.post(`/orders/${chain}/seaport/listings`, signedListingPayload);
      return response.data;
    } catch (err: any) {
      const errorDetail = err.response?.data?.errors || err.response?.data || err.message;
      logger.error({ status: err.response?.status, details: errorDetail }, 'OpenSea rejected listing');
      throw new Error(`OpenSea API Error: ${JSON.stringify(errorDetail)}`);
    }
  }

  /**
   * Fetch NFTs currently owned by a wallet on a specified chain (paginated).
   * Returns null when ownership cannot be determined (API error) so callers never mistake an
   * API failure for "NFT left the wallet".
   */
  public async getAccountNfts(walletAddress: string, collectionSlug?: string, chain: string = 'robinhood'): Promise<any[] | null> {
    try {
      const chainSlug = OpenSeaApiService.toOpenSeaChain(chain);
      const base = collectionSlug
        ? `/chain/${chainSlug}/account/${walletAddress}/nfts?collection=${collectionSlug}&limit=200`
        : `/chain/${chainSlug}/account/${walletAddress}/nfts?limit=200`;
      const all: any[] = [];
      let next: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await this.client.get(base + (next ? `&next=${encodeURIComponent(next)}` : ''));
        all.push(...(res.data?.nfts || []));
        next = res.data?.next;
        if (!next) break;
      }
      if (next) {
        // Could not read the complete holdings list: ownership is not reliably known
        return null;
      }
      return all;
    } catch (err: any) {
      logger.warn(`Could not fetch NFTs for ${walletAddress} on ${chain}: ${err.message}`);
      return null;
    }
  }

  /**
   * Dynamically discovers active collections with floor prices between minFloorUsd and maxFloorUsd on a given network
   */
  public async discoverCollectionsByChain(
    networkKey: string,
    minFloorUsd: number = 0.50,
    maxFloorUsd: number = 3.50
  ): Promise<any[]> {
    const chainSlug = OpenSeaApiService.toOpenSeaChain(networkKey);
    const ethPriceUsd = await this.getEthPriceUsd();
    const discovered: any[] = [];

    try {
      // Query top collections sorted by 1-day trading volume
      const res = await this.client.get(`/collections?chain=${chainSlug}&limit=100&order_by=one_day_volume`);
      const collections = (res.data?.collections || []).filter(
        (col: any) => col.collection_offers_enabled && !col.is_disabled
      );

      // Concurrent stats fetch in parallel batches for low latency
      const statsPromises = collections.map(async (col: any) => {
        const contract = col.contracts?.find((c: any) => c.chain === chainSlug)?.address || col.contracts?.[0]?.address;
        if (!contract) return null;
        try {
          const statsRes = await this.client.get(`/collections/${col.collection}/stats`, { timeout: 4000 });
          const floor = statsRes.data?.total?.floor_price;
          const symbol = statsRes.data?.total?.floor_price_symbol || 'ETH';
          const oneDaySales = statsRes.data?.intervals?.find((i: any) => i.interval === 'one_day')?.sales || 0;

          if (floor !== undefined && floor !== null && floor > 0 && (symbol === 'ETH' || symbol === 'WETH')) {
            const floorUsd = floor * ethPriceUsd;
            // Floor within target range AND has verified trading activity (>= 1 sale, prioritized >= 5)
            if (floorUsd >= minFloorUsd && floorUsd <= maxFloorUsd && oneDaySales >= 1) {
              return {
                name: col.name,
                slug: col.collection,
                contractAddress: contract,
                network: networkKey,
                floorEth: floor,
                floorUsd,
                oneDaySales
              };
            }
          }
        } catch {
          // Skip on error
        }
        return null;
      });

      const results = await Promise.all(statsPromises);
      for (const item of results) {
        if (!item) continue;
        logger.info(
          {
            name: item.name,
            slug: item.slug,
            network: networkKey,
            floorEth: item.floorEth,
            floorUsd: `$${item.floorUsd.toFixed(2)}`,
            oneDaySales: item.oneDaySales
          },
          `Dynamic Discovery: Found active ${networkKey.toUpperCase()} volume collection ($${minFloorUsd}-$${maxFloorUsd})`
        );
        discovered.push(item);
      }
    } catch (err: any) {
      logger.debug({ network: networkKey, err: err.message }, 'Dynamic collection discovery routine failed');
    }

    return discovered;
  }

  /**
   * Backward compatible micro cap discovery
   */
  public async discoverMicroCapCollections(maxFloorEth: number = 0.0035): Promise<any[]> {
    return this.discoverCollectionsByChain('robinhood', 0.5, maxFloorEth * 2700);
  }
}
