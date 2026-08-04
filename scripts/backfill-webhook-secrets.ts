// scripts/backfill-webhook-secrets.ts
// Passo 1/2 do rollout do webhookSecret (ver plano de correção de segurança —
// webhooks inbound sem autenticação). O `webhookSecret` já existe no banco
// (backfillado pela migration), mas as instâncias/números JÁ CRIADOS têm o
// webhook registrado no provider com a URL ANTIGA (sem `?ws=`). Este script
// re-registra todos, no formato novo — `registerInboundWebhook`/
// `registerNumberInboundWebhook` já são best-effort/idempotentes por design
// (não lançam, só logam falha), então é seguro rodar mais de uma vez.
//
// Rodar ANTES de exigir o `ws` como obrigatório em produção (ele já é
// obrigatório no código a partir deste deploy — rodar este script faz parte
// do MESMO deploy, antes do tráfego real dos providers começar a bater nos
// endpoints validados). Uso:
//   docker exec apienvios_app npx tsx scripts/backfill-webhook-secrets.ts
import { prisma } from '../src/utils/prisma'
import { registerInboundWebhook, registerNumberInboundWebhook } from '../src/services/instance.service'
import { logger } from '../src/utils/logger'

async function main() {
  const instances = await prisma.instance.findMany({
    where: { status: { not: 'BANNED' } },
  })
  logger.info(`[Backfill] Re-registrando webhook de ${instances.length} instância(s)...`)
  for (const instance of instances) {
    await registerInboundWebhook(instance, logger as any)
  }

  const numbers = await prisma.instanceNumber.findMany({
    where: { status: { not: 'BANNED' } },
  })
  logger.info(`[Backfill] Re-registrando webhook de ${numbers.length} número(s)...`)
  for (const number of numbers) {
    await registerNumberInboundWebhook(number, logger as any)
  }

  logger.info('[Backfill] Concluído.')
}

main()
  .catch((err) => {
    logger.error(`[Backfill] Falhou: ${err.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
