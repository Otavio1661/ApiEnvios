import { prisma } from './src/utils/prisma'

async function main() {
  const waha = await prisma.instance.findFirst({ where: { provider: 'WAHA' } })
  if (!waha) {
    console.log('RESULT NO_WAHA_INSTANCE')
    return
  }
  const upd = await prisma.instance.update({
    where: { id: waha.id },
    data: {
      instanceId: 'default',
      status: 'ACTIVE',
      connectionState: 'CONNECTED',
      name: 'WAHA Default (QA)',
    },
  })
  console.log('RESULT', JSON.stringify({ id: upd.id, token: upd.token, provider: upd.provider, instanceId: upd.instanceId }))
}

main().then(() => process.exit(0)).catch((e) => { console.log('ERROR', e.message); process.exit(1) })
