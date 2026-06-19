// src/jobs/reset-counters.job.ts
// Roda todo dia à meia-noite: zera sentToday de todas as instâncias

import { prisma } from '../utils/prisma'
import { logger } from '../utils/logger'

export async function resetDailyCounters() {
  const now = new Date()

  // Instâncias (compat — pool legado de 1 número e métricas agregadas da Instance).
  const instances = await prisma.instance.updateMany({
    where: { status: { in: ['ACTIVE', 'WARMING'] } },
    data: {
      sentToday: 0,
      lastResetAt: now,
    },
  })

  // Fase C3: os contadores que governam o rodízio vivem nos NÚMEROS do pool.
  const numbers = await prisma.instanceNumber.updateMany({
    where: { status: { in: ['ACTIVE', 'WARMING'] } },
    data: {
      sentToday: 0,
      lastResetAt: now,
    },
  })

  logger.info(
    `[Job] Contadores diários resetados: ${instances.count} instâncias, ${numbers.count} números do pool`,
  )
}
