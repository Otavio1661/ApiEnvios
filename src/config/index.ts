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
} as const
