import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/schema';
import { logger } from '../src/utils/logger';

dotenv.config();

const WETH_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 wad) returns (bool)'
];

const CONDUITS: Record<string, string> = {
  mainnet: '0x1E0049783F008A0085193E00003D00cd54003c71',
  robinhood: '0x963F00d3ff000064fFCbA824b800c0000000C300'
};

async function main() {
  const config = loadConfig();
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    logger.error('PRIVATE_KEY is missing in .env');
    process.exit(1);
  }

  const networkArg = process.argv[2] || 'all'; // 'mainnet', 'robinhood', or 'all'
  const networksToProcess = networkArg === 'all' 
    ? (config.general.activeNetworks || ['robinhood', 'mainnet'])
    : [networkArg];

  for (const netKey of networksToProcess) {
    const netInfo = config.networks[netKey];
    if (!netInfo) {
      logger.warn(`Network ${netKey} not found in config`);
      continue;
    }

    logger.info(`============================================================`);
    logger.info(`Checking & Preparing Wallet for [${netInfo.name}]`);
    logger.info(`RPC: ${netInfo.rpcUrl}`);
    logger.info(`============================================================`);

    const provider = new ethers.JsonRpcProvider(netInfo.rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const wethAddress = netInfo.wethAddress;
    const conduitAddress = CONDUITS[netKey];

    if (!wethAddress || !conduitAddress) {
      logger.warn(`Missing WETH or Conduit config for ${netKey}`);
      continue;
    }

    const ethBalance = await provider.getBalance(wallet.address);
    const wethContract = new ethers.Contract(wethAddress, WETH_ABI, wallet);
    const wethBalance = await wethContract.balanceOf(wallet.address);
    const allowance = await wethContract.allowance(wallet.address, conduitAddress);

    logger.info(`Wallet: ${wallet.address}`);
    logger.info(`Native ETH: ${ethers.formatEther(ethBalance)} ETH`);
    logger.info(`Wrapped ETH (WETH): ${ethers.formatEther(wethBalance)} WETH`);
    logger.info(`OpenSea Conduit Allowance: ${ethers.formatEther(allowance)} WETH`);

    if (ethBalance === 0n && wethBalance === 0n) {
      logger.warn(`⚠️ Wallet has 0 ETH and 0 WETH on ${netInfo.name}. Please deposit funds to ${wallet.address}`);
      continue;
    }

    // 1. Wrap ETH if we have ETH and little or no WETH
    // Keep a small reserve for gas (e.g. 0.0002 on L1, 0.00001 on L2)
    const gasReserve = netKey === 'mainnet' ? ethers.parseEther('0.001') : ethers.parseEther('0.00005');
    if (ethBalance > gasReserve && wethBalance < ethers.parseEther('0.001')) {
      const amountToWrap = ethBalance - gasReserve;
      logger.info(`Wrapping ${ethers.formatEther(amountToWrap)} ETH to WETH on ${netInfo.name}...`);
      try {
        const tx = await wethContract.deposit({ value: amountToWrap });
        logger.info(`Deposit Tx sent: ${tx.hash}. Waiting for confirmation...`);
        await tx.wait();
        logger.info(`✅ Successfully wrapped ETH into WETH!`);
      } catch (err: any) {
        logger.error(`Failed to wrap ETH: ${err.message}`);
      }
    }

    // 2. Approve OpenSea Conduit if not approved
    if (allowance < ethers.parseEther('1.0')) {
      logger.info(`Approving OpenSea Conduit (${conduitAddress}) for WETH on ${netInfo.name}...`);
      try {
        const tx = await wethContract.approve(conduitAddress, ethers.MaxUint256);
        logger.info(`Approval Tx sent: ${tx.hash}. Waiting for confirmation...`);
        await tx.wait();
        logger.info(`✅ Successfully approved OpenSea Conduit for WETH on ${netInfo.name}!`);
      } catch (err: any) {
        logger.error(`Failed to approve WETH: ${err.message}`);
      }
    } else {
      logger.info(`✅ OpenSea Conduit is already approved!`);
    }
  }
}

main().catch((err) => {
  console.error('Error preparing wallet:', err);
  process.exit(1);
});
