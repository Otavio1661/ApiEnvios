// src/services/metrics.service.ts
// Métricas de uso por tenant (conta). Tudo escopado por apiClientId; para MEMBER,
// restringe às instâncias das quais ele é dono (ownerUserId). Sem SQL concatenado:
// usa Prisma groupBy e um $queryRaw PARAMETRIZADO (tagged template) na série diária.
import { Prisma } from '@prisma/client'
import { prisma } from '../utils/prisma'

// Status que contam como "enviada" (entregue ao provider ou adiante).
const SENT_STATUSES = ['SENT', 'DELIVERED', 'READ'] as const

export interface TenantMetrics {
  period: { days: number; since: string }
  totals: { total: number; sent: number; failed: number; queued: number }
  byStatus: Record<string, number>
  byDay: Array<{ day: string; total: number; sent: number; failed: number }>
  byInstance: Array<{ instanceId: string; name: string | null; total: number; sent: number; failed: number }>
  byNumber: Array<{ id: string; phone: string | null; label: string | null; sentToday: number; sentTotal: number; connectionState: string }>
}

export async function getTenantMetrics(input: {
  apiClientId: string
  // Quando informado, restringe às instâncias deste dono (escopo de MEMBER).
  ownerUserId?: string
  days: number
}): Promise<TenantMetrics> {
  const { apiClientId, ownerUserId } = input
  const days = Math.min(90, Math.max(1, Math.floor(input.days)))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Resolve as instâncias visíveis ao chamador (todas da conta, ou só as do dono).
  const visibleInstances = await prisma.instance.findMany({
    where: { apiClientId, ...(ownerUserId ? { ownerUserId } : {}) },
    select: { id: true, name: true },
  })
  const instanceIds = visibleInstances.map((i) => i.id)
  const nameById = new Map(visibleInstances.map((i) => [i.id, i.name]))

  // MEMBER sem nenhuma instância → métricas vazias (evita varrer a conta inteira).
  if (ownerUserId && instanceIds.length === 0) {
    return {
      period: { days, since: since.toISOString() },
      totals: { total: 0, sent: 0, failed: 0, queued: 0 },
      byStatus: {},
      byDay: [],
      byInstance: [],
      byNumber: [],
    }
  }

  // Filtro base das mensagens no período. Para MEMBER, restringe às instâncias dele.
  const where: Prisma.MessageWhereInput = {
    apiClientId,
    createdAt: { gte: since },
    ...(ownerUserId ? { instanceId: { in: instanceIds } } : {}),
  }

  // Contagem por status (Prisma groupBy — seguro).
  const grouped = await prisma.message.groupBy({
    by: ['status'],
    where,
    _count: { _all: true },
  })
  const byStatus: Record<string, number> = {}
  for (const g of grouped) byStatus[g.status] = g._count._all

  const sum = (keys: readonly string[]) => keys.reduce((a, k) => a + (byStatus[k] ?? 0), 0)
  const total = Object.values(byStatus).reduce((a, n) => a + n, 0)
  const totals = {
    total,
    sent: sum(SENT_STATUSES),
    failed: byStatus['FAILED'] ?? 0,
    queued: sum(['QUEUED', 'SENDING', 'SCHEDULED']),
  }

  // Por instância (groupBy instanceId+status; remonta total/sent/failed).
  const byInstGrouped = await prisma.message.groupBy({
    by: ['instanceId', 'status'],
    where,
    _count: { _all: true },
  })
  const instAcc = new Map<string, { total: number; sent: number; failed: number }>()
  for (const row of byInstGrouped) {
    if (!row.instanceId) continue
    const acc = instAcc.get(row.instanceId) ?? { total: 0, sent: 0, failed: 0 }
    acc.total += row._count._all
    if ((SENT_STATUSES as readonly string[]).includes(row.status)) acc.sent += row._count._all
    if (row.status === 'FAILED') acc.failed += row._count._all
    instAcc.set(row.instanceId, acc)
  }
  const byInstance = [...instAcc.entries()]
    .map(([instanceId, v]) => ({ instanceId, name: nameById.get(instanceId) ?? null, ...v }))
    .sort((a, b) => b.total - a.total)

  // Série diária (parametrizada — sem concatenação de string).
  const dayFilter = ownerUserId
    ? Prisma.sql`AND "instanceId" = ANY(${instanceIds})`
    : Prisma.empty
  const dayRows = await prisma.$queryRaw<
    Array<{ day: Date; total: bigint; sent: bigint; failed: bigint }>
  >`
    SELECT date_trunc('day', "createdAt") AS day,
           count(*) AS total,
           count(*) FILTER (WHERE "status" IN ('SENT','DELIVERED','READ')) AS sent,
           count(*) FILTER (WHERE "status" = 'FAILED') AS failed
      FROM "Message"
     WHERE "apiClientId" = ${apiClientId}
       AND "createdAt" >= ${since}
       ${dayFilter}
     GROUP BY 1
     ORDER BY 1
  `
  const byDay = dayRows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    total: Number(r.total),
    sent: Number(r.sent),
    failed: Number(r.failed),
  }))

  // Por número do pool (contadores anti-ban atuais).
  const numbers = await prisma.instanceNumber.findMany({
    where: { instance: { apiClientId, ...(ownerUserId ? { ownerUserId } : {}) } },
    select: { id: true, phone: true, label: true, sentToday: true, sentTotal: true, connectionState: true },
    orderBy: { sentTotal: 'desc' },
  })
  const byNumber = numbers.map((n) => ({ ...n }))

  return {
    period: { days, since: since.toISOString() },
    totals,
    byStatus,
    byDay,
    byInstance,
    byNumber,
  }
}
