import { BotConfig } from '../types';
import { logger } from '../utils/logger';

export class CircuitBreaker {
  private config: BotConfig;
  private consecutiveErrors: number = 0;
  private isTripped: boolean = false;
  private tripReason: string = '';
  private floorPriceSnapshots: Map<string, { price: number; timestamp: number }> = new Map();

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

  public checkFloorPriceMovement(collectionSlug: string, currentFloorEth: number): boolean {
    const previous = this.floorPriceSnapshots.get(collectionSlug);
    const now = Date.now();

    if (!previous) {
      this.floorPriceSnapshots.set(collectionSlug, { price: currentFloorEth, timestamp: now });
      return true;
    }

    // If floor dropped by more than configured threshold (e.g. 15%)
    const dropPercent = ((previous.price - currentFloorEth) / previous.price) * 100;
    if (dropPercent >= this.config.riskManagement.floorPriceDropThresholdPercent) {
      logger.error(
        { collectionSlug, previousPrice: previous.price, currentFloorEth, dropPercent },
        'CRITICAL: Rapid floor price drop detected! Halting bids for collection'
      );
      return false; // Not safe to bid
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
