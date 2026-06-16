// src/jobs/reset-counters.job.ts
// Roda todo dia à meia-noite: zera sentToday de todas as instâncias

import { prisma } from '../utils/prisma'
import { logger } from '../utils/logger'

export async function resetDailyCounters() {
  const result = await prisma.instance.updateMany({
    where: { status: { in: ['ACTIVE', 'WARMING'] } },
    data: {
      sentToday: 0,
      lastResetAt: new Date(),
    },
  })

  logger.info(`[Job] Contadores diários resetados: ${result.count} instâncias`)
}
