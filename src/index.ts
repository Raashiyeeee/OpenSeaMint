import path from 'path';
import http from 'http';
import { ethers } from 'ethers';
import { loadConfig } from './config/schema';
import { logger } from './utils/logger';
import { WalletTradingWorker } from './workers/WalletTradingWorker';

export interface WalletConfigItem {
  id: string;
  label: string;
  privateKey?: string;
  apiKey?: string;
  statePath: string;
}

export function resolveWalletConfigs(): WalletConfigItem[] {
  const configs: WalletConfigItem[] = [];
  const defaultStatePath = process.env.INVENTORY_STATE_PATH;

  // 1. Check for numbered environment variables:
  // Supports PRIVATE_KEY_1 / PRIVATE_KEY_2 OR PRIVATE_KEY (as 1) + PRIVATE_KEY_2
  const hasKey1 = process.env.PRIVATE_KEY_1 || (process.env.PRIVATE_KEY_2 ? process.env.PRIVATE_KEY : undefined);

  if (hasKey1) {
    let i = 1;
    while (true) {
      const rawKey =
        i === 1
          ? (process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY)
          : process.env[`PRIVATE_KEY_${i}`];

      if (!rawKey) break;

      const key = rawKey.trim();
      const apiKey = process.env[`OPENSEA_API_KEY_${i}`] || process.env.OPENSEA_API_KEY;
      const customState = process.env[`INVENTORY_STATE_PATH_${i}`];
      const statePath =
        customState ||
        (defaultStatePath
          ? deriveStatePath(defaultStatePath, i)
          : path.resolve(process.cwd(), `data/inventory-wallet${i}.json`));

      configs.push({
        id: `wallet-${i}`,
        label: `Wallet ${i}`,
        privateKey: key,
        apiKey,
        statePath
      });
      i++;
    }
  }

  // 2. Comma-separated PRIVATE_KEYS=key1,key2
  if (configs.length === 0 && process.env.PRIVATE_KEYS) {
    const keys = process.env.PRIVATE_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
    const apiKeys = process.env.OPENSEA_API_KEYS
      ? process.env.OPENSEA_API_KEYS.split(',').map((k) => k.trim())
      : [];
    keys.forEach((key, idx) => {
      const num = idx + 1;
      const apiKey = apiKeys[idx] || process.env.OPENSEA_API_KEY;
      const customState = process.env[`INVENTORY_STATE_PATH_${num}`];
      const statePath =
        customState ||
        (defaultStatePath
          ? deriveStatePath(defaultStatePath, num)
          : path.resolve(process.cwd(), `data/inventory-wallet${num}.json`));

      configs.push({
        id: `wallet-${num}`,
        label: `Wallet ${num}`,
        privateKey: key,
        apiKey,
        statePath
      });
    });
  }

  // 3. Fallback: single wallet mode (standard PRIVATE_KEY)
  if (configs.length === 0) {
    configs.push({
      id: 'wallet-1',
      label: 'Wallet 1',
      privateKey: process.env.PRIVATE_KEY,
      apiKey: process.env.OPENSEA_API_KEY,
      statePath: defaultStatePath || path.resolve(process.cwd(), 'data/inventory-state.json')
    });
  }

  return configs;
}

function deriveStatePath(basePath: string, index: number): string {
  const ext = path.extname(basePath) || '.json';
  const name = path.basename(basePath, ext);
  const dir = path.dirname(basePath);
  return path.join(dir, `${name}-wallet${index}${ext}`);
}

async function main() {
  logger.info('============================================================');
  logger.info('Starting OpenSea Automated NFT Trading Bot');
  logger.info(`Mode: ${process.env.BOT_MODE || 'SIMULATION'}`);
  logger.info('============================================================');

  // 1. Load configuration
  const config = loadConfig();
  const activeNetworks = config.general.activeNetworks || ['robinhood', 'mainnet'];

  logger.info(`Multi-Chain Mode Active: Monitoring [${activeNetworks.join(', ')}] simultaneously without manual switching`);
  logger.info(`Trading Capital: $${config.capital.totalTradingCapitalUsd.toFixed(2)} (Per active wallet)`);
  logger.info(`Profit Target: Minimum $${config.capital.minNetProfitUsd.toFixed(2)} Net Profit per trade`);
  logger.info(`Max Active Trades: ${config.capital.maxActiveTrades} (Rule: One active trade at a time)`);

  // 2. Setup shared RPC providers
  const providers: Record<string, ethers.JsonRpcProvider> = {};
  for (const netKey of activeNetworks) {
    const netInfo = config.networks[netKey];
    if (netInfo) {
      providers[netKey] = new ethers.JsonRpcProvider(netInfo.rpcUrl);
    }
  }

  // 3. Resolve wallet configurations
  const walletConfigs = resolveWalletConfigs();
  logger.info(`Configured Trading Wallets: ${walletConfigs.length} [${walletConfigs.map((w) => w.label).join(', ')}]`);

  // 4. Instantiate Workers
  const workers = walletConfigs.map((wCfg) => {
    return new WalletTradingWorker({
      id: wCfg.id,
      label: wCfg.label,
      privateKey: wCfg.privateKey,
      apiKey: wCfg.apiKey,
      statePath: wCfg.statePath,
      config,
      providers
    });
  });

  // 4.5. Register friendly wallet addresses across all workers for Team Coordination
  const allWalletAddresses = workers.map((w) => w.getAddress());
  for (const worker of workers) {
    worker.setFriendlyWallets(allWalletAddresses);
  }

  // 5. Start lightweight health-check server (Required for Render)
  const port = process.env.PORT || 3000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'healthy',
        bot: 'OpenSea NFT Trading Bot',
        mode: process.env.BOT_MODE || 'LIVE',
        multiWallet: workers.length > 1,
        walletCount: workers.length,
        wallets: workers.map((w) => w.getStatus()),
        activeNetworks,
        timestamp: new Date().toISOString()
      })
    );
  });

  server.listen(port, () => {
    logger.info(`Health check dashboard listening on port ${port}`);
  });

  // 6. Start all workers concurrently
  for (const worker of workers) {
    await worker.start();
  }

  // 7. Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down trading bot gracefully...');
    for (const worker of workers) {
      worker.stop();
    }
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, 'Fatal startup crash');
    process.exit(1);
  });
}
