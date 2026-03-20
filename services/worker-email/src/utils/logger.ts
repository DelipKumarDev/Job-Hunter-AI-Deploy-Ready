import winston from 'winston';
const isDev = process.env['NODE_ENV'] === 'development';
export const logger = winston.createLogger({
  level: process.env['LOG_LEVEL'] ?? 'info',
  defaultMeta: { service: 'worker-email' },
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    isDev ? winston.format.simple() : winston.format.json(),
  ),
  transports: [new winston.transports.Console({
    format: isDev
      ? winston.format.combine(winston.format.colorize(), winston.format.simple())
      : winston.format.json(),
  })],
});
