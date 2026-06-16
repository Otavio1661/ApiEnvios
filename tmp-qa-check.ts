import { prisma } from './src/utils/prisma'
import { writeFileSync } from 'fs'

async function main() {
  const m = await prisma.message.findUnique({
    where: { id: 'cmqh0lzsh0009us0t0bmkmu7o' },
    include: { attempts: true, apiClient: true, instance: true },
  })
  const out = JSON.stringify(
    {
      status: m?.status,
      provider: m?.provider,
      providerId: m?.providerId,
      sentAt: m?.sentAt,
      toPhone: m?.toPhone,
      tenant: m?.apiClient?.name,
      tenantKey: m?.apiClient?.apiKey,
      instanceName: m?.instance?.name,
      attempts: m?.attempts.map((a) => ({ ok: a.success, provider: a.provider, err: a.errorMsg })),
    },
    null,
    2,
  )
  writeFileSync('tmp-qa-result.json', out)
  console.log(out)
}

main().then(() => prisma.$disconnect())
