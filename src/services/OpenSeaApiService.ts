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

      // Fees in basis points
      let openseaFeeBps = this.config.fees.openseaFeeBps;
      let royaltyFeeBps = this.config.fees.defaultRoyaltyBps;

      if (collectionData?.fees && Array.isArray(collectionData.fees)) {
        for (const f of collectionData.fees) {
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
      try {
        const statsRes = await this.client.get(`/collections/${collectionSlug}/stats`);
        const statsFloor = statsRes.data?.total?.floor_price;
        const symbol = statsRes.data?.total?.floor_price_symbol || 'ETH';
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
      let topOfferEth = 0.04; // Fallback
      try {
        const offersRes = await this.client.get(`/offers/collection/${collectionSlug}/all?limit=1`);
        const offers = offersRes.data?.offers || [];
        if (offers.length > 0) {
          const rawPrice = offers[0]?.price?.value;
          const decimals = offers[0]?.price?.decimals || 18;
          topOfferEth = parseFloat(rawPrice) / Math.pow(10, decimals);
        }
      } catch (err: any) {
        logger.debug(`Could not fetch active offers via API for ${collectionSlug}: ${err.message}`);
      }

      // 4. Fetch Liquidity Metrics
      const liquidity = await this.getCollectionLiquidity(collectionSlug);

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
        sales1Hour: liquidity.sales1Hour,
        uniqueWallets1Hour: liquidity.uniqueWallets1Hour,
        liquidityPassed: liquidity.liquidityPassed
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
        liquidityPassed: false
      };
    }
  }

  /**
   * Fetch 1-hour completed sales and unique wallets for liquidity verification
   */
  public async getCollectionLiquidity(collectionSlug: string): Promise<{
    sales1Hour: number;
    uniqueWallets1Hour: number;
    liquidityPassed: boolean;
  }> {
    const minSales = this.config.liquidity?.minSales1Hour ?? 1;
    const minWallets = this.config.liquidity?.minUniqueWallets1Hour ?? 1;
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

    try {
      let oneDaySales = 0;
      try {
        const statsRes = await this.client.get(`/collections/${collectionSlug}/stats`);
        oneDaySales = statsRes.data?.intervals?.find((i: any) => i.interval === 'one_day')?.sales || 0;
      } catch {}

      const res = await this.client.get(`/events/collection/${collectionSlug}?event_type=sale&limit=50`);
      const events = res.data?.asset_events || [];
      const sales1HourList = events.filter((e: any) => (e.event_timestamp || 0) >= oneHourAgo);

      const wallets = new Set<string>();
      for (const sale of sales1HourList) {
        if (sale.buyer) wallets.add(sale.buyer.toLowerCase());
        if (sale.seller) wallets.add(sale.seller.toLowerCase());
      }

      const sales1Hour = sales1HourList.length;
      const uniqueWallets1Hour = wallets.size;
      const liquidityPassed = (sales1Hour >= minSales && uniqueWallets1Hour >= minWallets) || (oneDaySales >= 3);

      return {
        sales1Hour: sales1Hour || oneDaySales,
        uniqueWallets1Hour: uniqueWallets1Hour || 1,
        liquidityPassed
      };
    } catch (err: any) {
      logger.warn({ slug: collectionSlug, error: err.message }, 'Failed to fetch liquidity from OpenSea');
      return {
        sales1Hour: 0,
        uniqueWallets1Hour: 0,
        liquidityPassed: false
      };
    }
  }

  /**
   * Post a signed collection offer order to OpenSea
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
   * Fetch NFTs currently owned by a wallet
   */
  public async getAccountNfts(walletAddress: string, collectionSlug?: string): Promise<any[]> {
    try {
      const url = collectionSlug 
        ? `/chain/ethereum/account/${walletAddress}/nfts?collection=${collectionSlug}&limit=50`
        : `/chain/ethereum/account/${walletAddress}/nfts?limit=50`;
      const res = await this.client.get(url);
      return res.data?.nfts || [];
    } catch (err: any) {
      logger.debug(`Could not fetch NFTs for ${walletAddress}: ${err.message}`);
      return [];
    }
  }

  /**
   * Dynamically discovers active collections with floor prices between minFloorUsd and maxFloorUsd on a given network
   */
  public async discoverCollectionsByChain(
    networkKey: string,
    minFloorUsd: number = 2.0,
    maxFloorUsd: number = 10.0
  ): Promise<any[]> {
    const chainSlug = networkKey === 'robinhood' ? 'robinhood' : 'ethereum';
    const ethPriceUsd = await this.getEthPriceUsd();
    const discovered: any[] = [];

    try {
      const res = await this.client.get(`/collections?chain=${chainSlug}&limit=50`);
      const collections = res.data?.collections || [];

      for (const col of collections) {
        if (!col.collection_offers_enabled || col.is_disabled) continue;
        const contract = col.contracts?.find((c: any) => c.chain === chainSlug)?.address || col.contracts?.[0]?.address;
        if (!contract) continue;

        try {
          const statsRes = await this.client.get(`/collections/${col.collection}/stats`);
          const floor = statsRes.data?.total?.floor_price;
          const symbol = statsRes.data?.total?.floor_price_symbol || 'ETH';
          const oneDaySales = statsRes.data?.intervals?.find((i: any) => i.interval === 'one_day')?.sales || 0;

          if (floor !== undefined && floor !== null && (symbol === 'ETH' || symbol === 'WETH')) {
            const floorUsd = floor * ethPriceUsd;
            if (floorUsd >= minFloorUsd && floorUsd <= maxFloorUsd && oneDaySales >= 1) {
              logger.info(
                {
                  name: col.name,
                  slug: col.collection,
                  network: networkKey,
                  floorEth: floor,
                  floorUsd: `$${floorUsd.toFixed(2)}`,
                  oneDaySales
                },
                `Dynamic Discovery: Found active ${networkKey.toUpperCase()} collection ($${minFloorUsd}-$${maxFloorUsd})`
              );
              discovered.push({
                name: col.name,
                slug: col.collection,
                contractAddress: contract,
                network: networkKey,
                floorEth: floor,
                floorUsd,
                oneDaySales
              });
            }
          }
        } catch {
          // Skip on error
        }
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
