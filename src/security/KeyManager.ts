import fs from 'fs';
import { ethers, Wallet } from 'ethers';
import { logger } from '../utils/logger';

export class KeyManager {
  private wallet: Wallet | ethers.HDNodeWallet;
  private readonly provider: ethers.Provider;

  constructor(provider: ethers.Provider) {
    this.provider = provider;
    this.wallet = this.initializeWallet();
    logger.info(`Trading wallet initialized successfully: ${this.wallet.address}`);
  }

  private initializeWallet(): Wallet | ethers.HDNodeWallet {
    const privateKey = process.env.PRIVATE_KEY;
    const keystorePath = process.env.KEYSTORE_PATH;
    const keystorePassword = process.env.KEYSTORE_PASSWORD;

    if (keystorePath && fs.existsSync(keystorePath)) {
      if (!keystorePassword) {
        throw new Error('KEYSTORE_PATH specified but KEYSTORE_PASSWORD is missing');
      }
      logger.info(`Decrypting keystore file from ${keystorePath}...`);
      const json = fs.readFileSync(keystorePath, 'utf8');
      const decryptedWallet = Wallet.fromEncryptedJsonSync(json, keystorePassword);
      return decryptedWallet.connect(this.provider) as Wallet;
    }

    if (privateKey && privateKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      const cleanKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
      return new Wallet(cleanKey, this.provider);
    }

    // In simulation mode, if no key provided, create an ephemeral in-memory wallet
    if (process.env.BOT_MODE === 'SIMULATION') {
      logger.warn('No trading key specified. Generating ephemeral in-memory wallet for SIMULATION mode.');
      return Wallet.createRandom(this.provider);
    }

    throw new Error('No valid trading private key or encrypted keystore found in environment');
  }

  public getAddress(): string {
    return this.wallet.address;
  }

  public getSigner(): Wallet | ethers.HDNodeWallet {
    return this.wallet;
  }

  public async getEthBalance(): Promise<bigint> {
    return await this.provider.getBalance(this.wallet.address);
  }

  public async getWethBalance(wethContractAddress: string): Promise<bigint> {
    const erc20Abi = ['function balanceOf(address owner) view returns (uint256)'];
    const contract = new ethers.Contract(wethContractAddress, erc20Abi, this.provider);
    return await contract.balanceOf(this.wallet.address);
  }
}
