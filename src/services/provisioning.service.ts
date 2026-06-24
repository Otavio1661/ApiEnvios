// src/services/provisioning.service.ts
// Lógica compartilhada de provisionamento de contas (tenants) e usuários.
// Reusada tanto pela API REST (src/routes/admin.route.ts) quanto pelo painel
// web admin (src/web/panel.route.ts). NÃO contém regra de negócio nova: apenas
// centraliza a transação atômica e as validações de unicidade que antes estavam
// inline na rota — assim API e painel compartilham EXATAMENTE o mesmo comportamento.
import { Prisma, type ApiClient, type User } from '@prisma/client'
import { prisma } from '../utils/prisma'
import { hashPassword } from '../utils/password'

// True quando o erro é a violação de unicidade (@unique) do Prisma — código P2002.
// Usado para tratar a corrida (TOCTOU) entre o pré-check e o insert do e-mail.
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
}

// Erro de negócio do provisionamento (ex.: e-mail duplicado, conta inexistente).
// O caller decide como mapear: a API REST vira status HTTP; o painel vira ?err=.
export class ProvisioningError extends Error {
  constructor(
    message: string,
    public readonly code: 'EMAIL_TAKEN' | 'CLIENT_NOT_FOUND',
  ) {
    super(message)
    this.name = 'ProvisioningError'
  }
}

export interface CreateClientInput {
  name: string
  role: 'ADMIN' | 'CLIENT'
  fallbackEnabled: boolean
  rateLimit: number
  // Opcional: ausente ⇒ usa o default do schema (1).
  maxInstances?: number
  // Opcional: teto de mensagens/hora para o mesmo destino. Ausente ⇒ default do schema (10). 0 = ilimitado.
  maxPerRecipientPerHour?: number
  // Opcional: cria também o usuário OWNER vinculado à conta criada.
  ownerEmail?: string
  ownerPassword?: string
  ownerName?: string
}

export interface OwnerSummary {
  id: string
  email: string
  name: string | null
  role: string
}

// Cria um tenant (ApiClient) e, opcionalmente, o usuário OWNER vinculado.
// Tudo numa transação atômica para nunca deixar conta órfã. Lança
// ProvisioningError('EMAIL_TAKEN') se o e-mail do owner já existir.
export async function createClientWithOwner(
  input: CreateClientInput,
): Promise<{ client: ApiClient; owner?: OwnerSummary }> {
  const { ownerEmail, ownerPassword, ownerName, ...clientData } = input

  // Se vai criar OWNER, valida e-mail livre ANTES (evita conta órfã).
  if (ownerEmail) {
    const exists = await prisma.user.findUnique({ where: { email: ownerEmail } })
    if (exists) {
      throw new ProvisioningError('E-mail de owner já cadastrado', 'EMAIL_TAKEN')
    }
  }

  // Hash fora da transação (operação CPU-bound); criação conta+owner é atômica.
  const ownerHash = ownerEmail && ownerPassword ? await hashPassword(ownerPassword) : null

  try {
    return await prisma.$transaction(async (tx) => {
      const client = await tx.apiClient.create({ data: clientData })
      let owner: OwnerSummary | undefined
      if (ownerEmail && ownerHash) {
        const user = await tx.user.create({
          data: {
            email: ownerEmail,
            passwordHash: ownerHash,
            name: ownerName,
            role: 'OWNER',
            apiClientId: client.id,
          },
        })
        owner = { id: user.id, email: user.email, name: user.name, role: user.role }
      }
      return { client, owner }
    })
  } catch (err) {
    // TOCTOU: o pré-check passou, mas outro insert concorrente cravou o mesmo e-mail
    // antes da transação — o banco rejeita pelo @unique (P2002). Relança como
    // erro de negócio para o caller mapear (REST → 409; painel → ?err=).
    if (isUniqueViolation(err)) {
      throw new ProvisioningError('E-mail de owner já cadastrado', 'EMAIL_TAKEN')
    }
    throw err
  }
}

export interface CreateUserInput {
  apiClientId: string
  email: string
  password: string
  name?: string
  role: 'OWNER' | 'MEMBER' | 'SUPER_ADMIN'
}

// Cria um usuário vinculado a uma conta existente. Lança
// ProvisioningError('CLIENT_NOT_FOUND') se o tenant não existir e
// ProvisioningError('EMAIL_TAKEN') se o e-mail já estiver em uso.
export async function createUserForClient(input: CreateUserInput): Promise<User> {
  // Conta precisa existir.
  const client = await prisma.apiClient.findUnique({ where: { id: input.apiClientId } })
  if (!client) {
    throw new ProvisioningError('Conta (apiClientId) não encontrada', 'CLIENT_NOT_FOUND')
  }

  // E-mail único.
  const exists = await prisma.user.findUnique({ where: { email: input.email } })
  if (exists) {
    throw new ProvisioningError('E-mail já cadastrado', 'EMAIL_TAKEN')
  }

  try {
    return await prisma.user.create({
      data: {
        email: input.email,
        passwordHash: await hashPassword(input.password),
        name: input.name,
        role: input.role,
        apiClientId: input.apiClientId,
      },
    })
  } catch (err) {
    // TOCTOU: e-mail cravado por insert concorrente entre o pré-check e este insert.
    // P2002 vira EMAIL_TAKEN (409) em vez de 500.
    if (isUniqueViolation(err)) {
      throw new ProvisioningError('E-mail já cadastrado', 'EMAIL_TAKEN')
    }
    throw err
  }
}

// Lista as contas (tenants) com contagem de instâncias e usuários.
export function listClients() {
  return prisma.apiClient.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      role: true,
      active: true,
      fallbackEnabled: true,
      rateLimit: true,
      maxPerRecipientPerHour: true,
      maxInstances: true,
      totalSent: true,
      createdAt: true,
      _count: { select: { instances: true, users: true } },
    },
  })
}

// Lista usuários, opcionalmente filtrados por conta (apiClientId).
export function listUsers(apiClientId?: string) {
  return prisma.user.findMany({
    where: apiClientId ? { apiClientId } : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      emailVerified: true,
      apiClientId: true,
      createdAt: true,
    },
  })
}

// Remove um usuário por id. Retorna true se removeu, false se não existia.
export async function deleteUser(id: string): Promise<boolean> {
  const result = await prisma.user.deleteMany({ where: { id } })
  return result.count > 0
}
