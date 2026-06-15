// src/jobs/reset-counters.job.ts
// Roda todo dia à meia-noite: zera sentToday de todos os números

import { prisma } from '../utils/prisma'

export async function resetDailyCounters() {
  const result = await prisma.whatsappNumber.updateMany({
    where: { status: { in: ['ACTIVE', 'WARMING'] } },
    data: {
      sentToday: 0,
      lastResetAt: new Date(),
    },
  })

  console.log(`[Job] Contadores diários resetados: ${result.count} números`)
}
