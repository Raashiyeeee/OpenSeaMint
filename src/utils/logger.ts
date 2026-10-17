import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

export const rawLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
      ignore: 'pid,hostname'
    }
  },
  redact: {
    paths: [
      'privateKey',
      'key',
      'secret',
      'password',
      '*.privateKey',
      'headers.authorization',
      'headers["x-api-key"]'
    ],
    censor: '[REDACTED_SECRET]'
  }
});

export const walletAsyncStorage = new AsyncLocalStorage<{ walletLabel: string }>();

/** Executes an async function within a specific wallet context so all logger calls automatically include [Wallet X] */
export function runWithWalletContext<T>(walletLabel: string, fn: () => T): T {
  return walletAsyncStorage.run({ walletLabel }, fn);
}

function formatWithPrefix(
  method: 'info' | 'warn' | 'error' | 'debug' | 'fatal' | 'trace',
  arg1: any,
  arg2?: any,
  ...rest: any[]
) {
  const store = walletAsyncStorage.getStore();
  const label = store?.walletLabel;
  if (!label) {
    return (rawLogger[method] as any)(arg1, arg2, ...rest);
  }
  const prefix = `[${label}] `;

  if (typeof arg1 === 'string') {
    if (arg1.startsWith(`[${label}]`)) {
      return (rawLogger[method] as any)(arg1, arg2, ...rest);
    }
    const remaining = [arg2, ...rest].filter((x) => x !== undefined);
    return (rawLogger[method] as any)(`${prefix}${arg1}`, ...remaining);
  }
  if (typeof arg2 === 'string') {
    if (arg2.startsWith(`[${label}]`)) {
      return (rawLogger[method] as any)(arg1, arg2, ...rest);
    }
    return (rawLogger[method] as any)(arg1, `${prefix}${arg2}`, ...rest);
  }
  const obj = typeof arg1 === 'object' && arg1 !== null ? { wallet: label, ...arg1 } : { wallet: label };
  return (rawLogger[method] as any)(obj, arg2, ...rest);
}

export const logger = {
  info: (arg1: any, arg2?: any, ...rest: any[]) => formatWithPrefix('info', arg1, arg2, ...rest),
  warn: (arg1: any, arg2?: any, ...rest: any[]) => formatWithPrefix('warn', arg1, arg2, ...rest),
  error: (arg1: any, arg2?: any, ...rest: any[]) => formatWithPrefix('error', arg1, arg2, ...rest),
  debug: (arg1: any, arg2?: any, ...rest: any[]) => formatWithPrefix('debug', arg1, arg2, ...rest),
  fatal: (arg1: any, arg2?: any, ...rest: any[]) => formatWithPrefix('fatal', arg1, arg2, ...rest),
  trace: (arg1: any, arg2?: any, ...rest: any[]) => formatWithPrefix('trace', arg1, arg2, ...rest),
  child: (bindings: any) => rawLogger.child(bindings)
};
