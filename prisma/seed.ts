// prisma/seed.ts
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Iniciando seed do banco...')

  // Cliente API de desenvolvimento
  const devClient = await prisma.apiClient.upsert({
    where: { apiKey: 'dev-key-123456' },
    update: {},
    create: {
      name: 'Cliente Dev',
      apiKey: 'dev-key-123456',
      active: true,
      rateLimit: 1000,
    },
  })
  console.log(`✅ ApiClient criado: ${devClient.name} (key: ${devClient.apiKey})`)

  // Número de exemplo (Evolution API)
  const number1 = await prisma.whatsappNumber.upsert({
    where: { phone: '5544999990001' },
    update: {},
    create: {
      phone: '5544999990001',
      label: 'Número Principal - Evolution',
      provider: 'EVOLUTION',
      instanceId: 'instancia-01',
      status: 'ACTIVE',
      priority: 0,
    },
  })
  console.log(`✅ Número criado: ${number1.phone} (${number1.provider})`)

  // Número de fallback (WAHA)
  const number2 = await prisma.whatsappNumber.upsert({
    where: { phone: '5544999990002' },
    update: {},
    create: {
      phone: '5544999990002',
      label: 'Número Fallback - WAHA',
      provider: 'WAHA',
      instanceId: 'waha-session-01',
      status: 'ACTIVE',
      priority: 1,
    },
  })
  console.log(`✅ Número criado: ${number2.phone} (${number2.provider})`)

  console.log('\n🎉 Seed concluído!')
  console.log('\nPara testar a API:')
  console.log('  curl -X POST http://localhost:3000/v1/messages \\')
  console.log('    -H "x-api-key: dev-key-123456" \\')
  console.log('    -H "Content-Type: application/json" \\')
  console.log('    -d \'{"to":"5544988880000","type":"TEXT","text":"Olá!"}\'')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
