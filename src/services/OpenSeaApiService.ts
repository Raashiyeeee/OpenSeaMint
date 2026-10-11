import axios, { AxiosInstance } from 'axios';
import { BotConfig, CollectionMarketData } from '../types';
import { logger } from '../utils/logger';

export class OpenSeaApiService {
  private client: AxiosInstance;
  private config: BotConfig;
  private ethPriceCache: { price: number; timestamp: number } | null = null;

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
      // 1. Fetch collection metadata & fees
      const collectionRes = await this.client.get(`/collections/${collectionSlug}`);
      const collectionData = collectionRes.data;

      // Fees in basis points and full fee recipients array
      let openseaFeeBps = this.config.fees.openseaFeeBps;
      let royaltyFeeBps = this.config.fees.defaultRoyaltyBps;
      const rawFees: any[] = [];

      if (collectionData?.fees && Array.isArray(collectionData.fees)) {
        for (const f of collectionData.fees) {
          rawFees.push({
            fee: f.fee,
            recipient: f.recipient,
            required: f.required
          });
          const bps = Math.round((f.fee || 0) * 100);
          if (f.recipient?.toLowerCase().includes('opensea')) {
            openseaFeeBps = bps;
          } else {
            royaltyFeeBps += bps;
          }
        }
      }

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

      return {
        slug: collectionSlug,
        contractAddress,
        floorPriceEth,
        topOfferEth,
        numListings: 10,
        openseaFeeBps,
        royaltyFeeBps,
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
        liquidityReason: liquidity.liquidityReason
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
        liquidityReason: 'Conservative fallback on error'
      };
    }
  }

  /**
   * Fetch 3-hour completed floor-level sales and unique wallets for liquidity verification
   * MANDATORY HARD RULES (Rules 1, 3, 10):
   * 1. Window: Last 3 hours
   * 2. At least 20 completed sales
   * 3. Made using native ETH (ETH or WETH)
   * 4. At least 5 different wallets (buyers/sellers)
   * 5. Sales must occur at or around current floor price range (e.g. 80% to 135% of floor)
   * 6. Sales at low offer prices must NOT be counted!
   * 7. Arbitrary high outlier sales must NOT be counted!
   * If any condition fails: DO NOT PLACE OFFER.
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
    const minSales = this.config.liquidity?.minSales3Hours ?? 20;
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
        // Condition: Sales must be in native ETH (ETH or WETH)
        const symbol = (sale.payment?.symbol || sale.payment_token?.symbol || 'ETH').toUpperCase();
        if (symbol !== 'ETH' && symbol !== 'WETH') {
          continue;
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

        // Condition: Sales are around the actual floor-price range (80% - 135%)
        // Condition: Offer-price sales (< minFloorAllowed) and high outliers (> maxFloorAllowed) are NOT counted
        if (floorPriceEth > 0 && salePriceEth > 0) {
          if (salePriceEth < minFloorAllowed) {
            continue; // Exclude below-floor offer sales
          }
          if (salePriceEth > maxFloorAllowed) {
            continue; // Exclude high outlier sales
          }
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

      // Final Buy Filter: Strictly requires 20+ sales within 3h AND 5+ unique wallets around floor
      const liquidityPassed = sales3Hours >= minSales && uniqueWallets3Hours >= minWallets;

      let liquidityReason = `Passed 3-hour native ETH floor liquidity check (${sales3Hours}/${minSales} sales, ${uniqueWallets3Hours}/${minWallets} unique wallets)`;
      if (!liquidityPassed) {
        liquidityReason = `Liquidity Check Failed: ${sales3Hours}/${minSales} floor sales in last 3h, ${uniqueWallets3Hours}/${minWallets} unique wallets (offer sales excluded).`;
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
      const res = await this.client.get(`/collections?chain=${chainSlug}&limit=30&order_by=one_day_volume`);
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
