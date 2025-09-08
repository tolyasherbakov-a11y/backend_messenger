import pino from 'pino';

const level = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')) as pino.LevelWithSilent;
export const logger = pino({
  level,
  base: undefined,
  redact: { paths: ['req.headers.authorization', 'password', 'token'], censor: '[redacted]' },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined
});

export default logger;
