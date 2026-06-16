// src/queues/connection.ts
// Opções de conexão para o BullMQ. Usamos um objeto de opções (não uma instância
// IORedis compartilhada) porque o BullMQ traz a própria versão do ioredis e cria
// conexões dedicadas por Queue/Worker — evita conflito de tipos entre versões e
// segue a recomendação do BullMQ de não compartilhar a mesma conexão.
import type { ConnectionOptions } from 'bullmq'
import { config } from '../config'

export const bullConnection: ConnectionOptions = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null, // exigido pelo BullMQ
}

// Nomes das filas (constantes únicas)
export const QUEUE_SEND_MESSAGE = 'send-message'
export const QUEUE_MAINTENANCE = 'maintenance'
