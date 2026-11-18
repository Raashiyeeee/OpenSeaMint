import assert from 'assert';
import { BotConfig } from '../src/types';
import { loadConfig } from '../src/config/schema';
import { WalletMonitorService, SpottedCollectionEvent } from '../src/services/WalletMonitorService';
import { OpenSeaApiService } from '../src/services/OpenSeaApiService';

console.log('--- Testing WalletMonitorService ---');

async function runTests() {
  const config = loadConfig();

  // Test 1: Config loading
  assert.strictEqual(config.walletMonitor?.enabled, true, 'Wallet monitor should be enabled in default.json');
  assert.strictEqual(config.walletMonitor?.directMirrorMode, true, 'Direct mirror mode should be enabled');
  assert.strictEqual(config.walletMonitor?.outbidTickEth, 0.0001, 'Outbid tick should be 0.0001 WETH');
  assert.strictEqual(config.walletMonitor?.maxBidUsd, 10.0, 'Max bid should be $10.00 USD');
  assert.ok(Array.isArray(config.walletMonitor?.targetWallets), 'Target wallets should be an array');
  assert.strictEqual(config.walletMonitor?.targetWallets?.[0]?.toLowerCase(), '0x7d0d4312ade311c9d2cfb220cd25a12eb186b764'.toLowerCase(), 'Target wallet should be BenDoverXI');
  console.log('✓ Config parsing and schema validation passed');

  // Test 2: Mock API Service and Event Emission
  const mockEvents = [
    {
      event_type: 'order',
      order_type: 'collection_offer',
      chain: 'robinhood',
      event_timestamp: Math.floor(Date.now() / 1000),
      criteria: {
        collection: { slug: 'kotbgenesis' },
        contract: { address: '0x38497b45d6e07ed543e672e12b5dd2c5b71acb63' }
      },
      payment: {
        quantity: '6200000000000000',
        decimals: 18,
        symbol: 'WETH'
      }
    },
    {
      event_type: 'order',
      order_type: 'collection_offer',
      chain: 'robinhood',
      event_timestamp: Math.floor(Date.now() / 1000),
      criteria: {
        collection: { slug: 'digitalhumans' },
        contract: { address: '0xd6889961584a42dc5d8196bd82a4c6d0f2b684c5' }
      },
      payment: {
        quantity: '8700000000000000',
        decimals: 18,
        symbol: 'WETH'
      }
    }
  ];

  const fakeApiService = {
    client: {
      get: async (url: string) => {
        return { data: { asset_events: mockEvents } };
      }
    }
  } as unknown as OpenSeaApiService;

  const monitor = new WalletMonitorService(config, fakeApiService);
  const spotted: SpottedCollectionEvent[] = [];

  monitor.on('collection_spotted', (e: SpottedCollectionEvent) => {
    spotted.push(e);
  });

  // First poll: should spot both collections
  await monitor.pollAllWallets();

  assert.strictEqual(spotted.length, 2, 'Should emit 2 collection_spotted events');
  assert.strictEqual(spotted[0].slug, 'kotbgenesis');
  assert.strictEqual(spotted[0].network, 'robinhood');
  assert.strictEqual(spotted[0].contractAddress, '0x38497b45d6e07ed543e672e12b5dd2c5b71acb63');
  assert.strictEqual(spotted[0].makerPriceEth, 0.0062);
  assert.strictEqual(spotted[1].slug, 'digitalhumans');
  assert.strictEqual(spotted[1].makerPriceEth, 0.0087);
  console.log('✓ Initial poll correctly parses events and emits collection_spotted');

  // Second poll immediately: cooldown should prevent duplicate emissions
  await monitor.pollAllWallets();
  assert.strictEqual(spotted.length, 2, 'Cooldown should suppress duplicate events within cooldown window');
  console.log('✓ Cooldown deduplication logic working properly');

  monitor.stop();
  console.log('✓ WalletMonitorService all tests passed!\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

