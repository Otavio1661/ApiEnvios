// src/utils/redis.ts
import Redis from 'ioredis'
import { config } from '../config'
import { logger } from './logger'

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null, // necessário para BullMQ
  lazyConnect: true,
})

redis.on('error', (err) => {
  logger.error(`[Redis] Erro de conexão: ${err.message}`)
})
