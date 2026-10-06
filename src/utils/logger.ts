import pino from 'pino';

export const logger = pino({
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
