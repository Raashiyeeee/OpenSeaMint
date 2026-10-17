import assert from 'assert';
import { resolveWalletConfigs } from '../src/index';
import { WalletTradingWorker } from '../src/workers/WalletTradingWorker';
import { loadConfig } from '../src/config/schema';
import { ethers, Wallet } from 'ethers';

async function runMultiWalletTests() {
  console.log('================================================================');
  console.log('Starting Multi-Wallet Regression Test Suite');
  console.log('================================================================\n');

  const origEnv = { ...process.env };

  try {
    // ------------------------------------------------------------------------
    // TEST 1: Default / Single-Wallet Fallback
    // ------------------------------------------------------------------------
    console.log('--- Test 1: Single-Wallet Mode (Default) ---');
    delete process.env.PRIVATE_KEY_1;
    delete process.env.PRIVATE_KEY_2;
    delete process.env.PRIVATE_KEYS;
    process.env.PRIVATE_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
    process.env.OPENSEA_API_KEY = 'api_key_single';
    process.env.INVENTORY_STATE_PATH = 'data/inventory-state.json';

    const singleConfig = resolveWalletConfigs();
    assert.strictEqual(singleConfig.length, 1, 'Must return exactly 1 wallet configuration');
    assert.strictEqual(singleConfig[0].id, 'wallet-1');
    assert.strictEqual(singleConfig[0].privateKey, process.env.PRIVATE_KEY);
    assert.strictEqual(singleConfig[0].apiKey, 'api_key_single');
    assert.strictEqual(singleConfig[0].statePath, 'data/inventory-state.json');
    console.log('Test 1 PASSED: Single-wallet fallback works seamlessly ✅\n');

    // ------------------------------------------------------------------------
    // TEST 2: Numbered Multi-Wallet (PRIVATE_KEY_1 & PRIVATE_KEY_2)
    // ------------------------------------------------------------------------
    console.log('--- Test 2: Numbered Multi-Wallet (PRIVATE_KEY_1 & PRIVATE_KEY_2) ---');
    process.env.PRIVATE_KEY_1 = '0x1111111111111111111111111111111111111111111111111111111111111111';
    process.env.OPENSEA_API_KEY_1 = 'os_key_1';
    process.env.PRIVATE_KEY_2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
    process.env.OPENSEA_API_KEY_2 = 'os_key_2';

    const multiConfig = resolveWalletConfigs();
    assert.strictEqual(multiConfig.length, 2, 'Must detect exactly 2 wallet configurations');
    assert.strictEqual(multiConfig[0].id, 'wallet-1');
    assert.strictEqual(multiConfig[0].apiKey, 'os_key_1');
    assert.strictEqual(multiConfig[0].statePath.endsWith('wallet1.json'), true);

    assert.strictEqual(multiConfig[1].id, 'wallet-2');
    assert.strictEqual(multiConfig[1].apiKey, 'os_key_2');
    assert.strictEqual(multiConfig[1].statePath.endsWith('wallet2.json'), true);
    console.log('Test 2 PASSED: Numbered multi-wallet detection with distinct state paths works ✅\n');

    // ------------------------------------------------------------------------
    // TEST 3: Retaining PRIVATE_KEY + Adding PRIVATE_KEY_2
    // ------------------------------------------------------------------------
    console.log('--- Test 3: Legacy PRIVATE_KEY + Additional PRIVATE_KEY_2 ---');
    delete process.env.PRIVATE_KEY_1;
    process.env.PRIVATE_KEY = '0x1111111111111111111111111111111111111111111111111111111111111111';
    process.env.OPENSEA_API_KEY = 'os_key_shared';
    process.env.PRIVATE_KEY_2 = '0x2222222222222222222222222222222222222222222222222222222222222222';
    delete process.env.OPENSEA_API_KEY_2;

    const legacyMultiConfig = resolveWalletConfigs();
    assert.strictEqual(legacyMultiConfig.length, 2, 'Must detect 2 wallets when user adds PRIVATE_KEY_2 to existing PRIVATE_KEY');
    assert.strictEqual(legacyMultiConfig[0].id, 'wallet-1');
    assert.strictEqual(legacyMultiConfig[0].privateKey, process.env.PRIVATE_KEY);
    assert.strictEqual(legacyMultiConfig[1].id, 'wallet-2');
    assert.strictEqual(legacyMultiConfig[1].privateKey, process.env.PRIVATE_KEY_2);
    assert.strictEqual(legacyMultiConfig[1].apiKey, 'os_key_shared', 'Falls back to shared OPENSEA_API_KEY if key 2 not set');
    console.log('Test 3 PASSED: Zero-friction addition of second wallet works ✅\n');

    // ------------------------------------------------------------------------
    // TEST 4: Comma-Separated PRIVATE_KEYS
    // ------------------------------------------------------------------------
    console.log('--- Test 4: Comma-Separated PRIVATE_KEYS ---');
    delete process.env.PRIVATE_KEY_1;
    delete process.env.PRIVATE_KEY_2;
    delete process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEYS = '0x1111111111111111111111111111111111111111111111111111111111111111, 0x2222222222222222222222222222222222222222222222222222222222222222';
    process.env.OPENSEA_API_KEYS = 'key_a, key_b';

    const commaConfig = resolveWalletConfigs();
    assert.strictEqual(commaConfig.length, 2);
    assert.strictEqual(commaConfig[0].apiKey, 'key_a');
    assert.strictEqual(commaConfig[1].apiKey, 'key_b');
    console.log('Test 4 PASSED: Comma-separated keys parsed cleanly ✅\n');

    // ------------------------------------------------------------------------
    // TEST 5: Worker Dual-Instance Isolation Test
    // ------------------------------------------------------------------------
    console.log('--- Test 5: Worker Dual-Instance Isolation Test ---');
    const config = loadConfig();
    const fakeProvider: any = {
      getBalance: async () => 1000000000000000000n
    };
    const providers = {
      robinhood: fakeProvider,
      mainnet: fakeProvider
    };

    const worker1 = new WalletTradingWorker({
      id: 'wallet-1',
      label: 'Wallet 1',
      privateKey: '0x1111111111111111111111111111111111111111111111111111111111111111',
      apiKey: 'api_key_1',
      statePath: 'data/test-inv-1.json',
      config,
      providers
    });

    const worker2 = new WalletTradingWorker({
      id: 'wallet-2',
      label: 'Wallet 2',
      privateKey: '0x2222222222222222222222222222222222222222222222222222222222222222',
      apiKey: 'api_key_2',
      statePath: 'data/test-inv-2.json',
      config,
      providers
    });

    const addr1 = worker1.getAddress();
    const addr2 = worker2.getAddress();

    assert.notStrictEqual(addr1, addr2, 'Workers must have distinct wallet addresses');
    assert.strictEqual(addr1, new Wallet('0x1111111111111111111111111111111111111111111111111111111111111111').address);
    assert.strictEqual(addr2, new Wallet('0x2222222222222222222222222222222222222222222222222222222222222222').address);

    const status1 = worker1.getStatus();
    const status2 = worker2.getStatus();

    assert.strictEqual(status1.id, 'wallet-1');
    assert.strictEqual(status2.id, 'wallet-2');
    assert.strictEqual(status1.address, addr1);
    assert.strictEqual(status2.address, addr2);

    console.log('Test 5 PASSED: Both workers initialized in parallel with complete isolation ✅\n');

    // ------------------------------------------------------------------------
    // TEST 6: Team Coordination & Anti-Cannibalization Rule
    // ------------------------------------------------------------------------
    console.log('--- Test 6: Team Coordination & Anti-Cannibalization Rule ---');
    const apiService = (worker2 as any).apiService;
    apiService.setFriendlyWalletAddresses([addr1, addr2]);

    // Mock collection offers where Wallet 1 holds the top offer (0.0015 ETH) and an outsider holds 0.0012 ETH
    (apiService as any).fetchCollectionOffersPages = async () => [
      {
        order_hash: '0xwallet1_top_offer',
        protocol_data: { parameters: { offerer: addr1 } },
        price: { currency: 'WETH', value: '1500000000000000', decimals: 18 }
      },
      {
        order_hash: '0xoutsider_lower_offer',
        protocol_data: { parameters: { offerer: '0x9999999999999999999999999999999999999999' } },
        price: { currency: 'WETH', value: '1200000000000000', decimals: 18 }
      }
    ];

    // 1. getAbsoluteTopCollectionOffer must detect Wallet 1 is #1
    const absTop = await apiService.getAbsoluteTopCollectionOffer('test-col');
    assert.strictEqual(absTop?.offerer?.toLowerCase(), addr1.toLowerCase(), 'Must detect Wallet 1 is at the top');

    // 2. getTopCompetingCollectionOffer from Wallet 2's perspective must exclude Wallet 1 (only see the outsider)
    const competingForWallet2 = await apiService.getTopCompetingCollectionOffer('test-col', {
      excludeAddresses: [addr2, addr1],
      fresh: true
    });
    assert.strictEqual(competingForWallet2?.offerer?.toLowerCase(), '0x9999999999999999999999999999999999999999', 'Wallet 2 must ignore Wallet 1 as a competitor and only see external offers');

    // 3. CollectionBidderStrategy with friendly wallets set
    const bidder2 = (worker2 as any).bidderStrategy;
    bidder2.setFriendlyWallets([addr1, addr2]);

    // When Wallet 2 checks a collection where Wallet 1 is already #1, it must NOT place an offer
    let offerPlaced = false;
    (worker2 as any).seaportService.createAndSubmitCollectionOffer = async () => {
      offerPlaced = true;
      return { success: true, orderHash: '0xwallet2_duplicate' };
    };

    await bidder2.processCollectionBid({
      name: 'Team Col',
      slug: 'test-col',
      contractAddress: '0x1234123412341234123412341234123412341234',
      network: 'robinhood',
      targetNetProfitUsd: 0.2,
      maxInventory: 5
    });

    assert.strictEqual(offerPlaced, false, 'Wallet 2 must NOT place an offer on a collection where Wallet 1 is already #1');
    console.log('Test 6 PASSED: Team Coordination prevents self-outbidding and cannibalization ✅\n');

    console.log('================================================================');
    console.log('All Multi-Wallet Tests Passed Successfully! ✅');
    console.log('================================================================');
  } finally {
    process.env = origEnv;
  }
}

runMultiWalletTests().catch((err) => {
  console.error('Multi-wallet test failed:', err);
  process.exit(1);
});
