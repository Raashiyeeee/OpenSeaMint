import { BotConfig, InventoryItem, ActiveOffer } from '../types';
import { roundToPrecision } from '../utils/math';
import { logger } from '../utils/logger';

export class InventoryManager {
  private config: BotConfig;
  private inventory: Map<string, InventoryItem> = new Map();
  private activeOffers: Map<string, ActiveOffer> = new Map();
  private totalCapitalUsd: number;
  private cumulativeProfitUsd: number = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.totalCapitalUsd = config.capital?.totalTradingCapitalUsd ?? 10.0;
  }

  public getTotalCapitalUsd(): number {
    return roundToPrecision(this.totalCapitalUsd + this.cumulativeProfitUsd, 2);
  }

  /**
   * Returns capital currently allocated/locked in:
   * 1. Active unexpired collection offers
   * 2. Held NFT inventory (pending listing or currently listed)
   */
  public getAllocatedCapitalUsd(ethPriceUsd: number = 2700): number {
    this.cleanupExpiredOffers();

    let allocatedUsd = 0;

    // Capital committed to active offers
    for (const offer of this.activeOffers.values()) {
      if (offer.status === 'ACTIVE' && offer.expiresTimestamp > Date.now()) {
        allocatedUsd += offer.priceUsd || (offer.priceEth * ethPriceUsd);
      }
    }

    // Capital locked in acquired inventory awaiting sale
    for (const item of this.inventory.values()) {
      if (item.status === 'PENDING_LISTING' || item.status === 'LISTED' || item.status === 'HOLDING') {
        if (!item.isExternalWalletItem) {
          allocatedUsd += item.acquiredPriceUsd || (item.acquiredPriceEth * ethPriceUsd);
        }
      }
    }

    return roundToPrecision(allocatedUsd, 2);
  }

  /**
   * Returns unallocated capital available for new trades.
   */
  /**
   * Returns unallocated capital available for new trades.
   */
  public getAvailableCapitalUsd(ethPriceUsd: number = 2700): number {
    const total = this.getTotalCapitalUsd();
    const allocated = this.getAllocatedCapitalUsd(ethPriceUsd);
    return roundToPrecision(Math.max(0, total - allocated), 2);
  }

  /**
   * Returns capital committed across all currently active, unexpired offers.
   */
  public getActiveOffersCapitalUsd(ethPriceUsd: number = 2700): number {
    this.cleanupExpiredOffers();
    let sumUsd = 0;
    for (const offer of this.activeOffers.values()) {
      if (offer.status === 'ACTIVE' && offer.expiresTimestamp > Date.now()) {
        sumUsd += offer.priceUsd || (offer.priceEth * ethPriceUsd);
      }
    }
    return roundToPrecision(sumUsd, 2);
  }

  /**
   * Evaluates if capital can be allocated for an offer under the active-offer capital rule:
   * Use up to 60% of total capital for simultaneous offers across every qualifying NFT.
   * The number of NFTs is unlimited by count; it is limited only by the active-offer capital allocation.
   */
  public canAllocateCapitalForOffer(
    requiredCapitalUsd: number,
    ethPriceUsd: number = 2700
  ): { allowed: boolean; reason?: string } {
    const totalCapital = this.getTotalCapitalUsd();
    const offerCapitalLimitPercent = this.config.capital?.maxOfferCapitalPercent ?? 60.0;
    const maxActiveOfferCapitalUsd = roundToPrecision(totalCapital * (offerCapitalLimitPercent / 100), 2);

    const currentOffersUsd = this.getActiveOffersCapitalUsd(ethPriceUsd);
    if (currentOffersUsd + requiredCapitalUsd > maxActiveOfferCapitalUsd) {
      return {
        allowed: false,
        reason: `Active-offer capital allocation limit reached: Current active offers $${currentOffersUsd.toFixed(2)} + new offer $${requiredCapitalUsd.toFixed(2)} exceeds ${offerCapitalLimitPercent}% allocation limit ($${maxActiveOfferCapitalUsd.toFixed(2)} of $${totalCapital.toFixed(2)} total capital).`
      };
    }

    const availableCapital = this.getAvailableCapitalUsd(ethPriceUsd);
    if (requiredCapitalUsd > availableCapital) {
      return {
        allowed: false,
        reason: `Insufficient available capital: Required $${requiredCapitalUsd.toFixed(2)}, Available $${availableCapital.toFixed(2)} (Total $${totalCapital.toFixed(2)}).`
      };
    }

    return { allowed: true };
  }

  /**
   * Checks if bot has room for another trade and sufficient available capital.
   */
  public canAllocateCapital(requiredCapitalUsd: number, ethPriceUsd: number = 2700): { allowed: boolean; reason?: string } {
    const maxTrades = this.config.capital?.maxActiveTrades ?? 999;
    const activeTradesCount = this.getActiveTradesCount();

    if (activeTradesCount >= maxTrades) {
      return {
        allowed: false,
        reason: `Maximum active trades limit (${maxTrades}) reached.`
      };
    }

    const availableCapital = this.getAvailableCapitalUsd(ethPriceUsd);
    if (requiredCapitalUsd > availableCapital) {
      return {
        allowed: false,
        reason: `Insufficient capital: Required $${requiredCapitalUsd.toFixed(2)}, Available $${availableCapital.toFixed(2)} (Total $${this.getTotalCapitalUsd().toFixed(2)})`
      };
    }

    return { allowed: true };
  }

  /**
   * Reconciles in-memory inventory against on-chain wallet items.
   * If an NFT held in inventory is no longer present in wallet, it was sold or transferred.
   * Automatically clears it and releases the committed capital.
   */
  public reconcileWalletInventory(
    ownedNfts: Array<{ contract?: string; identifier?: string }>,
    ethPriceUsd: number = 2700
  ): string[] {
    const ownedSet = new Set(
      ownedNfts
        .filter((n) => n.contract && n.identifier)
        .map((n) => `${n.contract!.toLowerCase()}:${n.identifier}`)
    );

    const itemsToCheck = Array.from(this.inventory.values());
    const removedIdentifiers: string[] = [];

    for (const item of itemsToCheck) {
      if (item.status !== 'SOLD' && !ownedSet.has(item.identifier.toLowerCase())) {
        logger.info(
          { identifier: item.identifier, collectionSlug: item.collectionSlug, status: item.status },
          'Wallet reconciliation: NFT is no longer in wallet (sold or transferred). Clearing from inventory and releasing capital.'
        );
        this.markItemSold(item.identifier, undefined, ethPriceUsd);
        removedIdentifiers.push(item.identifier);
      }
    }
    return removedIdentifiers;
  }

  public getActiveTradesCount(): number {
    this.cleanupExpiredOffers();
    let count = 0;
    for (const offer of this.activeOffers.values()) {
      if (offer.status === 'ACTIVE' && offer.expiresTimestamp > Date.now()) {
        count++;
      }
    }
    for (const item of this.inventory.values()) {
      if (item.status === 'PENDING_LISTING' || item.status === 'LISTED' || item.status === 'HOLDING') {
        if (!item.isExternalWalletItem) {
          count++;
        }
      }
    }
    return count;
  }

  public getInventoryItem(identifier: string): InventoryItem | undefined {
    return this.inventory.get(identifier);
  }

  public addInventoryItem(item: InventoryItem): void {
    // When an item is acquired from an offer, mark matching offer as FULFILLED
    const offer = this.activeOffers.get(item.collectionSlug);
    if (offer && offer.status === 'ACTIVE') {
      offer.status = 'FULFILLED';
    }

    this.inventory.set(item.identifier, item);
    logger.info(
      {
        identifier: item.identifier,
        acquiredPriceEth: item.acquiredPriceEth,
        acquiredPriceUsd: item.acquiredPriceUsd
      },
      'Acquired NFT! Added to inventory, capital remains committed until sold'
    );
  }

  public updateListingStatus(identifier: string, listPriceEth: number, orderId: string, listPriceUsd?: number): void {
    const item = this.inventory.get(identifier);
    if (item) {
      item.currentListingPriceEth = listPriceEth;
      item.currentListingPriceUsd = listPriceUsd;
      item.listingOrderId = orderId;
      item.status = 'LISTED';
      logger.info({ identifier, listPriceEth, listPriceUsd }, 'Item listed on OpenSea');
    }
  }

  public updateHoldStatus(identifier: string, holdReason: string): void {
    const item = this.inventory.get(identifier);
    if (item) {
      item.status = 'HOLDING';
      item.holdReason = holdReason;
      logger.info({ identifier, holdReason }, 'Item held in inventory due to Floor Dump Protection');
    }
  }

  /**
   * Called when an NFT sells on OpenSea.
   * Releases capital and computes realized profit.
   */
  public markItemSold(
    identifier: string,
    salePriceEth?: number,
    ethPriceUsd: number = 2700,
    feeBps: number = 100, // Combined OpenSea + royalty bps
    gasUsd: number = 0.01
  ): { realizedProfitUsd: number; newTotalCapitalUsd: number } {
    const item = this.inventory.get(identifier);
    let realizedProfitUsd = 0;

    if (item) {
      item.status = 'SOLD';
      const soldEth = salePriceEth ?? item.currentListingPriceEth ?? item.acquiredPriceEth;
      const acquiredEth = item.acquiredPriceEth;

      const feeEth = soldEth * (feeBps / 10000);
      const gasEth = gasUsd / ethPriceUsd;
      const profitEth = soldEth - feeEth - acquiredEth - gasEth;
      realizedProfitUsd = roundToPrecision(profitEth * ethPriceUsd, 2);

      this.cumulativeProfitUsd += realizedProfitUsd;
      item.realizedProfitUsd = realizedProfitUsd;
      item.salePriceEth = soldEth;
      item.salePriceUsd = roundToPrecision(soldEth * ethPriceUsd, 2);

      this.inventory.delete(identifier);

      logger.info(
        {
          identifier,
          soldEth,
          acquiredEth,
          realizedProfitUsd,
          newTotalCapitalUsd: this.getTotalCapitalUsd()
        },
        'NFT Sold! Capital released and profit added to trading balance.'
      );
    }

    return {
      realizedProfitUsd,
      newTotalCapitalUsd: this.getTotalCapitalUsd()
    };
  }

  public getInventoryCount(collectionSlug?: string): number {
    let count = 0;
    for (const item of this.inventory.values()) {
      if (item.status !== 'SOLD') {
        if (!collectionSlug || item.collectionSlug === collectionSlug) {
          count++;
        }
      }
    }
    return count;
  }

  public canBidOnCollection(collectionSlug: string, maxAllowedPerCollection: number = 10): boolean {
    const currentCount = this.getInventoryCount(collectionSlug);
    if (currentCount >= maxAllowedPerCollection) {
      logger.debug({ collectionSlug, currentCount, maxAllowedPerCollection }, 'Collection inventory cap reached. Skipping new offers.');
      return false;
    }
    const totalCount = this.getInventoryCount();
    const maxTotalItems = this.config.riskManagement?.maxTotalInventoryItems ?? 999;
    if (totalCount >= maxTotalItems) {
      logger.warn({ totalCount, maxTotalItems }, 'Total bot inventory cap reached. Skipping new offers.');
      return false;
    }
    return true;
  }

  public registerActiveOffer(offer: ActiveOffer): void {
    this.activeOffers.set(offer.collectionSlug, offer);
    logger.info(
      {
        collection: offer.collectionSlug,
        priceEth: offer.priceEth,
        priceUsd: offer.priceUsd,
        expiresInMinutes: this.config.general.offerExpirationMinutes
      },
      'Active offer registered. Capital is now locked to this trade.'
    );
  }

  public getActiveOffer(collectionSlug: string): ActiveOffer | undefined {
    this.cleanupExpiredOffers();
    return this.activeOffers.get(collectionSlug);
  }

  public cleanupExpiredOffers(): void {
    const now = Date.now();
    for (const [slug, offer] of this.activeOffers.entries()) {
      if (offer.status === 'ACTIVE' && offer.expiresTimestamp <= now) {
        offer.status = 'EXPIRED';
        this.activeOffers.delete(slug);
        logger.info({ collectionSlug: slug }, 'Offer expired. Capital released back to pool.');
      }
    }
  }

  public getAllInventory(): InventoryItem[] {
    return Array.from(this.inventory.values());
  }

  public cancelActiveOffer(collectionSlug: string): void {
    const offer = this.activeOffers.get(collectionSlug);
    if (offer) {
      offer.status = 'CANCELLED';
      this.activeOffers.delete(collectionSlug);
      logger.info({ collectionSlug }, 'Offer cancelled. Capital released.');
    }
  }
}
