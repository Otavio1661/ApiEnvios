// src/queues/webhook.queue.ts
// Fila de ENTREGA de webhooks de saída. Em vez de POSTar inline (sem retry), cada
// webhook a entregar vira um job: o BullMQ cuida do retry com backoff exponencial e,
// quando esgota as tentativas, mantém o job no conjunto "failed" — que funciona como
// nossa DLQ (dead-letter) para inspeção/reprocesso.
import { Queue } from 'bullmq'
import { bullConnection, QUEUE_WEBHOOK } from './connection'
import type { WebhookEvent, WebhookPayload } from '../types'

export interface WebhookJobData {
  webhookId: string
  event: WebhookEvent
  payload: WebhookPayload
}

// removeOnFail guarda um histórico grande de falhas (DLQ) para inspeção/reprocesso.
export const webhookQueue = new Queue<WebhookJobData>(QUEUE_WEBHOOK, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s, 40s
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 }, // DLQ: mantém os esgotados para auditoria
  },
})

// Enfileira a entrega de UM webhook (1 destino). Chamado pelo dispatchWebhook.
export async function enqueueWebhookDelivery(
  webhookId: string,
  event: WebhookEvent,
  payload: WebhookPayload,
) {
  return webhookQueue.add('deliver', { webhookId, event, payload })
}
