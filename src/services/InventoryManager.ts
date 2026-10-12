import { BotConfig, InventoryItem, ActiveOffer, TrackedNft, NftSaleConfirmation } from '../types';
import { roundToPrecision } from '../utils/math';
import { logger } from '../utils/logger';

export class InventoryManager {
  private config: BotConfig;
  private inventory: Map<string, InventoryItem> = new Map();
  private activeOffers: Map<string, ActiveOffer> = new Map();
  private trackedNfts: Map<string, TrackedNft> = new Map();
  private totalCapitalUsd: number;
  private cumulativeProfitUsd: number = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.totalCapitalUsd = config.capital?.totalTradingCapitalUsd ?? 10.0;
  }

  public getTotalCapitalUsd(): number {
    return roundToPrecision(this.totalCapitalUsd + this.cumulativeProfitUsd, 2);
  }

  private getNftKey(contractAddress: string, tokenId: string): string {
    return `${contractAddress.toLowerCase()}:${tokenId}`;
  }

  /**
   * Returns capital currently allocated/locked in:
   * 1. Active unexpired collection or item offers
   * 2. Held NFT inventory (pending listing or currently listed)
   */
  public getAllocatedCapitalUsd(ethPriceUsd: number = 2700): number {
    this.cleanupExpiredOffers();

    let allocatedUsd = 0;

    // Capital committed to active offers or unverified cancellations (must not assume capital released!)
    for (const offer of this.activeOffers.values()) {
      const locksCapital =
        offer.status === 'ACTIVE' ||
        offer.status === 'CANCELLATION_PENDING' ||
        offer.status === 'CANCELLATION_FAILED' ||
        (offer.status === 'CANCELLED' && !offer.cancellationVerified);
      if (locksCapital) {
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
  public getAvailableCapitalUsd(ethPriceUsd: number = 2700): number {
    const total = this.getTotalCapitalUsd();
    const allocated = this.getAllocatedCapitalUsd(ethPriceUsd);
    return roundToPrecision(Math.max(0, total - allocated), 2);
  }

  /**
   * Returns capital committed across all currently active offers and unverified cancellations.
   * Under the 20-minute rule, capital remains committed until cancellation is verified.
   */
  public getActiveOffersCapitalUsd(ethPriceUsd: number = 2700): number {
    this.cleanupExpiredOffers();
    let sumUsd = 0;
    for (const offer of this.activeOffers.values()) {
      const locksCapital =
        offer.status === 'ACTIVE' ||
        offer.status === 'CANCELLATION_PENDING' ||
        offer.status === 'CANCELLATION_FAILED' ||
        (offer.status === 'CANCELLED' && !offer.cancellationVerified);
      if (locksCapital) {
        sumUsd += offer.priceUsd || (offer.priceEth * ethPriceUsd);
      }
    }
    return roundToPrecision(sumUsd, 2);
  }

  /**
   * Evaluates if capital can be allocated for an offer under the active-offer capital rule:
   * Comply with the configured 60% capital allocation limit for simultaneous active offers.
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
      const locksCapital =
        offer.status === 'ACTIVE' ||
        offer.status === 'CANCELLATION_PENDING' ||
        offer.status === 'CANCELLATION_FAILED' ||
        (offer.status === 'CANCELLED' && !offer.cancellationVerified);
      if (locksCapital) {
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

  /**
   * Independent NFT Tracking: Get tracked NFT details
   */
  public getTrackedNft(contractAddress: string, tokenId: string): TrackedNft | undefined {
    return this.trackedNfts.get(this.getNftKey(contractAddress, tokenId));
  }

  public getTrackedNftByIdentifier(identifier: string): TrackedNft | undefined {
    return this.trackedNfts.get(identifier.toLowerCase());
  }

  public getAllTrackedNfts(): TrackedNft[] {
    return Array.from(this.trackedNfts.values());
  }

  /**
   * Checks whether the bot currently owns or holds an unresolved trade position on an NFT.
   */
  public isNftOwnedOrUnresolved(contractAddress: string, tokenId: string): boolean {
    const key = this.getNftKey(contractAddress, tokenId);
    const item = this.inventory.get(key);
    if (item && item.status !== 'SOLD') {
      return true;
    }
    const tracked = this.trackedNfts.get(key);
    if (tracked) {
      if (tracked.ownershipStatus === 'OWNED' || tracked.ownershipStatus === 'UNRESOLVED') {
        return true;
      }
      if (tracked.listingStatus === 'PENDING_LISTING' || tracked.listingStatus === 'LISTED' || tracked.listingStatus === 'HOLDING') {
        return true;
      }
      if (!tracked.saleConfirmation?.confirmed && tracked.ownershipStatus !== 'NONE' && tracked.ownershipStatus !== 'SOLD') {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks whether a confirmed sale has been recorded for this NFT.
   */
  public isNftSaleConfirmed(contractAddress: string, tokenId: string): boolean {
    const key = this.getNftKey(contractAddress, tokenId);
    const tracked = this.trackedNfts.get(key);
    return tracked?.saleConfirmation?.confirmed === true;
  }

  /**
   * Core Rule 1 & 2: Same NFT Re-Bidding Restriction & No Re-Bidding Before Sale
   * 1. Once an offer is accepted and the bot acquires an NFT, the bot must not place
   *    another offer on that same NFT while it is owned or while the previous trade remains unresolved.
   * 2. The bot must never place another offer on the same NFT before the previously acquired NFT
   *    has been sold and the sale has been confirmed.
   * 3. After that NFT is successfully sold and confirmed, re-bidding is allowed only if all
   *    eligibility, native ETH floor-sale, pricing, and profitability criteria are satisfied again.
   */
  public canPlaceOfferOnNft(
    contractAddress: string,
    tokenId: string,
    offerPriceUsd?: number,
    ethPriceUsd: number = 2700
  ): { allowed: boolean; reason?: string } {
    const key = this.getNftKey(contractAddress, tokenId);

    // 1. Same NFT Re-Bidding Restriction & No Re-Bidding Before Sale
    if (this.isNftOwnedOrUnresolved(contractAddress, tokenId)) {
      const tracked = this.trackedNfts.get(key);
      const inv = this.inventory.get(key);
      const ownership = tracked?.ownershipStatus || inv?.ownershipStatus || 'OWNED';
      const listing = tracked?.listingStatus || inv?.listingStatus || inv?.status || 'PENDING_LISTING';
      return {
        allowed: false,
        reason: `Same NFT Re-Bidding Restriction: NFT ${key} is currently owned / previous trade remains unresolved (ownership: ${ownership}, listing: ${listing}). Cannot place another offer before sale confirmation.`
      };
    }

    // 2. Active Offer Check on this exact NFT
    if (this.hasActiveOfferOnNft(contractAddress, tokenId)) {
      return {
        allowed: false,
        reason: `Active offer already in place for NFT ${key}. Cannot place duplicate offer before resolution.`
      };
    }

    // 3. Comply with configured 60% capital allocation limit
    if (offerPriceUsd !== undefined && offerPriceUsd > 0) {
      const capitalCheck = this.canAllocateCapitalForOffer(offerPriceUsd, ethPriceUsd);
      if (!capitalCheck.allowed) {
        return capitalCheck;
      }
    }

    return { allowed: true };
  }

  /**
   * Adds newly acquired NFT to inventory and records independent NFT tracking.
   */
  public addInventoryItem(item: InventoryItem): void {
    const key = item.identifier.toLowerCase();

    // Mark matching active offer as FULFILLED
    const offerBySlug = this.activeOffers.get(item.collectionSlug);
    if (offerBySlug && offerBySlug.status === 'ACTIVE') {
      offerBySlug.status = 'FULFILLED';
    }

    // Also fulfill active offer matching this token
    for (const off of this.activeOffers.values()) {
      if (
        off.status === 'ACTIVE' &&
        off.contractAddress.toLowerCase() === item.contractAddress.toLowerCase() &&
        (!off.tokenId || off.tokenId === item.tokenId)
      ) {
        off.status = 'FULFILLED';
      }
    }

    item.ownershipStatus = 'OWNED';
    item.listingStatus = 'PENDING_LISTING';
    item.saleConfirmation = undefined;
    this.inventory.set(item.identifier, item);

    // Independent NFT tracking record
    let tracked = this.trackedNfts.get(key);
    if (!tracked) {
      tracked = {
        identifier: key,
        tokenId: item.tokenId,
        collectionSlug: item.collectionSlug,
        contractAddress: item.contractAddress,
        network: item.network,
        name: item.name,
        ownershipStatus: 'OWNED',
        listingStatus: 'PENDING_LISTING',
        activeOffers: [],
        acquiredPriceEth: item.acquiredPriceEth,
        acquiredPriceUsd: item.acquiredPriceUsd,
        acquiredAtTimestamp: item.acquiredAtTimestamp
      };
      this.trackedNfts.set(key, tracked);
    } else {
      tracked.ownershipStatus = 'OWNED';
      tracked.listingStatus = 'PENDING_LISTING';
      tracked.saleConfirmation = undefined;
      tracked.acquiredPriceEth = item.acquiredPriceEth;
      tracked.acquiredPriceUsd = item.acquiredPriceUsd;
      tracked.acquiredAtTimestamp = item.acquiredAtTimestamp;
      tracked.activeOffers = tracked.activeOffers.filter((o) => o.status === 'ACTIVE' && o.expiresTimestamp > Date.now());
    }

    logger.info(
      {
        identifier: item.identifier,
        tokenId: item.tokenId,
        collection: item.collectionSlug,
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
      item.listingStatus = 'LISTED';
      logger.info({ identifier, listPriceEth, listPriceUsd }, 'Item listed on OpenSea');
    }

    const tracked = this.trackedNfts.get(identifier.toLowerCase());
    if (tracked) {
      tracked.listingStatus = 'LISTED';
      tracked.currentListingPriceEth = listPriceEth;
      tracked.currentListingPriceUsd = listPriceUsd;
      tracked.listingOrderId = orderId;
    }
  }

  public updateHoldStatus(identifier: string, holdReason: string): void {
    const item = this.inventory.get(identifier);
    if (item) {
      item.status = 'HOLDING';
      item.listingStatus = 'HOLDING';
      item.holdReason = holdReason;
      logger.info({ identifier, holdReason }, 'Item held in inventory due to Floor Dump Protection');
    }

    const tracked = this.trackedNfts.get(identifier.toLowerCase());
    if (tracked) {
      tracked.listingStatus = 'HOLDING';
      tracked.holdReason = holdReason;
    }
  }

  /**
   * Called when an NFT sells on OpenSea.
   * Releases capital, records confirmed sale, and resolves trade.
   */
  public markItemSold(
    identifier: string,
    salePriceEth?: number,
    ethPriceUsd: number = 2700,
    feeBps: number = 100, // Combined OpenSea + royalty bps
    gasUsd: number = 0.01,
    txHash?: string
  ): { realizedProfitUsd: number; newTotalCapitalUsd: number; saleConfirmation: NftSaleConfirmation } {
    const item = this.inventory.get(identifier);
    const key = identifier.toLowerCase();
    let realizedProfitUsd = 0;
    let soldEth = salePriceEth ?? item?.currentListingPriceEth ?? item?.acquiredPriceEth ?? 0;

    if (item) {
      item.status = 'SOLD';
      item.ownershipStatus = 'SOLD';
      item.listingStatus = 'SOLD';
      soldEth = salePriceEth ?? item.currentListingPriceEth ?? item.acquiredPriceEth;
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
    }

    const soldUsd = roundToPrecision(soldEth * ethPriceUsd, 2);
    const saleConfirmation: NftSaleConfirmation = {
      confirmed: true,
      soldAtTimestamp: Date.now(),
      salePriceEth: soldEth,
      salePriceUsd: soldUsd,
      realizedProfitUsd,
      transactionHash: txHash
    };

    let tracked = this.trackedNfts.get(key);
    if (tracked) {
      tracked.ownershipStatus = 'SOLD';
      tracked.listingStatus = 'SOLD';
      tracked.saleConfirmation = saleConfirmation;
      tracked.activeOffers = [];
    } else {
      const parts = identifier.split(':');
      tracked = {
        identifier: key,
        contractAddress: parts[0] || '',
        tokenId: parts[1] || '',
        collectionSlug: item?.collectionSlug || '',
        ownershipStatus: 'SOLD',
        listingStatus: 'SOLD',
        activeOffers: [],
        saleConfirmation
      };
      this.trackedNfts.set(key, tracked);
    }

    logger.info(
      {
        identifier,
        soldEth,
        realizedProfitUsd,
        saleConfirmed: true,
        newTotalCapitalUsd: this.getTotalCapitalUsd()
      },
      'NFT Sold & Sale Confirmed! Capital released, trade resolved, and profit added to balance.'
    );

    return {
      realizedProfitUsd,
      newTotalCapitalUsd: this.getTotalCapitalUsd(),
      saleConfirmation
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
    offer.createdTimestamp = offer.createdTimestamp || Date.now();
    offer.expiresTimestamp = offer.expiresTimestamp || (offer.createdTimestamp + (this.config.general.offerExpirationMinutes || 20) * 60 * 1000);
    offer.status = offer.status || 'ACTIVE';
    offer.cancellationVerified = false;

    // Unique key: orderHash or collectionSlug fallback
    const key = offer.orderHash || offer.collectionSlug;
    this.activeOffers.set(key, offer);

    // If offer is on a specific token, track independently under trackedNfts
    if (offer.tokenId && offer.contractAddress) {
      const nftKey = this.getNftKey(offer.contractAddress, offer.tokenId);
      let tracked = this.trackedNfts.get(nftKey);
      if (!tracked) {
        tracked = {
          identifier: nftKey,
          tokenId: offer.tokenId,
          collectionSlug: offer.collectionSlug,
          contractAddress: offer.contractAddress,
          network: offer.network,
          ownershipStatus: 'NONE',
          listingStatus: 'UNLISTED',
          activeOffers: []
        };
        this.trackedNfts.set(nftKey, tracked);
      }
      if (!tracked.activeOffers.some((o) => o.orderHash === offer.orderHash)) {
        tracked.activeOffers.push(offer);
      }
    }

    logger.info(
      {
        orderHash: offer.orderHash,
        collection: offer.collectionSlug,
        tokenId: offer.tokenId,
        priceEth: offer.priceEth,
        priceUsd: offer.priceUsd,
        createdTimestamp: offer.createdTimestamp,
        expiresInMinutes: this.config.general.offerExpirationMinutes || 20
      },
      'Active offer registered. Capital is now locked to this trade.'
    );
  }

  /**
   * Automatic Offer Cancellation — 20-Minute Rule:
   * Returns all unaccepted offers whose creation time exceeds the 20-minute limit (or cutoffMs).
   */
  public getOffersExceeding20Minutes(cutoffMs: number = 20 * 60 * 1000): ActiveOffer[] {
    const now = Date.now();
    const expired: ActiveOffer[] = [];

    for (const offer of this.activeOffers.values()) {
      // Must not be fulfilled and either still ACTIVE or pending/failed cancellation awaiting resolution
      if (offer.status !== 'FULFILLED' && (!offer.cancellationVerified || offer.status !== 'CANCELLED')) {
        const ageMs = now - offer.createdTimestamp;
        if (ageMs >= cutoffMs || offer.expiresTimestamp <= now) {
          expired.push(offer);
        }
      }
    }
    return expired;
  }

  /**
   * Automatic Cancellation: Initiates cancellation for an offer.
   * Marks status as CANCELLATION_PENDING and increments attempt count.
   * Capital remains locked until verification is confirmed.
   */
  public initiateOfferCancellation(orderHashOrKey: string): ActiveOffer | undefined {
    let offer = this.activeOffers.get(orderHashOrKey);
    if (!offer) {
      for (const off of this.activeOffers.values()) {
        if (off.orderHash === orderHashOrKey || off.collectionSlug.toLowerCase() === orderHashOrKey.toLowerCase()) {
          offer = off;
          break;
        }
      }
    }
    if (!offer) return undefined;

    offer.status = 'CANCELLATION_PENDING';
    offer.cancellationAttempts = (offer.cancellationAttempts || 0) + 1;
    offer.lastCancellationAttempt = Date.now();

    logger.info(
      {
        orderHash: offer.orderHash,
        collection: offer.collectionSlug,
        attempt: offer.cancellationAttempts,
        status: offer.status
      },
      'Automatic Offer Cancellation initiated: Offer marked CANCELLATION_PENDING. Capital remains locked until verification.'
    );

    return offer;
  }

  /**
   * Cancellation Verification: Verifies and confirms that the offer is no longer active.
   * ONLY when cancellation is confirmed is the capital released!
   */
  public confirmOfferCancellation(orderHashOrKey: string): boolean {
    let foundKey: string | undefined;
    let offer: ActiveOffer | undefined;

    if (this.activeOffers.has(orderHashOrKey)) {
      foundKey = orderHashOrKey;
      offer = this.activeOffers.get(orderHashOrKey);
    } else {
      for (const [k, off] of this.activeOffers.entries()) {
        if (off.orderHash === orderHashOrKey || off.collectionSlug.toLowerCase() === orderHashOrKey.toLowerCase()) {
          foundKey = k;
          offer = off;
          break;
        }
      }
    }

    if (!offer || !foundKey) {
      return false;
    }

    offer.status = 'CANCELLED';
    offer.cancellationVerified = true;
    this.activeOffers.delete(foundKey);

    // Clean up from trackedNfts if single item offer
    if (offer.tokenId && offer.contractAddress) {
      const nftKey = this.getNftKey(offer.contractAddress, offer.tokenId);
      const tracked = this.trackedNfts.get(nftKey);
      if (tracked) {
        tracked.activeOffers = tracked.activeOffers.filter((o) => o.orderHash !== offer!.orderHash);
      }
    }

    logger.info(
      { orderHash: offer.orderHash, collection: offer.collectionSlug, priceUsd: offer.priceUsd },
      'Cancellation verified & confirmed ✅: Offer is no longer active. Capital released back to pool.'
    );

    return true;
  }

  /**
   * Cancellation Failure & Flagging:
   * If cancellation fails or cannot be verified, it must retry or flag the offer for immediate attention
   * and must NOT assume the capital has been released.
   */
  public failOfferCancellation(
    orderHashOrKey: string,
    errorReason: string,
    maxRetries: number = 3
  ): { flagged: boolean; attempts: number } {
    let offer = this.activeOffers.get(orderHashOrKey);
    if (!offer) {
      for (const off of this.activeOffers.values()) {
        if (off.orderHash === orderHashOrKey || off.collectionSlug.toLowerCase() === orderHashOrKey.toLowerCase()) {
          offer = off;
          break;
        }
      }
    }

    if (!offer) {
      return { flagged: false, attempts: 0 };
    }

    offer.cancellationError = errorReason;
    const attempts = offer.cancellationAttempts || 1;

    if (attempts >= maxRetries) {
      offer.status = 'CANCELLATION_FAILED';
      offer.flaggedForAttention = true;
      logger.error(
        {
          orderHash: offer.orderHash,
          collection: offer.collectionSlug,
          attempts,
          error: errorReason
        },
        'CRITICAL ALERT 🚨: Cancellation verification failed after max retries! Flagged for immediate manual attention. Capital remains LOCKED and must NOT be released.'
      );
      return { flagged: true, attempts };
    } else {
      offer.status = 'CANCELLATION_PENDING';
      logger.warn(
        {
          orderHash: offer.orderHash,
          collection: offer.collectionSlug,
          attempt: attempts,
          maxRetries,
          error: errorReason
        },
        'Cancellation verification attempt failed. Offer remains CANCELLATION_PENDING to retry. Capital remains LOCKED.'
      );
      return { flagged: false, attempts };
    }
  }

  /**
   * Checks if cancellation has been confirmed for an offer.
   */
  public isOfferCancellationVerified(orderHash: string): boolean {
    const offer = this.activeOffers.get(orderHash);
    if (offer) {
      return offer.status === 'CANCELLED' && offer.cancellationVerified === true;
    }
    return true;
  }

  public getAllActiveOffers(): ActiveOffer[] {
    return Array.from(this.activeOffers.values());
  }

  public getOffersFlaggedForAttention(): ActiveOffer[] {
    return Array.from(this.activeOffers.values()).filter((o) => o.flaggedForAttention || o.status === 'CANCELLATION_FAILED');
  }

  public getActiveOffer(key: string): ActiveOffer | undefined {
    this.cleanupExpiredOffers();
    // 1. Lookup by orderHash
    if (this.activeOffers.has(key)) {
      const off = this.activeOffers.get(key)!;
      if (off.status === 'ACTIVE' || off.status === 'CANCELLATION_PENDING' || off.status === 'CANCELLATION_FAILED') {
        return off;
      }
    }
    // 2. Lookup by collectionSlug
    for (const offer of this.activeOffers.values()) {
      if (
        (offer.status === 'ACTIVE' || offer.status === 'CANCELLATION_PENDING' || offer.status === 'CANCELLATION_FAILED') &&
        offer.collectionSlug.toLowerCase() === key.toLowerCase()
      ) {
        return offer;
      }
    }
    // 3. Lookup by NFT identifier (contract:tokenId)
    for (const offer of this.activeOffers.values()) {
      if (
        (offer.status === 'ACTIVE' || offer.status === 'CANCELLATION_PENDING' || offer.status === 'CANCELLATION_FAILED') &&
        offer.tokenId &&
        `${offer.contractAddress.toLowerCase()}:${offer.tokenId}` === key.toLowerCase()
      ) {
        return offer;
      }
    }
    return undefined;
  }

  public hasActiveOfferOnNft(contractAddress: string, tokenId: string): boolean {
    this.cleanupExpiredOffers();
    const key = this.getNftKey(contractAddress, tokenId);
    const tracked = this.trackedNfts.get(key);
    if (
      tracked &&
      tracked.activeOffers.some(
        (o) =>
          (o.status === 'ACTIVE' || o.status === 'CANCELLATION_PENDING' || o.status === 'CANCELLATION_FAILED') &&
          !o.cancellationVerified
      )
    ) {
      return true;
    }
    for (const offer of this.activeOffers.values()) {
      if (
        offer.tokenId === tokenId &&
        offer.contractAddress.toLowerCase() === contractAddress.toLowerCase()
      ) {
        if (
          (offer.status === 'ACTIVE' || offer.status === 'CANCELLATION_PENDING' || offer.status === 'CANCELLATION_FAILED') &&
          !offer.cancellationVerified
        ) {
          return true;
        }
      }
    }
    return false;
  }

  public cleanupExpiredOffers(): void {
    // Under the 20-Minute Rule, unaccepted offers that reach 20 minutes must NOT be silently dropped!
    // They must go through cancellation verification before release.
    for (const [key, offer] of this.activeOffers.entries()) {
      if (offer.status === 'CANCELLED' && offer.cancellationVerified) {
        this.activeOffers.delete(key);
      }
    }
  }

  public getAllInventory(): InventoryItem[] {
    return Array.from(this.inventory.values());
  }

  public cancelActiveOffer(collectionSlug: string): void {
    for (const [key, offer] of this.activeOffers.entries()) {
      if (offer.collectionSlug.toLowerCase() === collectionSlug.toLowerCase()) {
        offer.status = 'CANCELLED';
        offer.cancellationVerified = true;
        this.activeOffers.delete(key);
        logger.info({ collectionSlug, orderHash: offer.orderHash }, 'Offer cancelled. Capital released.');
      }
    }
  }
}


