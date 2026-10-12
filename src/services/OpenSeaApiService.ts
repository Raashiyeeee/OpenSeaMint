import axios, { AxiosInstance } from 'axios';
import { BotConfig, CollectionMarketData, FeeRecipient } from '../types';
import { logger } from '../utils/logger';

export class OpenSeaApiService {
  private client: AxiosInstance;
  private config: BotConfig;
  private ethPriceCache: { price: number; timestamp: number } | null = null;
  private mockOrderStates: Map<string, { isCancelled: boolean; cancellationFails?: boolean; verificationFails?: boolean }> = new Map();

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
  public async getCollectionMarketData(collectionSlug: string, contractAddress: string): Promise<CollectionMarketData> {
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
        const offersRes = await this.client.get(`/offers/collection/${collectionSlug}/all?limit=10`);
        const offers = offersRes.data?.offers || [];
        for (const off of offers) {
          const rawPrice = off?.price?.value;
          const decimals = off?.price?.decimals || 18;
          const offerEth = parseFloat(rawPrice) / Math.pow(10, decimals);
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

      // 5. Incomplete Public Mint & 100% Mint-Out Metrics
      const isMinting = collectionData?.is_minting === true;
      const totalSupply = typeof collectionData?.total_supply === 'number'
        ? collectionData.total_supply
        : (typeof collectionData?.stats?.total_supply === 'number' ? collectionData.stats.total_supply : undefined);
      const maxSupply = typeof collectionData?.max_supply === 'number' ? collectionData.max_supply : undefined;

      let mintCompleted = true;
      let mintStatusVerified = true;
      let mintDemandPassed = true;
      let mintDemandReason: string | undefined;

      // 100% Mint-Out Rule:
      // If collection has not reached 100% of total mint supply, REJECT.
      if (maxSupply !== undefined && maxSupply > 0 && totalSupply !== undefined && totalSupply < maxSupply) {
        mintCompleted = false;
        mintDemandPassed = false;
        mintDemandReason = `Incomplete Collection: Mint has not reached 100% of total mint supply (${totalSupply}/${maxSupply} minted, ${((totalSupply / maxSupply) * 100).toFixed(1)}%). Core rule: If mint-out is not 100% complete, DO NOT OFFER ❌`;
      } else if (isMinting) {
        mintCompleted = false;
        mintDemandPassed = false;
        mintDemandReason = `Public mint is currently active (is_minting: true). Collection is not 100% minted out. Core rule: If mint-out is not 100% complete, DO NOT OFFER ❌`;
      } else if (totalSupply === undefined && maxSupply === undefined && collectionData === undefined) {
        mintStatusVerified = false;
        mintCompleted = false;
        mintDemandPassed = false;
        mintDemandReason = 'Mint-out status could not be verified from reliable marketplace data. Core rule: If status cannot be verified, DO NOT OFFER ❌';
      }

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
      const res = await this.client.get(`/events/collection/${collectionSlug}?event_type=sale&limit=50`);
      const events = res.data?.asset_events || [];

      // Filter events to strictly last 3 hours
      const sales3HoursRaw = events.filter((e: any) => (e.event_timestamp || 0) >= threeHoursAgo);

      const qualifiedSales: any[] = [];
      const wallets3Hours = new Set<string>();

      for (const sale of sales3HoursRaw) {
        // Rule 1: Paid in native ETH. WETH sales must not count.
        const symbol = (sale.payment?.symbol || sale.payment_token?.symbol || '').toUpperCase();
        if (symbol !== 'ETH') {
          // WETH sales and other non-ETH tokens must not count toward this requirement
          continue;
        }

        // Rule 2: Offer acceptances must not count toward this requirement
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

        // Rule 2: Genuine completed sales must occur at or around the current floor price.
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
      const sales1HourList = qualifiedSales.filter((e: any) => (e.event_timestamp || 0) >= oneHourAgo);
      const wallets1Hour = new Set<string>();
      for (const s of sales1HourList) {
        if (s.buyer) wallets1Hour.add(s.buyer.toLowerCase());
        if (s.seller) wallets1Hour.add(s.seller.toLowerCase());
      }

      // Final Buy Filter: Requires at least 10 completed native ETH floor sales within 3h AND 5+ unique wallets around floor
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
  public async cancelOffer(orderHash: string, chain: string = 'robinhood'): Promise<{ success: boolean; error?: string }> {
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
      const chainSlug = chain === 'mainnet' ? 'ethereum' : chain;
      const res = await this.client.post(`/orders/${chainSlug}/seaport/offers/cancel`, {
        order_hash: orderHash
      });
      logger.info({ orderHash, chain: chainSlug, data: res.data }, 'OpenSea accepted offer cancellation request');
      return { success: true };
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

    // 3. Live OpenSea v2 API query to verify inactive status
    try {
      const chainSlug = chain === 'mainnet' ? 'ethereum' : chain;
      const seaportAddress = this.config.seaport.contractAddress;
      const res = await this.client.get(`/orders/chain/${chainSlug}/protocol/${seaportAddress}/${orderHash}`);
      const order = res.data?.order || res.data;
      const status = (order?.status || '').toLowerCase();

      // If status is cancelled, expired, or fulfilled -> it is inactive
      if (status === 'cancelled' || status === 'expired' || status === 'filled' || status === 'inactive') {
        return { isInactive: true, status: status.toUpperCase() };
      }

      // If status is active or valid -> it is still active!
      if (status === 'active' || status === 'valid') {
        return { isInactive: false, status: 'ACTIVE', error: `Offer ${orderHash} is still reported as ACTIVE on OpenSea.` };
      }

      // Unknown status -> conservative: assume still active
      return { isInactive: false, status, error: `Unverified offer status: ${status}` };
    } catch (err: any) {
      // 404 indicates order no longer found or expired/purged from active orderbook
      if (err.response?.status === 404) {
        return { isInactive: true, status: 'NOT_FOUND' };
      }
      const errorMsg = err.response?.data?.errors || err.message;
      return { isInactive: false, error: `Could not verify offer status via API: ${JSON.stringify(errorMsg)}` };
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
   * Fetch NFTs currently owned by a wallet on a specified chain
   */
  public async getAccountNfts(walletAddress: string, collectionSlug?: string, chain: string = 'robinhood'): Promise<any[]> {
    try {
      const chainSlug = chain === 'mainnet' ? 'ethereum' : chain;
      const url = collectionSlug 
        ? `/chain/${chainSlug}/account/${walletAddress}/nfts?collection=${collectionSlug}&limit=50`
        : `/chain/${chainSlug}/account/${walletAddress}/nfts?limit=50`;
      const res = await this.client.get(url);
      return res.data?.nfts || [];
    } catch (err: any) {
      logger.debug(`Could not fetch NFTs for ${walletAddress} on ${chain}: ${err.message}`);
      return [];
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
    const chainSlug = networkKey === 'robinhood' ? 'robinhood' : 'ethereum';
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
