// prisma/seed.ts
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { config } from '../src/config'
import { hashPassword } from '../src/utils/password'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Iniciando seed do banco...')

  // Cliente API admin (provisiona contas/instâncias)
  const adminClient = await prisma.apiClient.upsert({
    where: { apiKey: 'admin-key-123456' },
    update: { role: 'ADMIN' },
    create: {
      name: 'Admin',
      apiKey: 'admin-key-123456',
      active: true,
      role: 'ADMIN',
      rateLimit: 1000,
    },
  })
  console.log(`✅ ApiClient admin criado: ${adminClient.name} (key: ${adminClient.apiKey})`)

  // Cliente API de desenvolvimento (tenant comum)
  const devClient = await prisma.apiClient.upsert({
    where: { apiKey: 'dev-key-123456' },
    update: { role: 'CLIENT', maxInstances: 5 },
    create: {
      name: 'Cliente Dev',
      apiKey: 'dev-key-123456',
      active: true,
      role: 'CLIENT',
      rateLimit: 1000,
      maxInstances: 5,
    },
  })
  console.log(`✅ ApiClient criado: ${devClient.name} (key: ${devClient.apiKey})`)

  // Usuário OWNER do cliente dev (login JWT) — senha: dev123456
  const ownerUser = await prisma.user.upsert({
    where: { email: 'owner@dev.local' },
    update: { apiClientId: devClient.id, role: 'OWNER' },
    create: {
      email: 'owner@dev.local',
      passwordHash: await bcrypt.hash('dev123456', 10),
      name: 'Owner Dev',
      role: 'OWNER',
      apiClientId: devClient.id,
    },
  })
  console.log(`✅ Usuário OWNER criado: ${ownerUser.email} (senha: dev123456)`)

  // Instância de exemplo (Evolution API) — vinculada ao cliente dev
  const instance1 = await prisma.instance.upsert({
    where: { apiClientId_phone: { apiClientId: devClient.id, phone: '5544999990001' } },
    update: {},
    create: {
      phone: '5544999990001',
      name: 'Vendas',
      label: 'Número Principal - Evolution',
      provider: 'EVOLUTION',
      instanceId: 'instancia-01',
      token: 'dev-instance-token-01',
      status: 'ACTIVE',
      priority: 0,
      apiClientId: devClient.id,
    },
  })
  console.log(`✅ Instância criada: ${instance1.phone} (${instance1.provider}) token: ${instance1.token}`)

  // Instância de fallback (WAHA) — vinculada ao cliente dev
  const instance2 = await prisma.instance.upsert({
    where: { apiClientId_phone: { apiClientId: devClient.id, phone: '5544999990002' } },
    update: {},
    create: {
      phone: '5544999990002',
      name: 'Suporte',
      label: 'Número Fallback - WAHA',
      provider: 'WAHA',
      // Sessão WAHA real conectada no ambiente dev (engine NOWEB) é a 'default'.
      instanceId: 'default',
      token: 'dev-instance-token-02',
      status: 'ACTIVE',
      priority: 1,
      apiClientId: devClient.id,
    },
  })
  console.log(`✅ Instância criada: ${instance2.phone} (${instance2.provider}) token: ${instance2.token}`)

  // ── Admin inicial do painel (configurável por ambiente) ──────────
  // Só executa quando ADMIN_SEED_EMAIL e ADMIN_SEED_PASSWORD estão ambos
  // preenchidos. Vazio/ausente = pula sem erro. Idempotente (upsert por email).
  if (config.adminSeed.enabled) {
    const adminUser = await prisma.user.upsert({
      where: { email: config.adminSeed.email },
      update: {
        passwordHash: await hashPassword(config.adminSeed.password),
        name: config.adminSeed.name,
        role: 'SUPER_ADMIN',
        apiClientId: adminClient.id,
      },
      create: {
        email: config.adminSeed.email,
        passwordHash: await hashPassword(config.adminSeed.password),
        name: config.adminSeed.name,
        role: 'SUPER_ADMIN',
        apiClientId: adminClient.id,
      },
    })
    console.log(
      `✅ Admin do painel criado/atualizado: ${adminUser.email} (ApiClient ADMIN: ${adminClient.name})`,
    )
  } else {
    console.log('ℹ️  Admin seed desativado (ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD não definidos).')
  }

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
