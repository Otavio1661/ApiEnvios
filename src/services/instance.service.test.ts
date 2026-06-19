// src/services/instance.service.test.ts
// Cobre: resolução por id OU slug (escopada por tenant), geração de slug único
// (sufixo em colisão) e o mapeamento de P2002 → InstanceError (409) ao criar/renomear.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const prismaMock = vi.hoisted(() => ({
  instance: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  instanceNumber: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
}))
vi.mock('../utils/prisma', () => ({ prisma: prismaMock }))

import {
  findInstanceByIdOrSlug,
  generateUniqueSlug,
  createInstance,
  updateInstance,
  InstanceError,
  createNumber,
  findNumberScoped,
} from './instance.service'

function p2002(target: string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
    meta: { target },
  })
}

beforeEach(() => vi.clearAllMocks())

describe('findInstanceByIdOrSlug', () => {
  it('busca por id OU slug, escopado ao tenant', async () => {
    prismaMock.instance.findFirst.mockResolvedValueOnce({ id: 'i-1', slug: 'vendas' })
    const out = await findInstanceByIdOrSlug('vendas', 'tenant-A')
    expect(out).toMatchObject({ id: 'i-1' })
    expect(prismaMock.instance.findFirst).toHaveBeenCalledWith({
      where: { apiClientId: 'tenant-A', OR: [{ id: 'vendas' }, { slug: 'vendas' }] },
    })
  })
})

describe('generateUniqueSlug', () => {
  it('retorna o slug base quando livre', async () => {
    prismaMock.instance.findUnique.mockResolvedValueOnce(null)
    expect(await generateUniqueSlug('Vendas SP')).toBe('vendas-sp')
  })

  it('adiciona sufixo numérico em colisão', async () => {
    // 1ª tentativa colide; 2ª livre.
    prismaMock.instance.findUnique
      .mockResolvedValueOnce({ id: 'outro' })
      .mockResolvedValueOnce(null)
    expect(await generateUniqueSlug('vendas')).toBe('vendas-2')
  })

  it('ignora a própria instância ao renomear', async () => {
    prismaMock.instance.findUnique.mockResolvedValueOnce({ id: 'self' })
    expect(await generateUniqueSlug('vendas', 'self')).toBe('vendas')
  })
})

describe('createInstance — conflito de unicidade', () => {
  it('mapeia P2002(slug) → InstanceError(SLUG_TAKEN) [409]', async () => {
    prismaMock.instance.findUnique.mockResolvedValue(null) // slug "livre" no pré-check
    prismaMock.instance.create.mockRejectedValueOnce(p2002(['slug']))

    const err = await createInstance({
      provider: 'WAHA',
      slug: 'vendas',
      apiClientId: 'tenant-A',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(InstanceError)
    expect(err.code).toBe('SLUG_TAKEN')
  })

  it('mapeia P2002(name) → InstanceError(NAME_TAKEN)', async () => {
    prismaMock.instance.findUnique.mockResolvedValue(null)
    prismaMock.instance.create.mockRejectedValueOnce(p2002(['apiClientId', 'name']))

    const err = await createInstance({
      provider: 'WAHA',
      name: 'Vendas',
      apiClientId: 'tenant-A',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(InstanceError)
    expect(err.code).toBe('NAME_TAKEN')
  })
})

describe('updateInstance — renomear', () => {
  it('lança NOT_FOUND quando a instância não é do tenant', async () => {
    prismaMock.instance.findFirst.mockResolvedValueOnce(null)
    const err = await updateInstance({ id: 'x', apiClientId: 'tenant-A', name: 'Novo' }).catch((e) => e)
    expect(err).toBeInstanceOf(InstanceError)
    expect(err.code).toBe('NOT_FOUND')
  })

  it('mapeia P2002(name) → InstanceError(NAME_TAKEN) no update', async () => {
    prismaMock.instance.findFirst.mockResolvedValueOnce({ id: 'i-1', slug: 'vendas' })
    prismaMock.instance.update.mockRejectedValueOnce(p2002(['apiClientId', 'name']))
    const err = await updateInstance({ id: 'i-1', apiClientId: 'tenant-A', name: 'Dup' }).catch((e) => e)
    expect(err).toBeInstanceOf(InstanceError)
    expect(err.code).toBe('NAME_TAKEN')
  })
})

// ── Fase C1: helpers de InstanceNumber ───────────────────────────
describe('createNumber', () => {
  it('cria número sob a instância com defaults de priority', async () => {
    prismaMock.instanceNumber.create.mockResolvedValueOnce({ id: 'n-1' })
    const out = await createNumber({ instanceId: 'i-1', provider: 'EVOLUTION', label: 'Vendas' })
    expect(out).toMatchObject({ id: 'n-1' })
    expect(prismaMock.instanceNumber.create).toHaveBeenCalledWith({
      data: { instanceId: 'i-1', provider: 'EVOLUTION', label: 'Vendas', priority: 0 },
    })
  })

  it('respeita priority informado', async () => {
    prismaMock.instanceNumber.create.mockResolvedValueOnce({ id: 'n-2' })
    await createNumber({ instanceId: 'i-1', provider: 'WAHA', priority: 5 })
    expect(prismaMock.instanceNumber.create).toHaveBeenCalledWith({
      data: { instanceId: 'i-1', provider: 'WAHA', label: undefined, priority: 5 },
    })
  })
})

describe('findNumberScoped', () => {
  it('escopa a busca pela instância do tenant (instance.apiClientId)', async () => {
    prismaMock.instanceNumber.findFirst.mockResolvedValueOnce({ id: 'n-1', instanceId: 'i-1' })
    const out = await findNumberScoped('n-1', 'tenant-A')
    expect(out).toMatchObject({ id: 'n-1' })
    expect(prismaMock.instanceNumber.findFirst).toHaveBeenCalledWith({
      where: { id: 'n-1', instance: { apiClientId: 'tenant-A' } },
    })
  })

  it('retorna null quando o número não é do tenant', async () => {
    prismaMock.instanceNumber.findFirst.mockResolvedValueOnce(null)
    expect(await findNumberScoped('n-x', 'tenant-B')).toBeNull()
  })
})
