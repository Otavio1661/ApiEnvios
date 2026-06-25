// src/queues/send-message.worker.ts
// Worker que consome a fila send-message: carrega a Message, envia (instância
// dedicada ou fallback do tenant), atualiza status e grava MessageAttempt.
// Retry com backoff exponencial é controlado pelo BullMQ (attempts/backoff do job).
import { Worker, type Job } from 'bullmq'
import { bullConnection, QUEUE_SEND_MESSAGE } from './connection'
import type { SendJobData } from './send-message.queue'
import { prisma } from '../utils/prisma'
import { sendViaInstance, sendWithFallback } from '../services/provider-router.service'
import { dispatchWebhook } from '../services/notification.service'
import { logger } from '../utils/logger'
import type { SendMessagePayload } from '../types'

let worker: Worker<SendJobData> | null = null

async function processJob(job: Job<SendJobData>) {
  const { messageId } = job.data

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { instance: true, apiClient: true },
  })

  if (!message) {
    // Mensagem sumiu — nada a fazer, não re-tenta.
    logger.warn(`[Worker] Mensagem ${messageId} não encontrada, ignorando job`)
    return
  }

  // Mensagens já finalizadas/canceladas não são reenviadas
  if (['SENT', 'DELIVERED', 'READ', 'CANCELLED'].includes(message.status)) {
    return
  }

  // attemptsMade começa em 0 na 1ª execução
  const attemptNumber = job.attemptsMade + 1
  const isLastAttempt = attemptNumber >= (job.opts.attempts ?? 1)

  await prisma.message.update({
    where: { id: message.id },
    data: { status: 'SENDING', retryCount: attemptNumber - 1 },
  })

  const payload: SendMessagePayload = {
    to: message.toPhone,
    type: message.type,
    text: message.type === 'TEXT' ? message.content : undefined,
    mediaUrl: message.type === 'TEXT' ? undefined : message.content,
    caption: message.caption ?? undefined,
  }

  const start = Date.now()
  const result = message.instanceId && message.instance
    ? await sendViaInstance(message.instance, payload)
    : await sendWithFallback(message.apiClientId, payload)
  const duration = Date.now() - start

  // Histórico da tentativa
  await prisma.messageAttempt.create({
    data: {
      messageId: message.id,
      provider: result.provider ?? message.instance?.provider ?? 'EVOLUTION',
      instanceId: message.instanceId,
      attempt: attemptNumber,
      success: result.success,
      errorMsg: result.error,
      duration,
    },
  })

  if (result.success) {
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        provider: result.provider,
        providerId: result.providerId,
        // Fase C3: registra qual número do pool efetivou o envio (quando houver).
        numberId: result.numberId ?? undefined,
        errorMessage: null,
      },
    })

    // Confirmação de SUCESSO (escopada ao tenant). Opt-in: só quem assina
    // MESSAGE_DELIVERED recebe. Permite ao consumidor (ex.: alvará) confirmar o
    // envio real — não o otimista do QUEUED. Dispara uma vez, no sucesso do envio.
    await dispatchWebhook(
      'MESSAGE_DELIVERED',
      {
        messageId: message.id,
        to: message.toPhone,
        provider: result.provider,
        numberId: result.numberId ?? null,
      },
      message.apiClientId,
    )
    return
  }

  // Falha nesta tentativa
  if (isLastAttempt) {
    // Falha definitiva → FAILED + webhook MESSAGE_FAILED (escopado ao tenant)
    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: result.error,
        provider: result.provider,
      },
    })

    await dispatchWebhook(
      'MESSAGE_FAILED',
      {
        messageId: message.id,
        to: message.toPhone,
        provider: result.provider,
        error: result.error,
        attempts: attemptNumber,
      },
      message.apiClientId,
    )
  }

  // Lança erro para o BullMQ agendar o retry com backoff
  throw new Error(result.error ?? 'Falha no envio')
}

// ── Inicializa o worker (chamado no boot do servidor) ─────────
export function startSendMessageWorker(): Worker<SendJobData> {
  if (worker) return worker

  worker = new Worker<SendJobData>(QUEUE_SEND_MESSAGE, processJob, {
    connection: bullConnection,
    concurrency: 5,
  })

  worker.on('completed', (job) => {
    logger.info(`[Worker] Job ${job.id} concluído`)
  })
  worker.on('failed', (job, err) => {
    logger.warn(`[Worker] Job ${job?.id} falhou (tentativa ${job?.attemptsMade}): ${err.message}`)
  })

  return worker
}

export async function stopSendMessageWorker() {
  if (worker) {
    await worker.close()
    worker = null
  }
}
