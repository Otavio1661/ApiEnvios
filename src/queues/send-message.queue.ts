// src/queues/send-message.queue.ts
// Fila de envio assíncrono de mensagens.
import { Queue } from 'bullmq'
import { bullConnection, QUEUE_SEND_MESSAGE } from './connection'

export interface SendJobData {
  messageId: string
}

export const sendMessageQueue = new Queue<SendJobData>(QUEUE_SEND_MESSAGE, {
  connection: bullConnection,
  defaultJobOptions: {
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
})

// ── Enfileira o envio de uma mensagem já persistida ───────────
// O retry/backoff é configurado por job a partir de Message.maxRetries.
export async function enqueueSend(messageId: string, maxRetries = 3) {
  return sendMessageQueue.add(
    'send',
    { messageId },
    {
      attempts: Math.max(1, maxRetries),
      backoff: { type: 'exponential', delay: 5000 },
      jobId: messageId, // idempotência: 1 job por mensagem
    },
  )
}
