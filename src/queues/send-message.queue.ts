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

// ── Remove o job de uma mensagem da fila (best-effort) ─────────
// Como usamos jobId = messageId, um job antigo (ex.: já falhado e mantido no
// histórico por removeOnFail) impediria re-enfileirar com o mesmo id. Remover
// antes garante que requeueSend crie um job novo. Não lança.
export async function removeSendJob(messageId: string): Promise<void> {
  try {
    await sendMessageQueue.remove(messageId)
  } catch {
    // job inexistente/já removido — ignorar
  }
}

// ── Re-enfileira uma mensagem (reenvio) ───────────────────────
// Remove o job anterior (mesmo jobId) e enfileira de novo. Usado pelo reenvio
// manual de mensagens com falha.
export async function requeueSend(messageId: string, maxRetries = 3) {
  await removeSendJob(messageId)
  return enqueueSend(messageId, maxRetries)
}
