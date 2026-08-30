import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['*.password', '*.pass', '*.ICLOUD_APP_PASSWORD', '*.token'],
    censor: '[redacted]',
  },
});
