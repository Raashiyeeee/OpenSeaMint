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
    const allOwnedNfts: any[] = [];
    const ethPriceUsd = await this.apiService.getEthPriceUsd();
    // If holdings could not be fully read on ANY network, ownership is unknown: skip reconciliation this cycle
    let holdingsComplete = true;

    for (const net of activeNetworks) {
      try {
        const ownedNfts = await this.apiService.getAccountNfts(walletAddress, undefined, net);
        if (ownedNfts === null) {
          holdingsComplete = false;
          logger.warn({ net }, 'Wallet holdings unavailable on this network. Skipping sale/transfer reconciliation this cycle.');
          continue;
        }
        for (const nft of ownedNfts) {
          allOwnedNfts.push(nft);
          const contractAddress = nft.contract;
          const tokenId = nft.identifier;
          const slug = nft.collection || '';
          if (!contractAddress || !tokenId) continue;

          const identifier = `${contractAddress.toLowerCase()}:${tokenId}`;
          const ignored = this.config.general.ignoredCollections || ['robin-owls', 'robin-owls-269031093'];
          if (ignored.some((i) => slug.toLowerCase().includes(i.toLowerCase()) || contractAddress.toLowerCase().includes(i.toLowerCase()))) {
            continue;
          }

          const existing = this.inventoryManager.getInventoryItem(identifier);
          if (!existing) {
            logger.info({ identifier, slug, net }, 'Discovered unlisted NFT in wallet during scan. Adding to relist queue!');
            let acquiredPriceEth = 0.0004;
            // A FULFILLED bot offer matching this NFT means the bot bought it: track as bot-acquired (counts toward capital)
            const fulfilledOffer = this.inventoryManager.consumeFulfilledOffer(contractAddress, tokenId);
            const matchingOffer = fulfilledOffer || this.inventoryManager.getActiveOffer(slug);
            if (matchingOffer && matchingOffer.priceEth > 0) {
              acquiredPriceEth = matchingOffer.priceEth;
            } else {
              try {
                const marketData = await this.apiService.getCollectionMarketData(slug, contractAddress);
                acquiredPriceEth = marketData.topOfferEth > 0 ? marketData.topOfferEth : (marketData.floorPriceEth * 0.85);
              } catch {}
            }

            const newItem: InventoryItem = {
              identifier,
              collectionSlug: slug,
              contractAddress,
              tokenId,
              network: net,
              acquiredPriceEth,
              acquiredPriceUsd: fulfilledOffer ? fulfilledOffer.priceUsd : undefined,
              acquiredAtTimestamp: Date.now(),
              status: 'PENDING_LISTING',
              isExternalWalletItem: !fulfilledOffer
            };
            this.inventoryManager.addInventoryItem(newItem);
          } else if (existing.status === 'HOLDING' && existing.acquiredPriceEth >= 0.003 && net === 'robinhood') {
            // Sanitize previously corrupted fallback prices
            const matchingOffer = this.inventoryManager.getActiveOffer(slug);
            if (matchingOffer && matchingOffer.priceEth > 0) {
              existing.acquiredPriceEth = matchingOffer.priceEth;
              existing.status = 'PENDING_LISTING';
            }
          }
        }
      } catch (err: any) {
        logger.debug({ net, err: err.message }, 'Wallet NFT scan note');
      }
    }

    // Reconcile wallet holdings: an NFT that left the wallet is treated as SOLD only when a confirmed sale event
    // (seller = our wallet) exists. Plain transfers keep the re-offer block and never trigger a WETH wrap.
    const soldItems: Array<{ identifier: string; network?: string; netProceedsEth: number; soldEth: number }> = [];
    if (holdingsComplete) {
      const missing = this.inventoryManager.getItemsMissingFromWallet(allOwnedNfts);
      const confirmedSales = new Map<string, { salePriceEth: number; txHash?: string }>();
      const stillUnknown: Array<{ contract: string; identifier: string }> = [];
      for (const item of missing) {
        const sale = await this.apiService.getConfirmedNftSale(
          item.contractAddress,
          item.tokenId,
          walletAddress,
          item.network || this.config.general.network || 'robinhood',
          item.acquiredAtTimestamp ? item.acquiredAtTimestamp / 1000 : undefined
        );
        if (sale === undefined) {
          // Could not check: treat as still owned this cycle (neither sold nor transferred)
          stillUnknown.push({ contract: item.contractAddress, identifier: item.tokenId });
        } else if (sale) {
          confirmedSales.set(item.identifier.toLowerCase(), { salePriceEth: sale.salePriceEth, txHash: sale.txHash });
        }
      }
      soldItems.push(...this.inventoryManager.reconcileWalletInventory([...allOwnedNfts, ...stillUnknown], ethPriceUsd, confirmedSales));
    }
    for (const sold of soldItems) {
      const net = sold.network || this.config.general.network || 'robinhood';
      logger.info(
        { identifier: sold.identifier, network: net, netProceedsEth: sold.netProceedsEth },
        'NFT SALE CONFIRMED (RECONCILIATION): Automatically converting 90% of received ETH into WETH (10% held for gas reserve)...'
      );
      try {
        await this.seaportService.handlePostSaleEthConversion(sold.netProceedsEth, net);
      } catch (err: any) {
        logger.error({ identifier: sold.identifier, err: err.message }, 'Failed to convert received ETH to WETH');
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
    const ignored = this.config.general.ignoredCollections || ['robin-owls', 'robin-owls-269031093'];
    if (ignored.some((i) => item.collectionSlug.toLowerCase().includes(i.toLowerCase()) || item.contractAddress.toLowerCase().includes(i.toLowerCase()))) {
      item.status = 'ERROR';
      item.holdReason = 'Skipped: Collection configured in ignoredCollections';
      logger.info({ identifier: item.identifier, slug: item.collectionSlug }, 'Skipping excluded collection from relisting');
      return;
    }

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

    // 4.5. Mandatory Creator Fee Disable Rule:
    // If the creator fee is optional and can be disabled, the bot must disable it before executing any NFT sale.
    // The bot must verify that the fee is disabled before proceeding with the sale.
    const preSaleFeeVerification = this.seaportService.verifyCreatorFeeDisabledBeforeSale(
      orderComponents.consideration,
      marketData.fees
    );
    if (!preSaleFeeVerification.verified) {
      logger.error(
        { identifier: item.identifier, reason: preSaleFeeVerification.reason },
        'MANDATORY CREATOR FEE DISABLE RULE: Aborting NFT sale execution because optional creator fee is not disabled!'
      );
      throw new Error(`NFT sale execution aborted: ${preSaleFeeVerification.reason}`);
    }

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
