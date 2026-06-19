// src/config/index.ts
import 'dotenv/config'

function requireEnv(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Variável de ambiente obrigatória não definida: ${key}`)
  return value
}

export const config = {
  app: {
    env: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
    apiSecret: process.env.API_SECRET ?? 'dev-secret-change-me',
    isDev: (process.env.NODE_ENV ?? 'development') === 'development',
    // URL base pública usada para montar apiUrl das instâncias e URLs de webhook
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    // Teto de requisições/minuto para clientes sem rateLimit próprio definido
    defaultRateLimit: Number(process.env.DEFAULT_RATE_LIMIT ?? 100),
    // JWT para login humano (usuários gerenciam as próprias instâncias)
    jwtSecret: process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  },

  db: {
    url: requireEnv('DATABASE_URL'),
  },

  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD ?? undefined,
  },

  providers: {
    evolution: {
      url: process.env.EVOLUTION_API_URL ?? 'http://localhost:8080',
      apiKey: process.env.EVOLUTION_API_KEY ?? '',
      enabled: Boolean(process.env.EVOLUTION_API_KEY),
    },
    waha: {
      url: process.env.WAHA_URL ?? 'http://localhost:3001',
      apiKey: process.env.WAHA_API_KEY ?? '',
      enabled: Boolean(process.env.WAHA_URL),
    },
    cloudApi: {
      token: process.env.WA_CLOUD_TOKEN ?? '',
      phoneNumberId: process.env.WA_CLOUD_PHONE_NUMBER_ID ?? '',
      enabled: Boolean(process.env.WA_CLOUD_TOKEN),
    },
  },

  // Ordem de fallback dos providers (índice 0 = primeiro a tentar)
  providerFallbackOrder: ['EVOLUTION', 'WAHA', 'CLOUD_API'] as const,

  sending: {
    delayMin: Number(process.env.SEND_DELAY_MIN ?? 2000),
    delayMax: Number(process.env.SEND_DELAY_MAX ?? 5000),
    maxMessagesPerNumberDay: Number(process.env.MAX_MESSAGES_PER_NUMBER_DAY ?? 200),
  },

  notifications: {
    banWebhookUrl: process.env.BAN_WEBHOOK_URL ?? '',
    alertEmail: process.env.ALERT_EMAIL ?? '',
  },

  // Admin inicial do painel, provisionado pelo seed a partir do ambiente.
  // Sem valores default para email/senha: vazio = criação do admin desativada
  // (o seed roda normalmente, apenas pula a etapa). NUNCA hardcode credenciais.
  adminSeed: adminSeedConfig(),
} as const

// Lê as variáveis ADMIN_SEED já com .trim() — valores só com espaços contam como
// vazios. enabled deriva dos valores trimados (email e senha ambos preenchidos).
function adminSeedConfig() {
  const email = (process.env.ADMIN_SEED_EMAIL ?? '').trim()
  const password = (process.env.ADMIN_SEED_PASSWORD ?? '').trim()
  const name = (process.env.ADMIN_SEED_NAME ?? '').trim() || 'Administrador'
  return {
    email,
    password,
    name,
    // Habilitado apenas quando email e senha estão ambos preenchidos (já trimados).
    enabled: Boolean(email && password),
  }
}

// Guard de produção: nunca subir com segredos no valor dev (risco de forja de token/auth).
if (!config.app.isDev) {
  const insecure: string[] = []
  if (config.app.jwtSecret === 'dev-jwt-secret-change-me') insecure.push('JWT_SECRET')
  if (config.app.apiSecret === 'dev-secret-change-me') insecure.push('API_SECRET')
  if (insecure.length > 0) {
    throw new Error(
      `Segredos inseguros em produção (defina no ambiente): ${insecure.join(', ')}`,
    )
  }
}
