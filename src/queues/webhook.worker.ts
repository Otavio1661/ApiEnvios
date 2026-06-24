// src/queues/webhook.worker.ts
// Worker que entrega os webhooks de saída com retry/backoff (BullMQ) e assinatura
// HMAC opcional (quando o webhook tem `secret`). Esgotadas as tentativas, o job
// permanece no conjunto "failed" da fila = DLQ (dead-letter) para auditoria.
import { Worker, type Job } from 'bullmq'
import axios from 'axios'
import { bullConnection, QUEUE_WEBHOOK } from './connection'
import type { WebhookJobData } from './webhook.queue'
import { prisma } from '../utils/prisma'
import { webhookSignature } from '../utils/webhook-signature'
import { logger } from '../utils/logger'

let worker: Worker<WebhookJobData> | null = null

async function processJob(job: Job<WebhookJobData>) {
  const { webhookId, event, payload } = job.data

  const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } })
  // Webhook removido ou desativado entre o enfileiramento e a entrega → não re-tenta.
  if (!webhook || !webhook.active) {
    logger.warn(`[Webhook] ${webhookId} inexistente/inativo — descartando entrega`)
    return
  }

  // Assina exatamente os bytes enviados (POSTamos a MESMA string).
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-ApiEnvios-Event': event,
  }
  if (webhook.secret) {
    const ts = Date.now().toString()
    headers['X-ApiEnvios-Timestamp'] = ts
    headers['X-ApiEnvios-Signature'] = webhookSignature(webhook.secret, ts, body)
  }

  try {
    await axios.post(webhook.url, body, { timeout: 8000, headers })
    // Sucesso: marca entrega e zera o contador de falhas consecutivas.
    await prisma.webhook.update({
      where: { id: webhook.id },
      data: { lastCalledAt: new Date(), failCount: 0 },
    })
  } catch (err: any) {
    await prisma.webhook.update({
      where: { id: webhook.id },
      data: { failCount: { increment: 1 } },
    })
    const attemptNumber = job.attemptsMade + 1
    const isLast = attemptNumber >= (job.opts.attempts ?? 1)
    logger.error(
      `[Webhook] ${webhook.url} tentativa ${attemptNumber} falhou: ${err.message}` +
        (isLast ? ' (tentativas esgotadas → DLQ)' : ' (re-tentará com backoff)'),
    )
    // Relança para o BullMQ re-tentar; após a última, o job fica no "failed" (DLQ).
    throw err
  }
}

export function startWebhookWorker(): Worker<WebhookJobData> {
  if (worker) return worker
  worker = new Worker<WebhookJobData>(QUEUE_WEBHOOK, processJob, {
    connection: bullConnection,
    concurrency: 5,
  })
  worker.on('failed', (job, err) => {
    logger.warn(`[Webhook] job ${job?.id} falhou: ${err.message}`)
  })
  return worker
}

export async function stopWebhookWorker() {
  if (worker) {
    await worker.close()
    worker = null
  }
}
