// src/utils/slug.ts
// Geração e validação de slug de instância (kebab-case), usado na URL/API
// (ex.: /v1/instance/vendas-sp/...). O slug é único GLOBALMENTE no banco.
import { z } from 'zod'

// Formato canônico de slug: kebab-case, 3–40 chars, sem acentos.
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const SLUG_MIN = 3
export const SLUG_MAX = 40

// Schema Zod reusável para validar um slug já em kebab-case.
export const slugSchema = z
  .string()
  .min(SLUG_MIN, `O slug deve ter ao menos ${SLUG_MIN} caracteres.`)
  .max(SLUG_MAX, `O slug deve ter no máximo ${SLUG_MAX} caracteres.`)
  .regex(SLUG_REGEX, 'Slug inválido: use apenas letras minúsculas, números e hífens (kebab-case).')

// Converte uma string livre (ex.: "Vendas SP!") em slug kebab-case ("vendas-sp").
// Remove acentos, troca não-alfanuméricos por hífen, colapsa hífens e corta em SLUG_MAX.
// Retorna '' quando não sobra nada utilizável (ex.: só símbolos) — o caller decide o fallback.
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove diacríticos (acentos) após NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // não-alfanumérico → hífen
    .replace(/^-+|-+$/g, '') // remove hífens das pontas
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '') // remove hífen residual após o corte
}
