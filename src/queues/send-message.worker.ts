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
import type { SendMessagePayload, WhatsappButton } from '../types'

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

  // BUTTONS/LOCATION/CONTACT/POLL guardam campos extras em colunas Json próprias
  // (buttons/location/contact/poll); os demais tipos usam `content` como texto ou
  // URL de mídia. Ver src/utils/message-payload.ts para a mesma lógica no sentido
  // inverso (montagem do create a partir do payload recebido na API).
  const isButtons = message.type === 'BUTTONS'
  const isLocation = message.type === 'LOCATION'
  const isContact = message.type === 'CONTACT'
  const isPoll = message.type === 'POLL'
  const isText = message.type === 'TEXT'
  const buttonsData = (message.buttons ?? {}) as { footer?: string; buttons?: WhatsappButton[] }
  const locationData = (message.location ?? {}) as { latitude?: number; longitude?: number }
  const contactData = (message.contact ?? {}) as { phone?: string }
  const pollData = (message.poll ?? {}) as { options?: string[] }

  const payload: SendMessagePayload = {
    to: message.toPhone,
    type: message.type,
    text: isText || isButtons || isPoll ? message.content : undefined,
    mediaUrl: isText || isButtons || isLocation || isContact || isPoll ? undefined : message.content,
    caption: message.caption ?? undefined,
    buttons: isButtons ? buttonsData.buttons : undefined,
    footer: isButtons ? buttonsData.footer : undefined,
    latitude: isLocation ? locationData.latitude : undefined,
    longitude: isLocation ? locationData.longitude : undefined,
    locationName: isLocation ? (message.content || undefined) : undefined,
    contactName: isContact ? message.content : undefined,
    contactPhone: isContact ? contactData.phone : undefined,
    pollOptions: isPoll ? pollData.options : undefined,
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
