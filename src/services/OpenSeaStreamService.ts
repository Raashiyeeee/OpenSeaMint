import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { BotConfig } from '../types';
import { logger } from '../utils/logger';

export class OpenSeaStreamService extends EventEmitter {
  private config: BotConfig;
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private userWalletAddress: string;
  private subscribed = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private ref = 0;

  constructor(config: BotConfig, userWalletAddress: string) {
    super();
    this.config = config;
    this.userWalletAddress = userWalletAddress.toLowerCase();
  }

  public connect(): void {
    const apiKey = process.env.OPENSEA_API_KEY;
    if (!apiKey) {
      logger.warn('No OPENSEA_API_KEY provided. OpenSea Stream WebSocket client running in simulated polling mode.');
      return;
    }

    const streamUrl = `wss://stream.openseabeta.com/socket/websocket?token=${apiKey}`;

    try {
      this.ws = new WebSocket(streamUrl);

      this.ws.on('open', () => {
        this.isConnected = true;
        logger.info('Connected to OpenSea Stream WebSocket');
        // Phoenix sockets are closed by the server without a heartbeat (~every 30s); without it the stream
        // silently dropped and reconnected, missing purchase events in between.
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = setInterval(() => this.send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++this.ref) }), 25_000);
        const previous = Array.from(this.subscribed);
        this.subscribed.clear();
        this.subscribeToEvents();
        for (const slug of previous) this.subscribeCollection(slug);
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (err: any) {
          logger.error({ err }, 'Error parsing WebSocket message');
        }
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        logger.warn('OpenSea Stream WebSocket disconnected. Reconnecting in 5s...');
        setTimeout(() => this.connect(), 5000);
      });

      this.ws.on('error', (err) => {
        logger.error({ err: err.message }, 'OpenSea Stream WebSocket error');
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to initialize WebSocket client');
    }
  }

  private subscribeToEvents(): void {
    if (!this.ws || !this.isConnected) return;

    for (const coll of this.config.targetCollections) {
      if (!coll.enabled) continue;
      this.subscribeCollection(coll.slug);
    }
  }

  private send(msg: any): void {
    if (this.ws && this.isConnected) this.ws.send(JSON.stringify(msg));
  }

  /**
   * Subscribe to a collection's events. Called for every collection we place an offer on or hold an NFT from —
   * previously only configured targetCollections were subscribed, so purchases in auto-discovered collections
   * (e.g. Veil) produced no stream event at all.
   */
  public subscribeCollection(slug: string): void {
    if (!slug || this.subscribed.has(slug)) return;
    if (!this.ws || !this.isConnected) return;
    this.subscribed.add(slug);
    this.send({ topic: `collection:${slug}`, event: 'phx_join', payload: {}, ref: String(++this.ref) });
    logger.info(`Subscribed to OpenSea events for collection: ${slug}`);
  }

  public isSubscribed(slug: string): boolean {
    return this.subscribed.has(slug);
  }

  public handleMessage(msg: any): void {
    const event = msg.event;
    const payload = msg.payload?.payload;

    if (!payload) return;

    if (event === 'item_transferred') {
      const toAddress = payload.to_account?.address?.toLowerCase();
      if (toAddress === this.userWalletAddress) {
        logger.info({ item: payload.item }, 'NFT Transfer received to our trading wallet!');
        this.emit('nft_received', payload);
      }
    } else if (event === 'item_sold') {
      // Stream item_sold carries maker/taker (not seller/buyer). For an accepted BID the maker is the BUYER;
      // for a filled LISTING the maker is the SELLER. Emit whenever our wallet is involved and let the handler
      // decide purchase vs sale from our inventory (an NFT we hold unsold => we sold it; otherwise we bought it).
      const parties = [payload.maker?.address, payload.taker?.address, payload.seller?.address, payload.buyer?.address]
        .filter(Boolean)
        .map((a: string) => a.toLowerCase());
      if (parties.includes(this.userWalletAddress)) {
        logger.info({ item: payload.item, salePrice: payload.sale_price }, 'Trade involving our wallet detected on stream');
        this.emit('nft_trade', payload);
      }
    } else if (event === 'item_listed') {
      this.emit('floor_updated', payload);
    } else if (event === 'item_received_offer') {
      this.emit('offer_received', payload);
    }
  }

  public disconnect(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}
