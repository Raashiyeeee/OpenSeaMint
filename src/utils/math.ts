import { ethers } from 'ethers';

export function parseEth(amount: number | string): bigint {
  const str = typeof amount === 'number' ? amount.toFixed(8) : amount;
  return ethers.parseEther(str);
}

export function formatEth(wei: bigint): number {
  return parseFloat(ethers.formatEther(wei));
}

export function toWeiString(amountEth: number): string {
  return ethers.parseEther(amountEth.toFixed(8)).toString();
}

export function roundToPrecision(val: number, decimals: number = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(val * factor) / factor;
}

export function bpsToDecimal(bps: number): number {
  return bps / 10000;
}
