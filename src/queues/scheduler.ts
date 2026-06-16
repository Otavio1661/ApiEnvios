// src/queues/scheduler.ts
// Jobs agendados (repeatable) via BullMQ na fila `maintenance`:
//  - reset-counters: diário à meia-noite (reseta sentToday das instâncias).
//  - scheduled-messages: a cada minuto, enfileira mensagens SCHEDULED vencidas.
import { Queue, Worker, type Job } from 'bullmq'
import { bullConnection, QUEUE_MAINTENANCE } from './connection'
import { prisma } from '../utils/prisma'
import { resetDailyCounters } from '../jobs/reset-counters.job'
import { enqueueSend } from './send-message.queue'
import { providers } from '../providers'
import { dispatchWebhook } from '../services/notification.service'
import { logger } from '../utils/logger'
import type { InstanceConnState, InstanceStatus } from '../types'

const JOB_RESET_COUNTERS = 'reset-counters'
const JOB_SCHEDULED_MESSAGES = 'scheduled-messages'
const JOB_INSTANCES_HEALTH = 'instances-health'

// Quantas mensagens agendadas processar por execução (evita pico de enfileiramento).
const SCHEDULED_BATCH = 200

// Mapeia o status de conexão reportado pelo provider para o estado persistido.
const CONN_MAP: Record<InstanceStatus, InstanceConnState | undefined> = {
  connected: 'CONNECTED',
  disconnected: 'DISCONNECTED',
  qr_required: 'QR_PENDING',
  banned: 'BANNED',
  unknown: undefined,
}

export const maintenanceQueue = new Queue(QUEUE_MAINTENANCE, {
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: 100 },
})

let maintenanceWorker: Worker | null = null

// ── Varre mensagens agendadas vencidas e as enfileira (em lote) ─
async function processScheduledMessages() {
  const now = new Date()
  const due = await prisma.message.findMany({
    where: { status: 'SCHEDULED', scheduledAt: { lte: now } },
    select: { id: true, maxRetries: true },
    take: SCHEDULED_BATCH, // limita o lote; o cron roda a cada minuto e drena o restante
  })

  for (const msg of due) {
    // Marca QUEUED antes de enfileirar (evita duplicidade entre execuções)
    await prisma.message.update({
      where: { id: msg.id },
      data: { status: 'QUEUED' },
    })
    await enqueueSend(msg.id, msg.maxRetries)
  }

  if (due.length > 0) {
    logger.info(`[Scheduler] ${due.length} mensagem(ns) agendada(s) enfileirada(s)`)
  }
}

// ── Health check das instâncias: detecta quedas e dispara PROVIDER_DOWN ─
export async function processInstancesHealth() {
  const instances = await prisma.instance.findMany({
    where: { status: { in: ['ACTIVE', 'WARMING'] }, instanceId: { not: null } },
    take: 500,
  })

  for (const inst of instances) {
    try {
      const status = await providers[inst.provider].getInstanceStatus(inst.instanceId!)
      const next = CONN_MAP[status]
      if (!next || next === inst.connectionState) continue

      await prisma.instance.update({
        where: { id: inst.id },
        data: { connectionState: next },
      })

      // Queda de conexão → notifica o tenant
      if (inst.connectionState === 'CONNECTED' && next === 'DISCONNECTED') {
        await dispatchWebhook(
          'PROVIDER_DOWN',
          { instanceId: inst.id, provider: inst.provider, phone: inst.phone },
          inst.apiClientId,
        )
        logger.warn(`[Health] Instância ${inst.id} (${inst.provider}) caiu (CONNECTED→DISCONNECTED)`)
      }
    } catch (err: any) {
      logger.warn(`[Health] Falha ao checar instância ${inst.id}: ${err.message}`)
    }
  }
}

async function processMaintenanceJob(job: Job) {
  switch (job.name) {
    case JOB_RESET_COUNTERS:
      await resetDailyCounters()
      break
    case JOB_SCHEDULED_MESSAGES:
      await processScheduledMessages()
      break
    case JOB_INSTANCES_HEALTH:
      await processInstancesHealth()
      break
    default:
      logger.warn(`[Scheduler] Job desconhecido: ${job.name}`)
  }
}

// ── Registra os repeatable jobs e sobe o worker da maintenance ─
export async function startScheduler(): Promise<Worker> {
  // Registra repeatable jobs (idempotente — BullMQ deduplica por repeat key)
  await maintenanceQueue.add(
    JOB_RESET_COUNTERS,
    {},
    { repeat: { pattern: '0 0 * * *' }, jobId: JOB_RESET_COUNTERS },
  )
  await maintenanceQueue.add(
    JOB_SCHEDULED_MESSAGES,
    {},
    { repeat: { pattern: '* * * * *' }, jobId: JOB_SCHEDULED_MESSAGES },
  )
  await maintenanceQueue.add(
    JOB_INSTANCES_HEALTH,
    {},
    { repeat: { pattern: '*/3 * * * *' }, jobId: JOB_INSTANCES_HEALTH },
  )

  if (!maintenanceWorker) {
    maintenanceWorker = new Worker(QUEUE_MAINTENANCE, processMaintenanceJob, {
      connection: bullConnection,
      concurrency: 1,
    })
    maintenanceWorker.on('failed', (job, err) => {
      logger.warn(`[Scheduler] Job ${job?.name} falhou: ${err.message}`)
    })
  }

  return maintenanceWorker
}

export async function stopScheduler() {
  if (maintenanceWorker) {
    await maintenanceWorker.close()
    maintenanceWorker = null
  }
  await maintenanceQueue.close()
}
