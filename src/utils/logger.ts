// src/utils/logger.ts
// Logger Pino compartilhado para código que roda FORA do request HTTP
// (workers BullMQ, scheduler, serviços), onde não há `request.log`.
// Mantém logs estruturados/consistentes com o logger do Fastify.
import pino from 'pino'
import { config } from '../config'

export const logger = pino(
  config.app.isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {},
)
