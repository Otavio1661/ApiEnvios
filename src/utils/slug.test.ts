// src/utils/slug.test.ts
// Cobre a normalização de slug (kebab-case, sem acentos, limites) e o schema Zod.
import { describe, it, expect } from 'vitest'
import { slugify, slugSchema, SLUG_MAX } from './slug'

describe('slugify', () => {
  it('converte texto livre em kebab-case', () => {
    expect(slugify('Vendas SP')).toBe('vendas-sp')
    expect(slugify('  Suporte  Técnico ')).toBe('suporte-tecnico')
  })

  it('remove acentos (NFD)', () => {
    expect(slugify('Atenção')).toBe('atencao')
    expect(slugify('São João')).toBe('sao-joao')
  })

  it('colapsa separadores e remove hífens das pontas', () => {
    expect(slugify('--Olá!!! Mundo--')).toBe('ola-mundo')
    expect(slugify('a___b...c')).toBe('a-b-c')
  })

  it('retorna string vazia quando não sobra nada utilizável', () => {
    expect(slugify('!!! @@@ ###')).toBe('')
  })

  it('respeita o limite de tamanho e não deixa hífen residual', () => {
    const out = slugify('x'.repeat(60))
    expect(out.length).toBeLessThanOrEqual(SLUG_MAX)
    expect(out.endsWith('-')).toBe(false)
  })
})

describe('slugSchema', () => {
  it('aceita kebab-case válido', () => {
    expect(slugSchema.safeParse('vendas-sp').success).toBe(true)
    expect(slugSchema.safeParse('abc').success).toBe(true)
  })

  it('rejeita maiúsculas, espaços e caracteres inválidos', () => {
    expect(slugSchema.safeParse('Vendas-SP').success).toBe(false)
    expect(slugSchema.safeParse('vendas sp').success).toBe(false)
    expect(slugSchema.safeParse('vendas_sp').success).toBe(false)
    expect(slugSchema.safeParse('-vendas').success).toBe(false)
  })

  it('rejeita curto demais e longo demais', () => {
    expect(slugSchema.safeParse('ab').success).toBe(false)
    expect(slugSchema.safeParse('a'.repeat(41)).success).toBe(false)
  })
})
