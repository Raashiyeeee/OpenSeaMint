import { BotConfig } from '../types';
import { roundToPrecision } from '../utils/math';
import { logger } from '../utils/logger';

export class CircuitBreaker {
  private config: BotConfig;
  private consecutiveErrors: number = 0;
  private isTripped: boolean = false;
  private tripReason: string = '';
  private floorPriceSnapshots: Map<string, { price: number; timestamp: number }> = new Map();
  private referenceFloors: Map<string, { referencePrice: number; highestPrice: number; updatedAt: number }> = new Map();
  private permanentlyExcludedCollections: Set<string> = new Set();

  constructor(config: BotConfig) {
    this.config = config;
  }

  public registerSuccess(): void {
    this.consecutiveErrors = 0;
  }

  public registerError(context: string, error: any): void {
    this.consecutiveErrors += 1;
    logger.warn({ consecutiveErrors: this.consecutiveErrors, context, error: error.message }, 'CircuitBreaker registered an operational error');

    if (this.consecutiveErrors >= this.config.riskManagement.maxConsecutiveErrors) {
      this.trip(`Exceeded maximum consecutive error threshold (${this.consecutiveErrors})`);
    }
  }

  /**
   * Condition 2: Market Dump Protection
   * Evaluates the collection's floor-price decline before placing an offer.
   * Formula: Floor Decline % = ((Reference Floor − Current Floor) / Reference Floor) × 100
   * - <= 30% floor-price decline: The collection may be considered for an offer only if all other criteria pass.
   * - >= 40% floor-price decline: Automatically reject the collection and do not place an offer.
   * - Extreme decline or approximately 99% collapse: Permanently exclude the collection from new offers unless explicitly re-enabled.
   */
  public evaluateMarketDumpProtection(
    collectionSlug: string,
    currentFloorEth: number,
    explicitReferenceFloor?: number
  ): {
    allowed: boolean;
    declinePercent: number;
    referenceFloor: number;
    action: 'ELIGIBLE' | 'REJECT' | 'EXCLUDE';
    reason: string;
  } {
    const slugKey = collectionSlug.toLowerCase();

    // Check permanent exclusion (e.g. from 99% collapse)
    if (this.permanentlyExcludedCollections.has(slugKey)) {
      const ref = this.referenceFloors.get(slugKey)?.referencePrice || currentFloorEth;
      return {
        allowed: false,
        declinePercent: 99,
        referenceFloor: ref,
        action: 'EXCLUDE',
        reason: `Market Dump Protection: Collection '${collectionSlug}' is permanently excluded due to extreme price collapse (~99%). Requires explicit review to re-enable.`
      };
    }

    // Determine reference floor
    let refFloor = explicitReferenceFloor;
    const existingRef = this.referenceFloors.get(slugKey);

    if (!refFloor || refFloor <= 0) {
      if (existingRef) {
        refFloor = Math.max(existingRef.referencePrice, existingRef.highestPrice);
      } else {
        refFloor = currentFloorEth;
        this.referenceFloors.set(slugKey, {
          referencePrice: currentFloorEth,
          highestPrice: currentFloorEth,
          updatedAt: Date.now()
        });
      }
    } else {
      if (existingRef) {
        existingRef.highestPrice = Math.max(existingRef.highestPrice, refFloor, currentFloorEth);
        existingRef.referencePrice = refFloor;
        existingRef.updatedAt = Date.now();
      } else {
        this.referenceFloors.set(slugKey, {
          referencePrice: refFloor,
          highestPrice: Math.max(refFloor, currentFloorEth),
          updatedAt: Date.now()
        });
      }
    }

    if (refFloor <= 0) {
      return {
        allowed: true,
        declinePercent: 0,
        referenceFloor: currentFloorEth,
        action: 'ELIGIBLE',
        reason: 'Zero or invalid reference price; defaulting to current floor.'
      };
    }

    // Formula: ((Reference Floor - Current Floor) / Reference Floor) * 100
    const rawDecline = ((refFloor - currentFloorEth) / refFloor) * 100;
    const declinePercent = roundToPrecision(rawDecline, 2);

    // If current floor appreciated above reference floor, raise reference peak
    if (currentFloorEth > refFloor) {
      this.referenceFloors.set(slugKey, {
        referencePrice: currentFloorEth,
        highestPrice: currentFloorEth,
        updatedAt: Date.now()
      });
      return {
        allowed: true,
        declinePercent: 0,
        referenceFloor: currentFloorEth,
        action: 'ELIGIBLE',
        reason: 'Floor price is above reference price (appreciation). Safe.'
      };
    }

    // Threshold 1: Extreme decline or approximately 99% collapse (>= 90%)
    if (declinePercent >= 90.0) {
      this.permanentlyExcludedCollections.add(slugKey);
      logger.error(
        { collectionSlug, referenceFloor: refFloor, currentFloorEth, declinePercent },
        `MARKET DUMP PROTECTION: Extreme collapse of ${declinePercent.toFixed(1)}% detected! Permanently excluding collection from new offers.`
      );
      return {
        allowed: false,
        declinePercent,
        referenceFloor: refFloor,
        action: 'EXCLUDE',
        reason: `Market Dump Protection: Extreme decline or collapse of ${declinePercent.toFixed(1)}% detected (Reference: ${refFloor}, Current: ${currentFloorEth}). Permanently excluded from new offers.`
      };
    }

    // Threshold 2: 40% or greater floor-price decline -> Automatically reject
    if (declinePercent >= 40.0) {
      logger.warn(
        { collectionSlug, referenceFloor: refFloor, currentFloorEth, declinePercent },
        `MARKET DUMP PROTECTION: Floor declined by ${declinePercent.toFixed(1)}% (>= 40% limit). Automatically rejecting collection.`
      );
      return {
        allowed: false,
        declinePercent,
        referenceFloor: refFloor,
        action: 'REJECT',
        reason: `Market Dump Protection: Floor declined by ${declinePercent.toFixed(1)}% (Reference: ${refFloor}, Current: ${currentFloorEth}), reaching or exceeding the 40% decline limit. Automatically rejected.`
      };
    }

    // Threshold 3: <= 30% decline (or < 40%) -> Eligible for further checks
    return {
      allowed: true,
      declinePercent: Math.max(0, declinePercent),
      referenceFloor: refFloor,
      action: 'ELIGIBLE',
      reason: `Market Dump Protection: Floor decline (${Math.max(0, declinePercent).toFixed(1)}%) is within acceptable bounds (< 40%). Eligible for further checks.`
    };
  }

  public setReferenceFloorPrice(collectionSlug: string, referenceFloor: number): void {
    const slugKey = collectionSlug.toLowerCase();
    const existing = this.referenceFloors.get(slugKey);
    this.referenceFloors.set(slugKey, {
      referencePrice: referenceFloor,
      highestPrice: existing ? Math.max(existing.highestPrice, referenceFloor) : referenceFloor,
      updatedAt: Date.now()
    });
  }

  public getReferenceFloorPrice(collectionSlug: string): number | undefined {
    return this.referenceFloors.get(collectionSlug.toLowerCase())?.referencePrice;
  }

  public isCollectionPermanentlyExcluded(collectionSlug: string): boolean {
    return this.permanentlyExcludedCollections.has(collectionSlug.toLowerCase());
  }

  public reEnableCollection(collectionSlug: string): void {
    const slugKey = collectionSlug.toLowerCase();
    this.permanentlyExcludedCollections.delete(slugKey);
    this.referenceFloors.delete(slugKey);
    this.floorPriceSnapshots.delete(collectionSlug);
    logger.info({ collectionSlug }, 'Collection reviewed and explicitly re-enabled by user. Exclusion cleared.');
  }

  public getPermanentlyExcludedCollections(): string[] {
    return Array.from(this.permanentlyExcludedCollections);
  }

  public checkFloorPriceMovement(collectionSlug: string, currentFloorEth: number, explicitReferencePrice?: number): boolean {
    const dumpCheck = this.evaluateMarketDumpProtection(collectionSlug, currentFloorEth, explicitReferencePrice);
    if (!dumpCheck.allowed) {
      return false;
    }

    const previous = this.floorPriceSnapshots.get(collectionSlug);
    const now = Date.now();

    if (!previous) {
      this.floorPriceSnapshots.set(collectionSlug, { price: currentFloorEth, timestamp: now });
      return true;
    }

    // Rapid floor price drop check relative to snapshot
    const dropPercent = ((previous.price - currentFloorEth) / previous.price) * 100;
    if (dropPercent >= 40.0) {
      logger.error(
        { collectionSlug, previousPrice: previous.price, currentFloorEth, dropPercent },
        'CRITICAL: Rapid floor price drop >= 40% detected! Halting bids for collection'
      );
      return false;
    }

    // Update snapshot every 15 minutes or if floor increased
    if (now - previous.timestamp > 15 * 60 * 1000 || currentFloorEth > previous.price) {
      this.floorPriceSnapshots.set(collectionSlug, { price: currentFloorEth, timestamp: now });
    }

    return true;
  }

  private lastTripTimestamp: number = 0;
  private cooldownMs: number = 60000; // 60 second auto-recovery cooldown

  public trip(reason: string): void {
    this.isTripped = true;
    this.tripReason = reason;
    this.lastTripTimestamp = Date.now();
    logger.error(`EMERGENCY: Circuit breaker TRIPPED! Reason: ${reason}. Cooldown active for ${this.cooldownMs / 1000}s.`);
  }

  public reset(): void {
    this.isTripped = false;
    this.tripReason = '';
    this.consecutiveErrors = 0;
    this.lastTripTimestamp = 0;
    logger.info('Circuit breaker reset to normal operating state.');
  }

  public isOperational(): boolean {
    if (this.isTripped) {
      if (Date.now() - this.lastTripTimestamp > this.cooldownMs) {
        logger.info('Circuit breaker cooldown elapsed. Auto-recovering to normal operating state...');
        this.reset();
        return true;
      }
      return false;
    }
    return true;
  }

  public getStatus(): { isTripped: boolean; tripReason: string; consecutiveErrors: number } {
    return {
      isTripped: this.isTripped,
      tripReason: this.tripReason,
      consecutiveErrors: this.consecutiveErrors
    };
  }
}

