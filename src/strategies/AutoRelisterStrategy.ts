import { BotConfig, InventoryItem } from '../types';
import { OpenSeaApiService } from '../services/OpenSeaApiService';
import { PricingEngine } from '../services/PricingEngine';
import { SeaportService } from '../services/SeaportService';
import { InventoryManager } from '../services/InventoryManager';
import { CircuitBreaker } from '../security/CircuitBreaker';
import { logger } from '../utils/logger';

export class AutoRelisterStrategy {
  private config: BotConfig;
  private apiService: OpenSeaApiService;
  private pricingEngine: PricingEngine;
  private seaportService: SeaportService;
  private inventoryManager: InventoryManager;
  private circuitBreaker: CircuitBreaker;

  constructor(
    config: BotConfig,
    apiService: OpenSeaApiService,
    pricingEngine: PricingEngine,
    seaportService: SeaportService,
    inventoryManager: InventoryManager,
    circuitBreaker: CircuitBreaker
  ) {
    this.config = config;
    this.apiService = apiService;
    this.pricingEngine = pricingEngine;
    this.seaportService = seaportService;
    this.inventoryManager = inventoryManager;
    this.circuitBreaker = circuitBreaker;
  }

  /**
   * Called immediately when a new NFT is received in the trading wallet
   */
  public async handleItemAcquired(
    collectionSlug: string,
    contractAddress: string,
    tokenId: string,
    acquiredPriceEth: number
  ): Promise<void> {
    const identifier = `${contractAddress.toLowerCase()}:${tokenId}`;
    logger.info({ identifier, acquiredPriceEth }, 'Triggering automated relist routine for newly acquired NFT');

    const item: InventoryItem = {
      identifier,
      collectionSlug,
      contractAddress,
      tokenId,
      acquiredPriceEth,
      acquiredAtTimestamp: Date.now(),
      status: 'PENDING_LISTING'
    };

    this.inventoryManager.addInventoryItem(item);

    try {
      await this.relistItem(item);
    } catch (err: any) {
      logger.error({ identifier, error: err.message }, 'Failed to automatically relist item');
      this.circuitBreaker.registerError(`Relist ${identifier}`, err);
    }
  }

  /**
   * Scans unlisted inventory and creates competitive listing orders
   */
  public async scanAndRelistUnlistedInventory(walletAddress: string): Promise<void> {
    // 1. Reconcile on-chain wallet inventory directly from OpenSea across all active networks
    const activeNetworks = this.config.general.activeNetworks || ['robinhood'];
    for (const net of activeNetworks) {
      try {
        const ownedNfts = await this.apiService.getAccountNfts(walletAddress, undefined, net);
        for (const nft of ownedNfts) {
          const contractAddress = nft.contract;
          const tokenId = nft.identifier;
          const slug = nft.collection || '';
          if (!contractAddress || !tokenId) continue;

          const identifier = `${contractAddress.toLowerCase()}:${tokenId}`;
          const existing = this.inventoryManager.getInventoryItem(identifier);
          if (!existing) {
            logger.info({ identifier, slug, net }, 'Discovered unlisted NFT in wallet during scan. Adding to relist queue!');
            let acquiredPriceEth = 0.0006; // Default to typical buy offer
            try {
              const marketData = await this.apiService.getCollectionMarketData(slug, contractAddress);
              acquiredPriceEth = marketData.topOfferEth > 0 ? marketData.topOfferEth : (marketData.floorPriceEth * 0.85);
            } catch {}

            const newItem: InventoryItem = {
              identifier,
              collectionSlug: slug,
              contractAddress,
              tokenId,
              network: net,
              acquiredPriceEth,
              acquiredAtTimestamp: Date.now(),
              status: 'PENDING_LISTING',
              isExternalWalletItem: true
            };
            this.inventoryManager.addInventoryItem(newItem);
          }
        }
      } catch (err: any) {
        logger.debug({ net, err: err.message }, 'Wallet NFT scan note');
      }
    }

    // 2. Relist all unlisted or held items in inventory
    const unlisted = this.inventoryManager
      .getAllInventory()
      .filter((i) => i.status === 'PENDING_LISTING' || i.status === 'HOLDING');

    for (const item of unlisted) {
      try {
        await this.relistItem(item);
      } catch (err: any) {
        logger.error({ identifier: item.identifier, error: err.message }, 'Error during unlisted inventory relist scan');
      }
    }
  }

  private async relistItem(item: InventoryItem): Promise<void> {
    // 1. Fetch current collection floor & fees
    const marketData = await this.apiService.getCollectionMarketData(
      item.collectionSlug,
      item.contractAddress
    );

    // 2. Find target collection configuration if exists
    const targetConfig = this.config.targetCollections.find(
      (c) => c.slug.toLowerCase() === item.collectionSlug.toLowerCase()
    );
    const targetProfitUsd = targetConfig?.targetNetProfitUsd || this.config.profitTargets.defaultMinNetProfitUsd;

    // 3. Evaluate listing vs holding (Rule 8: Floor Dump Protection & Rule 6: No Loss Selling)
    const listingEval = this.pricingEngine.evaluateListingOrHold(
      item.acquiredPriceEth,
      marketData.floorPriceEth,
      {
        openseaFeeBps: marketData.openseaFeeBps,
        royaltyFeeBps: marketData.royaltyFeeBps,
        ethPriceUsd: marketData.ethPriceUsd
      },
      targetProfitUsd
    );

    if (listingEval.action === 'HOLD') {
      logger.warn(
        { identifier: item.identifier, reason: listingEval.reason },
        'Floor Dump Protection active: Holding NFT to prevent loss sale'
      );
      this.inventoryManager.updateHoldStatus(item.identifier, listingEval.reason);
      return;
    }

    const listPriceEth = listingEval.recommendedListPriceEth!;
    const expectedNetProfitUsd = listingEval.expectedNetProfitUsd!;

    logger.info(
      {
        identifier: item.identifier,
        acquiredPriceEth: item.acquiredPriceEth,
        listPriceEth,
        expectedNetProfitUsd,
        minProfitablePriceEth: listingEval.minProfitablePriceEth
      },
      'Market supports profitable sale: Listing NFT on OpenSea'
    );

    const activeNets = this.config.general.activeNetworks || ['robinhood'];
    const chainSlug = this.config.general.network 
      || (activeNets.includes('robinhood') && !activeNets.includes('mainnet') ? 'robinhood' : 'ethereum');

    // 3.5. Ensure on-chain ERC721 conduit approval is active
    await this.seaportService.ensureNftConduitApproval(item.contractAddress, chainSlug);

    // 4. Create and sign Seaport listing (off-chain EIP-712 with required fee recipients)
    const { orderComponents, signature } = await this.seaportService.createSignedListing(
      item.contractAddress,
      item.tokenId,
      listPriceEth,
      marketData.openseaFeeBps,
      this.config.general.listingExpirationDays,
      chainSlug,
      marketData.fees
    );

    // 5. Submit listing order to OpenSea
    const postPayload = {
      parameters: orderComponents,
      signature,
      protocol_address: this.config.seaport.contractAddress
    };

    try {
      const res = await this.apiService.postListing(chainSlug, postPayload);

      // 6. Update inventory tracking
      const listPriceUsd = listPriceEth * (marketData.ethPriceUsd || 2700);
      this.inventoryManager.updateListingStatus(
        item.identifier,
        listPriceEth,
        res?.order_hash || `sim_list_${Date.now()}`,
        listPriceUsd
      );

      this.circuitBreaker.registerSuccess();
    } catch (err: any) {
      if (err.message?.includes('enforcement restrictions') || err.message?.includes('Validation error')) {
        item.status = 'ERROR';
        item.holdReason = 'Listing restricted by OpenSea (enforcement restrictions)';
        logger.warn(
          { identifier: item.identifier, slug: item.collectionSlug, error: err.message },
          'OpenSea has active enforcement restrictions on this collection. Item marked as ERROR and excluded from relist queue.'
        );
        return;
      }
      throw err;
    }
  }
}
