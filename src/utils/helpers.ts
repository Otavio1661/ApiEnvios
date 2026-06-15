// src/utils/helpers.ts

/** Aguarda um tempo fixo em ms */
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Aguarda um tempo aleatório entre min e max ms (anti-ban) */
export const randomDelay = (min: number, max: number) =>
  sleep(Math.floor(Math.random() * (max - min + 1)) + min)

/** Normaliza número de telefone para formato internacional sem + */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

/** Gera uma API key aleatória */
export function generateApiKey(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length: 40 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

/** Formata erro para string */
export function formatError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return JSON.stringify(err)
}
