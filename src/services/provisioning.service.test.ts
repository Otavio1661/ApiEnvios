// src/services/provisioning.service.test.ts
// Testa o tratamento da corrida (TOCTOU) na unicidade de e-mail:
// quando o pré-check passa mas o insert bate no @unique (P2002), o serviço deve
// relançar ProvisioningError('EMAIL_TAKEN') — e não vazar o erro do Prisma (500).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const prismaMock = vi.hoisted(() => ({
  apiClient: { create: vi.fn(), findUnique: vi.fn() },
  user: { create: vi.fn(), findUnique: vi.fn() },
  $transaction: vi.fn(),
}))
vi.mock('../utils/prisma', () => ({ prisma: prismaMock }))

vi.mock('../utils/password', () => ({ hashPassword: vi.fn(async () => 'hash') }))

import { createClientWithOwner, createUserForClient, ProvisioningError } from './provisioning.service'

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '5.22.0',
  })
}

describe('createClientWithOwner — TOCTOU de e-mail (P2002)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('relança P2002 como ProvisioningError(EMAIL_TAKEN)', async () => {
    // Pré-check passa (e-mail livre no momento da leitura)...
    prismaMock.user.findUnique.mockResolvedValueOnce(null)
    // ...mas a transação falha no insert por corrida (P2002).
    prismaMock.$transaction.mockRejectedValueOnce(p2002())

    await expect(
      createClientWithOwner({
        name: 'Acme',
        role: 'CLIENT',
        fallbackEnabled: false,
        rateLimit: 100,
        ownerEmail: 'dup@x.com',
        ownerPassword: 'senha12345',
      }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
  })

  it('propaga erros não-P2002 sem mascarar', async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce(null)
    prismaMock.$transaction.mockRejectedValueOnce(new Error('db down'))

    await expect(
      createClientWithOwner({
        name: 'Acme',
        role: 'CLIENT',
        fallbackEnabled: false,
        rateLimit: 100,
        ownerEmail: 'x@x.com',
        ownerPassword: 'senha12345',
      }),
    ).rejects.toThrow('db down')
  })
})

describe('createUserForClient — TOCTOU de e-mail (P2002)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('relança P2002 como ProvisioningError(EMAIL_TAKEN)', async () => {
    prismaMock.apiClient.findUnique.mockResolvedValueOnce({ id: 'tenant-1' })
    prismaMock.user.findUnique.mockResolvedValueOnce(null)
    prismaMock.user.create.mockRejectedValueOnce(p2002())

    const err = await createUserForClient({
      apiClientId: 'tenant-1',
      email: 'dup@x.com',
      password: 'senha12345',
      role: 'MEMBER',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(ProvisioningError)
    expect(err.code).toBe('EMAIL_TAKEN')
  })
})
