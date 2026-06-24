// src/web/panel.route.ts
// Painel web server-rendered (estilo UltraMsg), prefixo /admin.
// Sessão via cookie httpOnly `token` (MESMO JWT da API). NÃO há cadastro:
// usuários são criados pelo admin. Toda a regra de negócio é reusada de
// src/services/instance.service.ts (nada de lógica nova aqui — só camada de view).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../utils/prisma'
import { config } from '../config'
import { verifyPassword } from '../utils/password'
import { normalizePhone } from '../utils/helpers'
import { enqueueSend, requeueSend, removeSendJob } from '../queues/send-message.queue'
import {
  listInstances,
  listInstancesWithConnection,
  findInstanceByIdOrSlug,
  createInstance,
  updateInstance,
  assignInstanceOwner,
  connectInstance,
  syncInstanceStatus,
  refreshQr,
  toInstanceResponse,
  InstanceError,
  listNumbers,
  addNumber,
  findNumberScoped,
  connectNumber,
  refreshQrNumber,
  syncNumberStatus,
  deleteNumber,
  assertInstanceQuota,
} from '../services/instance.service'
import { isSuperAdmin, memberScopeId } from '../middlewares/auth.middleware'
import { slugSchema } from '../utils/slug'
import {
  ProvisioningError,
  createClientWithOwner,
  createUserForClient,
  listClients,
  listUsers,
  deleteUser,
  updateClient,
  updateUser,
} from '../services/provisioning.service'
import { deleteClientCascade, deleteInstanceCascade } from '../services/cascade-delete.service'

// Nome do cookie de sessão do painel (mesmo JWT da API).
const COOKIE_NAME = 'token'

// Versão dos assets (cache-busting). Definida no boot: cada restart/deploy gera
// uma nova versão, forçando o navegador a rebaixar o CSS em vez de servir o cache.
const ASSET_VERSION = Date.now().toString(36)

// Opções do cookie httpOnly: Secure só em produção; SameSite=Lax; Path raiz.
function cookieOptions() {
  return {
    httpOnly: true,
    secure: !config.app.isDev,
    sameSite: 'lax' as const,
    path: '/',
  }
}

// Renderiza uma página dentro do layout (duas passagens: corpo → layout).
async function renderPage(
  app: FastifyInstance,
  reply: FastifyReply,
  view: string,
  data: Record<string, unknown>,
  layoutData: Record<string, unknown> = {},
) {
  const body = await app.view(view, data)
  const html = await app.view('layout', { body, assetVersion: ASSET_VERSION, ...layoutData })
  return reply.type('text/html').send(html)
}

// ── preHandler de sessão do painel ────────────────────────────
// Lê o cookie `token`, verifica o JWT, carrega User + ApiClient e anexa
// request.apiClient + request.authUser. Em falha → redirect 302 /admin/login
// (navegação, não 401 JSON).
async function requirePanelAuth(request: FastifyRequest, reply: FastifyReply) {
  const raw = request.cookies?.[COOKIE_NAME]
  if (!raw) return reply.redirect('/admin/login')

  let payload: { userId: string; apiClientId: string; accountRole: string }
  try {
    // @fastify/jwt configurado para aceitar o cookie (server.ts).
    payload = await request.jwtVerify()
  } catch {
    return reply.redirect('/admin/login')
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: { apiClient: true },
  })
  if (!user || !user.apiClient.active) {
    return reply.redirect('/admin/login')
  }

  request.apiClient = user.apiClient
  request.authUser = { id: user.id, email: user.email, name: user.name, role: user.role }
}

// ── preHandler admin-only do painel ───────────────────────────
// Estende requirePanelAuth: além de exigir sessão válida, só permite contas
// ADMIN. Conta não-ADMIN → redirect /admin com aviso (navegação, não 403 JSON).
async function requirePanelAdmin(request: FastifyRequest, reply: FastifyReply) {
  // Reusa a verificação de sessão; se redirecionou, a resposta já foi enviada.
  await requirePanelAuth(request, reply)
  if (reply.sent) return
  // Gestão é restrita ao SUPER ADMIN (papel da pessoa), não a quem apenas pertence
  // à conta ADMIN. isSuperAdmin, no painel (com authUser), decide pelo papel do user.
  if (!isSuperAdmin(request)) {
    return reply.redirect(
      `/admin?err=${encodeURIComponent('Acesso restrito ao super admin.')}`,
    )
  }
}

// ── preHandler owner-only do painel ───────────────────────────
// Estende requirePanelAuth: além de sessão válida, exige papel OWNER (dono da
// conta) ou SUPER_ADMIN. MEMBER → redirect /admin com aviso (navegação).
async function requirePanelOwner(request: FastifyRequest, reply: FastifyReply) {
  await requirePanelAuth(request, reply)
  if (reply.sent) return
  if (!isPanelOwner(request)) {
    return reply.redirect(
      `/admin?err=${encodeURIComponent('Acesso restrito ao dono da conta.')}`,
    )
  }
}

// True quando o usuário do painel é OWNER (dono) ou SUPER_ADMIN — pode gerenciar
// o time da conta e (re)atribuir donos de instância.
function isPanelOwner(request: FastifyRequest): boolean {
  const role = request.authUser?.role
  return role === 'OWNER' || role === 'SUPER_ADMIN'
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// Formulário de criação de conta (tenant). Campos de OWNER são opcionais;
// checkboxes/HTML enviam strings, por isso normalizamos antes de validar.
const manageClientSchema = z
  .object({
    name: z.string().min(1, 'Informe o nome da conta.'),
    role: z.enum(['ADMIN', 'CLIENT']).default('CLIENT'),
    fallbackEnabled: z.boolean().default(false),
    rateLimit: z.coerce.number().int().positive().default(100),
    maxInstances: z.coerce.number().int().positive().default(1),
    maxPerRecipientPerHour: z.coerce.number().int().min(0).default(10),
    ownerEmail: z.string().email().optional(),
    ownerPassword: z.string().min(8).optional(),
    ownerName: z.string().optional(),
  })
  .refine((d) => (d.ownerEmail ? Boolean(d.ownerPassword) : true), {
    message: 'A senha do owner é obrigatória quando o e-mail é informado.',
    path: ['ownerPassword'],
  })

// Formulário de criação de usuário vinculado a uma conta existente.
const manageUserSchema = z.object({
  apiClientId: z.string().min(1, 'Selecione a conta.'),
  email: z.string().email('E-mail inválido.'),
  password: z.string().min(8, 'A senha deve ter ao menos 8 caracteres.'),
  name: z.string().optional(),
  role: z.enum(['OWNER', 'MEMBER', 'SUPER_ADMIN']).default('OWNER'),
})

// Atualização da quota (maxInstances) de uma conta — só super admin.
const manageQuotaSchema = z.object({
  maxInstances: z.coerce.number().int().positive(),
})

// Atualização do teto anti-flood por destinatário (Fase 1) — só super admin. 0 = ilimitado.
const manageLimitSchema = z.object({
  maxPerRecipientPerHour: z.coerce.number().int().min(0),
})

// Time (OWNER): criar membro da própria conta (papel sempre MEMBER).
const teamMemberSchema = z.object({
  email: z.string().email('E-mail inválido.'),
  password: z.string().min(8, 'A senha deve ter ao menos 8 caracteres.'),
  name: z.string().optional(),
})

// Time (OWNER): editar membro (nome e/ou nova senha; ao menos um).
const teamEditSchema = z
  .object({
    name: z.string().min(1).optional(),
    password: z.string().min(8).optional(),
  })
  .refine((d) => d.name !== undefined || d.password !== undefined, {
    message: 'Informe um novo nome ou uma nova senha.',
  })

// Atribuição de dono de instância (OWNER): id do membro, ou vazio para remover o dono.
const assignOwnerSchema = z.object({
  ownerUserId: z.string().min(1).nullable(),
})

// Normaliza valores de formulário HTML: strings vazias → undefined; checkbox → boolean.
function emptyToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value
}

const createInstanceSchema = z.object({
  name: z.string().optional(),
  slug: slugSchema.optional(),
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
})

// Renomear pelo painel: name e/ou slug (strings vazias viram undefined).
const renameInstanceSchema = z
  .object({
    name: z.string().min(1).optional(),
    slug: slugSchema.optional(),
  })
  .refine((d) => d.name !== undefined || d.slug !== undefined, {
    message: 'Informe ao menos um nome ou slug.',
  })

const testMessageSchema = z.object({
  to: z.string().min(10).max(20),
  body: z.string().min(1),
})

// Adicionar número ao pool pelo painel (form HTML): provider + label opcional.
const addNumberFormSchema = z.object({
  provider: z.enum(['EVOLUTION', 'WAHA', 'CLOUD_API']),
  label: z.string().min(1).optional(),
})

export async function panelRoutes(app: FastifyInstance) {
  // ── GET /login ─────────────────────────────────────────────
  app.get('/login', async (request, reply) => {
    // Se já logado (cookie válido), vai direto pro dashboard.
    if (request.cookies?.[COOKIE_NAME]) {
      try {
        await request.jwtVerify()
        return reply.redirect('/admin')
      } catch {
        // cookie inválido → mostra login normalmente
      }
    }
    return renderPage(app, reply, 'login', { title: 'Entrar — ApiEnvios' })
  })

  // ── POST /login ────────────────────────────────────────────
  app.post('/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success) {
      return renderPage(app, reply, 'login', {
        title: 'Entrar — ApiEnvios',
        error: 'Informe e-mail e senha válidos.',
        email: (request.body as any)?.email,
      })
    }

    const user = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      include: { apiClient: true },
    })

    const ok = user && user.apiClient.active
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : false

    if (!user || !ok) {
      reply.status(401)
      return renderPage(app, reply, 'login', {
        title: 'Entrar — ApiEnvios',
        error: 'Credenciais inválidas.',
        email: parsed.data.email,
      })
    }

    // Assina o MESMO JWT da API e grava em cookie httpOnly.
    const token = app.jwt.sign({
      userId: user.id,
      apiClientId: user.apiClientId,
      accountRole: user.apiClient.role,
    })
    reply.setCookie(COOKIE_NAME, token, cookieOptions())
    return reply.redirect('/admin')
  })

  // ── POST /logout ───────────────────────────────────────────
  app.post('/logout', async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, cookieOptions())
    return reply.redirect('/admin/login')
  })

  // ── GET / — Dashboard ──────────────────────────────────────
  app.get<{ Querystring: { err?: string; ok?: string } }>(
    '/',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const account = request.apiClient!
      const isAdmin = isSuperAdmin(request)
      // MEMBER vê só as suas; OWNER/super admin veem todas as da conta (Fase 3).
      // `connection` = status derivado do pool de números (fonte de verdade do envio).
      const instances = (await listInstancesWithConnection(account.id, memberScopeId(request))).map(
        (i) => ({ ...toInstanceResponse(i), connection: i.connection }),
      )
      return renderPage(
        app,
        reply,
        'dashboard',
        {
          title: 'Instâncias — ApiEnvios',
          account: { name: account.name, apiKey: account.apiKey, maxInstances: account.maxInstances },
          instances,
          isSuperAdmin: isSuperAdmin(request),
          pageError: request.query.err ? decodeURIComponent(request.query.err) : null,
          pageOk: request.query.ok ? decodeURIComponent(request.query.ok) : null,
        },
        { user: request.authUser, isAdmin, isOwner: isPanelOwner(request), activeNav: 'instances' },
      )
    },
  )

  // ── GET /docs — Documentação da API (exemplos JS/PHP/cURL) ─────
  app.get('/docs', { preHandler: requirePanelAuth }, async (request, reply) => {
    // Usa uma instância real visível ao usuário (MEMBER vê só as suas) para os
    // exemplos ficarem copy-paste prontos com id/slug/token de verdade.
    const list = await listInstances(request.apiClient!.id, memberScopeId(request))
    const first = list[0]
    const sample = first
      ? { id: first.id, slug: first.slug, token: first.token }
      : { id: 'ID_DA_INSTANCIA', slug: 'slug-da-instancia', token: 'TOKEN_DA_INSTANCIA' }
    return renderPage(
      app,
      reply,
      'docs',
      {
        title: 'Documentação — ApiEnvios',
        apiBase: config.app.apiPublicUrl,
        apiKey: request.apiClient!.apiKey,
        sample,
        // Papel do usuário → controla quais seções aparecem (esconde o que não se aplica).
        isSuperAdmin: isSuperAdmin(request),
        isOwner: isPanelOwner(request),
      },
      { user: request.authUser, isAdmin: isSuperAdmin(request), isOwner: isPanelOwner(request), activeNav: 'docs' },
    )
  })

  // ── POST /instances — Cria instância (reusa o service) ─────
  app.post('/instances', { preHandler: requirePanelAuth }, async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>
    const parsed = createInstanceSchema.safeParse({
      name: emptyToUndefined(raw.name),
      slug: emptyToUndefined(raw.slug),
      provider: raw.provider,
    })
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? 'Dados inválidos.'
      return reply.redirect(`/admin?err=${encodeURIComponent(msg)}`)
    }

    // WAHA é restrito ao super admin.
    if (parsed.data.provider === 'WAHA' && !isSuperAdmin(request)) {
      return reply.redirect(`/admin?err=${encodeURIComponent('O provider WAHA é restrito ao super admin.')}`)
    }

    try {
      // Quota por conta (super admin ignora).
      if (!isSuperAdmin(request)) {
        await assertInstanceQuota(request.apiClient!.id)
      }
      const instance = await createInstance({
        name: parsed.data.name,
        slug: parsed.data.slug,
        provider: parsed.data.provider,
        apiClientId: request.apiClient!.id,
        // Quem cria pelo painel vira dono (MEMBER vê só as suas).
        ownerUserId: request.authUser?.id ?? null,
      })
      return reply.redirect(`/admin/instances/${instance.id}`)
    } catch (err: any) {
      if (err instanceof InstanceError) {
        return reply.redirect(`/admin?err=${encodeURIComponent(err.message)}`)
      }
      request.log.error(`[Painel] Falha ao criar instância: ${err.message}`)
      return reply.redirect(`/admin?err=${encodeURIComponent('Falha ao criar a instância.')}`)
    }
  })

  // ── POST /instances/:id/rename — Renomeia name/slug (reusa o service) ─
  app.post<{ Params: { id: string } }>(
    '/instances/:id/rename',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const raw = (request.body ?? {}) as Record<string, unknown>
      const parsed = renameInstanceSchema.safeParse({
        name: emptyToUndefined(raw.name),
        slug: emptyToUndefined(raw.slug),
      })
      if (!parsed.success) {
        const msg = parsed.error.issues[0]?.message ?? 'Dados inválidos.'
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent(msg)}`,
        )
      }

      try {
        const updated = await updateInstance({
          id: instance.id,
          apiClientId: request.apiClient!.id,
          name: parsed.data.name,
          slug: parsed.data.slug,
        })
        return reply.redirect(
          `/admin/instances/${updated.id}?ok=${encodeURIComponent('Instância renomeada com sucesso.')}`,
        )
      } catch (err: any) {
        if (err instanceof InstanceError) {
          return reply.redirect(
            `/admin/instances/${instance.id}?err=${encodeURIComponent(err.message)}`,
          )
        }
        request.log.error(`[Painel] Falha ao renomear instância: ${err.message}`)
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao renomear a instância.')}`,
        )
      }
    },
  )

  // ── POST /instances/:id/delete — Apaga a instância (cascata) ─
  // POST porque form HTML não emite DELETE. Escopo por papel (MEMBER só a sua).
  // Reusa deleteInstanceCascade: remove números/mensagens/tentativas/rotações + sessão
  // no provider (best-effort), evitando o erro de FK do delete direto.
  app.post<{ Params: { id: string } }>(
    '/instances/:id/delete',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      try {
        await deleteInstanceCascade(instance.id, request.log)
        return reply.redirect(`/admin?ok=${encodeURIComponent(`Instância "${instance.name || instance.slug || instance.id}" apagada.`)}`)
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao apagar instância: ${err.message}`)
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao apagar a instância.')}`)
      }
    },
  )

  // ── GET /instances/:id — Detalhe (aceita id OU slug) ───────
  app.get<{ Params: { id: string }; Querystring: { sent?: string; ok?: string; err?: string } }>(
    '/instances/:id',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const messages = await prisma.message.findMany({
        where: { instanceId: instance.id, apiClientId: request.apiClient!.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      })

      // C4: números do pool (InstanceNumber). O contador "enviadas hoje" agora vem
      // da soma dos números (C3 moveu os contadores p/ o pool) — somamos aqui.
      const numbers = await listNumbers(instance.id)
      const sentTodayTotal = numbers.reduce((acc, n) => acc + n.sentToday, 0)

      // Atribuição de dono (só OWNER): lista membros atribuíveis (OWNER/MEMBER da conta).
      const canAssignOwner = isPanelOwner(request)
      const members = canAssignOwner
        ? (await listUsers(request.apiClient!.id)).filter((u) => u.role !== 'SUPER_ADMIN')
        : []

      return renderPage(
        app,
        reply,
        'instance',
        {
          title: `${instance.name || 'Instância'} — ApiEnvios`,
          instance: toInstanceResponse(instance),
          messages,
          numbers,
          sentTodayTotal,
          apiBase: config.app.apiPublicUrl,
          isSuperAdmin: isSuperAdmin(request),
          canAssignOwner,
          members,
          sent: request.query.sent === '1',
          ok: request.query.ok ? decodeURIComponent(request.query.ok) : null,
          sendError: request.query.err ? decodeURIComponent(request.query.err) : null,
        },
        { user: request.authUser, isAdmin: isSuperAdmin(request), isOwner: canAssignOwner, activeNav: 'instances' },
      )
    },
  )

  // ── POST /instances/:id/test — Envia mensagem de teste (reusa a fila) ─
  app.post<{ Params: { id: string } }>(
    '/instances/:id/test',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const parsed = testMessageSchema.safeParse(request.body)
      if (!parsed.success) {
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent('Preencha destino e mensagem.')}`,
        )
      }

      try {
        const message = await prisma.message.create({
          data: {
            apiClientId: request.apiClient!.id,
            instanceId: instance.id,
            toPhone: normalizePhone(parsed.data.to),
            type: 'TEXT',
            content: parsed.data.body,
            status: 'QUEUED',
          },
        })
        await enqueueSend(message.id, message.maxRetries)
        return reply.redirect(`/admin/instances/${instance.id}?sent=1`)
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao enfileirar teste: ${err.message}`)
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao enfileirar a mensagem.')}`,
        )
      }
    },
  )

  // ── POST /instances/:id/messages/:msgId/resend — Reenvia (FAILED) ─
  app.post<{ Params: { id: string; msgId: string } }>(
    '/instances/:id/messages/:msgId/resend',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const message = await prisma.message.findFirst({
        where: { id: request.params.msgId, apiClientId: request.apiClient!.id, instanceId: instance.id },
      })
      if (!message) {
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Mensagem não encontrada.')}`)
      }
      if (message.status !== 'FAILED') {
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Só reenvia mensagens com falha.')}`)
      }

      try {
        const updated = await prisma.message.update({
          where: { id: message.id },
          data: { status: 'QUEUED', retryCount: 0, errorMessage: null, failedAt: null },
        })
        await requeueSend(updated.id, updated.maxRetries)
        return reply.redirect(`/admin/instances/${instance.id}?ok=${encodeURIComponent('Mensagem reenfileirada.')}`)
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao reenviar mensagem: ${err.message}`)
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao reenviar.')}`)
      }
    },
  )

  // ── POST /instances/:id/messages/:msgId/delete — Remove do histórico ─
  app.post<{ Params: { id: string; msgId: string } }>(
    '/instances/:id/messages/:msgId/delete',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const message = await prisma.message.findFirst({
        where: { id: request.params.msgId, apiClientId: request.apiClient!.id, instanceId: instance.id },
        select: { id: true },
      })
      if (!message) {
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Mensagem não encontrada.')}`)
      }

      try {
        await prisma.$transaction([
          prisma.messageAttempt.deleteMany({ where: { messageId: message.id } }),
          prisma.message.delete({ where: { id: message.id } }),
        ])
        await removeSendJob(message.id)
        return reply.redirect(`/admin/instances/${instance.id}?ok=${encodeURIComponent('Mensagem removida do histórico.')}`)
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao excluir mensagem: ${err.message}`)
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao excluir.')}`)
      }
    },
  )

  // ══════════════════════════════════════════════════════════
  // C4 — Gestão dos NÚMEROS do pool (InstanceNumber) pelo painel.
  // Forms HTML (add/delete via POST + redirect ?ok=/?err=) e endpoints
  // finos JSON p/ Alpine (connect/qr/status por número). Reusa o service C2.
  // ══════════════════════════════════════════════════════════

  // ── POST /instances/:id/numbers — Adiciona número ao pool ──
  app.post<{ Params: { id: string } }>(
    '/instances/:id/numbers',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const raw = (request.body ?? {}) as Record<string, unknown>
      const parsed = addNumberFormSchema.safeParse({
        provider: raw.provider,
        label: emptyToUndefined(raw.label),
      })
      if (!parsed.success) {
        const msg = parsed.error.issues[0]?.message ?? 'Dados inválidos.'
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent(msg)}`,
        )
      }

      // WAHA restrito ao super admin.
      if (parsed.data.provider === 'WAHA' && !isSuperAdmin(request)) {
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent('O provider WAHA é restrito ao super admin.')}`,
        )
      }

      try {
        await addNumber({
          instanceId: instance.id,
          provider: parsed.data.provider,
          label: parsed.data.label,
          apiClientId: request.apiClient!.id,
        })
        return reply.redirect(
          `/admin/instances/${instance.id}?ok=${encodeURIComponent('Número adicionado ao pool.')}`,
        )
      } catch (err: any) {
        if (err instanceof InstanceError) {
          return reply.redirect(
            `/admin/instances/${instance.id}?err=${encodeURIComponent(err.message)}`,
          )
        }
        request.log.error(`[Painel] Falha ao adicionar número: ${err.message}`)
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao adicionar o número.')}`,
        )
      }
    },
  )

  // ── POST /instances/:id/numbers/:numberId/delete — Remove número ──
  // POST porque formulário HTML não emite DELETE nativamente.
  app.post<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/delete',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.redirect('/admin')

      const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
      if (!number || number.instanceId !== instance.id) {
        return reply.redirect(
          `/admin/instances/${instance.id}?err=${encodeURIComponent('Número não encontrado.')}`,
        )
      }

      await deleteNumber(number.id, request.apiClient!.id, request.log)
      return reply.redirect(
        `/admin/instances/${instance.id}?ok=${encodeURIComponent('Número removido do pool.')}`,
      )
    },
  )

  // ── POST /instances/:id/numbers/:numberId/connect (JSON p/ Alpine) ──
  app.post<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/connect',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
      if (!number || number.instanceId !== instance.id) {
        return reply.status(404).send({ error: 'Número não encontrado' })
      }

      try {
        const result = await connectNumber(number, request.log)
        return reply.send(result)
      } catch (err: any) {
        request.log.error(`[Painel] number connect falhou (${number.provider}): ${err.message}`)
        return reply.status(502).send({
          error: 'Falha ao conectar no provider',
          provider: number.provider,
          detail: err?.response?.data?.message ?? err.message,
        })
      }
    },
  )

  // ── GET /instances/:id/numbers/:numberId/qr (JSON p/ Alpine) ──
  app.get<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/qr',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
      if (!number || number.instanceId !== instance.id) {
        return reply.status(404).send({ error: 'Número não encontrado' })
      }
      if (number.provider === 'CLOUD_API') {
        return reply.status(400).send({ error: 'Cloud API não utiliza QR Code' })
      }

      const expired = !number.qrExpiresAt || number.qrExpiresAt.getTime() < Date.now()
      if (number.qrCode && !expired) {
        return reply.send({
          qrCode: number.qrCode,
          qrExpiresAt: number.qrExpiresAt,
          connectionState: number.connectionState,
        })
      }

      try {
        const updated = await refreshQrNumber(number)
        return reply.send({
          qrCode: updated.qrCode,
          qrExpiresAt: updated.qrExpiresAt,
          connectionState: updated.connectionState,
        })
      } catch (err: any) {
        request.log.error(`[Painel] number qr falhou (${number.provider}): ${err.message}`)
        return reply.status(502).send({ error: 'Falha ao renovar QR no provider' })
      }
    },
  )

  // ── GET /instances/:id/numbers/:numberId/status (JSON p/ Alpine) ──
  app.get<{ Params: { id: string; numberId: string } }>(
    '/instances/:id/numbers/:numberId/status',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      const number = await findNumberScoped(request.params.numberId, request.apiClient!.id)
      if (!number || number.instanceId !== instance.id) {
        return reply.status(404).send({ error: 'Número não encontrado' })
      }

      try {
        const connectionState = await syncNumberStatus(number)
        return reply.send({ connectionState })
      } catch (err: any) {
        request.log.error(`[Painel] number status falhou (${number.provider}): ${err.message}`)
        // Degrada graciosamente: devolve o estado conhecido (sem 502 ruidoso).
        return reply.send({ connectionState: number.connectionState, stale: true })
      }
    },
  )

  // ══════════════════════════════════════════════════════════
  // Gestão admin-only: contas (tenants) e usuários (reusa o service
  // de provisionamento — MESMA regra de negócio da API REST admin).
  // ══════════════════════════════════════════════════════════

  // ── GET /manage — Página de gestão (contas + usuários) ─────
  app.get<{ Querystring: { ok?: string; err?: string } }>(
    '/manage',
    { preHandler: requirePanelAdmin },
    async (request, reply) => {
      const [clients, users] = await Promise.all([listClients(), listUsers()])
      // Mapa id→nome da conta para exibir o tenant de cada usuário na tabela.
      const clientNames: Record<string, string> = {}
      for (const c of clients) clientNames[c.id] = c.name

      return renderPage(
        app,
        reply,
        'manage',
        {
          title: 'Gestão — ApiEnvios',
          // user no corpo da view (layoutData é separado) para marcar "você".
          user: request.authUser,
          currentClientId: request.apiClient!.id,
          clients,
          users,
          clientNames,
          ok: request.query.ok ? decodeURIComponent(request.query.ok) : null,
          err: request.query.err ? decodeURIComponent(request.query.err) : null,
        },
        { user: request.authUser, isAdmin: true, activeNav: 'manage' },
      )
    },
  )

  // ── POST /manage/clients — Cria conta (+ OWNER opcional) ───
  app.post('/manage/clients', { preHandler: requirePanelAdmin }, async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>
    const parsed = manageClientSchema.safeParse({
      name: raw.name,
      role: emptyToUndefined(raw.role),
      // Checkbox HTML: presente ('on'/'true') ⇒ true; ausente ⇒ false.
      fallbackEnabled: raw.fallbackEnabled === 'on' || raw.fallbackEnabled === 'true',
      rateLimit: emptyToUndefined(raw.rateLimit),
      maxInstances: emptyToUndefined(raw.maxInstances),
      maxPerRecipientPerHour: emptyToUndefined(raw.maxPerRecipientPerHour),
      ownerEmail: emptyToUndefined(raw.ownerEmail),
      ownerPassword: emptyToUndefined(raw.ownerPassword),
      ownerName: emptyToUndefined(raw.ownerName),
    })

    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? 'Dados inválidos.'
      return reply.redirect(`/admin/manage?err=${encodeURIComponent(msg)}`)
    }

    try {
      const { client } = await createClientWithOwner(parsed.data)
      return reply.redirect(
        `/admin/manage?ok=${encodeURIComponent(`Conta "${client.name}" criada com sucesso.`)}`,
      )
    } catch (err: any) {
      if (err instanceof ProvisioningError && err.code === 'EMAIL_TAKEN') {
        return reply.redirect(
          `/admin/manage?err=${encodeURIComponent('E-mail de owner já cadastrado.')}`,
        )
      }
      request.log.error(`[Painel] Falha ao criar conta: ${err.message}`)
      return reply.redirect(
        `/admin/manage?err=${encodeURIComponent('Falha ao criar a conta.')}`,
      )
    }
  })

  // ── POST /manage/users — Cria usuário vinculado a uma conta ─
  app.post('/manage/users', { preHandler: requirePanelAdmin }, async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>
    const parsed = manageUserSchema.safeParse({
      apiClientId: raw.apiClientId,
      email: raw.email,
      password: raw.password,
      name: emptyToUndefined(raw.name),
      role: emptyToUndefined(raw.role),
    })

    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? 'Dados inválidos.'
      return reply.redirect(`/admin/manage?err=${encodeURIComponent(msg)}`)
    }

    try {
      const user = await createUserForClient(parsed.data)
      return reply.redirect(
        `/admin/manage?ok=${encodeURIComponent(`Usuário "${user.email}" criado com sucesso.`)}`,
      )
    } catch (err: any) {
      if (err instanceof ProvisioningError) {
        const msg =
          err.code === 'CLIENT_NOT_FOUND'
            ? 'Conta selecionada não encontrada.'
            : 'E-mail já cadastrado.'
        return reply.redirect(`/admin/manage?err=${encodeURIComponent(msg)}`)
      }
      request.log.error(`[Painel] Falha ao criar usuário: ${err.message}`)
      return reply.redirect(
        `/admin/manage?err=${encodeURIComponent('Falha ao criar o usuário.')}`,
      )
    }
  })

  // ── POST /manage/users/:id/delete — Remove usuário ─────────
  // POST porque formulário HTML não emite DELETE nativamente.
  app.post<{ Params: { id: string } }>(
    '/manage/users/:id/delete',
    { preHandler: requirePanelAdmin },
    async (request, reply) => {
      // Trava de segurança: admin não pode remover a própria conta de acesso.
      if (request.params.id === request.authUser!.id) {
        return reply.redirect(
          `/admin/manage?err=${encodeURIComponent('Você não pode remover o próprio usuário.')}`,
        )
      }
      const removed = await deleteUser(request.params.id)
      const msg = removed ? 'Usuário removido.' : 'Usuário não encontrado.'
      const key = removed ? 'ok' : 'err'
      return reply.redirect(`/admin/manage?${key}=${encodeURIComponent(msg)}`)
    },
  )

  // ── POST /manage/clients/:id/quota — Atualiza a quota (maxInstances) ─
  app.post<{ Params: { id: string } }>(
    '/manage/clients/:id/quota',
    { preHandler: requirePanelAdmin },
    async (request, reply) => {
      const parsed = manageQuotaSchema.safeParse({
        maxInstances: (request.body as Record<string, unknown>)?.maxInstances,
      })
      if (!parsed.success) {
        return reply.redirect(
          `/admin/manage?err=${encodeURIComponent('Quota inválida (use um inteiro positivo).')}`,
        )
      }
      try {
        await prisma.apiClient.update({
          where: { id: request.params.id },
          data: { maxInstances: parsed.data.maxInstances },
        })
        return reply.redirect(
          `/admin/manage?ok=${encodeURIComponent('Quota atualizada.')}`,
        )
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao atualizar quota: ${err.message}`)
        return reply.redirect(`/admin/manage?err=${encodeURIComponent('Falha ao atualizar a quota.')}`)
      }
    },
  )

  // ── POST /manage/clients/:id/limit — Teto anti-flood por destinatário (Fase 1) ─
  app.post<{ Params: { id: string } }>(
    '/manage/clients/:id/limit',
    { preHandler: requirePanelAdmin },
    async (request, reply) => {
      const parsed = manageLimitSchema.safeParse({
        maxPerRecipientPerHour: (request.body as Record<string, unknown>)?.maxPerRecipientPerHour,
      })
      if (!parsed.success) {
        return reply.redirect(
          `/admin/manage?err=${encodeURIComponent('Limite inválido (use 0 ou um inteiro positivo).')}`,
        )
      }
      try {
        await updateClient(request.params.id, { maxPerRecipientPerHour: parsed.data.maxPerRecipientPerHour })
        return reply.redirect(`/admin/manage?ok=${encodeURIComponent('Limite por destinatário atualizado.')}`)
      } catch (err: any) {
        if (err instanceof ProvisioningError && err.code === 'CLIENT_NOT_FOUND') {
          return reply.redirect(`/admin/manage?err=${encodeURIComponent('Conta não encontrada.')}`)
        }
        request.log.error(`[Painel] Falha ao atualizar limite: ${err.message}`)
        return reply.redirect(`/admin/manage?err=${encodeURIComponent('Falha ao atualizar o limite.')}`)
      }
    },
  )

  // ── POST /manage/clients/:id/toggle-active — Ativa/desativa a conta ─
  app.post<{ Params: { id: string } }>(
    '/manage/clients/:id/toggle-active',
    { preHandler: requirePanelAdmin },
    async (request, reply) => {
      const current = await prisma.apiClient.findUnique({
        where: { id: request.params.id },
        select: { active: true },
      })
      if (!current) {
        return reply.redirect(`/admin/manage?err=${encodeURIComponent('Conta não encontrada.')}`)
      }
      try {
        const updated = await updateClient(request.params.id, { active: !current.active })
        const msg = updated.active ? 'Conta ativada.' : 'Conta desativada.'
        return reply.redirect(`/admin/manage?ok=${encodeURIComponent(msg)}`)
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao alternar status: ${err.message}`)
        return reply.redirect(`/admin/manage?err=${encodeURIComponent('Falha ao alterar o status da conta.')}`)
      }
    },
  )

  // ── POST /manage/clients/:id/delete — Apaga DEFINITIVAMENTE a conta (cascata) ─
  app.post<{ Params: { id: string } }>(
    '/manage/clients/:id/delete',
    { preHandler: requirePanelAdmin },
    async (request, reply) => {
      // Salvaguarda: não apagar a própria conta autenticada (perderia o acesso).
      if (request.apiClient?.id === request.params.id) {
        return reply.redirect(
          `/admin/manage?err=${encodeURIComponent('Você não pode apagar a própria conta.')}`,
        )
      }
      try {
        const removed = await deleteClientCascade(request.params.id, request.log)
        const msg = removed ? 'Conta e todos os dados relacionados foram apagados.' : 'Conta não encontrada.'
        const key = removed ? 'ok' : 'err'
        return reply.redirect(`/admin/manage?${key}=${encodeURIComponent(msg)}`)
      } catch (err: any) {
        request.log.error(`[Painel] Falha ao apagar conta (cascata): ${err.message}`)
        return reply.redirect(`/admin/manage?err=${encodeURIComponent('Falha ao apagar a conta.')}`)
      }
    },
  )

  // ══════════════════════════════════════════════════════════
  // Endpoints finos JSON p/ Alpine (mesmos serviços da API REST)
  // ══════════════════════════════════════════════════════════

  // ── POST /instances/:id/connect ────────────────────────────
  app.post<{ Params: { id: string } }>(
    '/instances/:id/connect',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      try {
        const result = await connectInstance(instance, request.log)
        return reply.send(result)
      } catch (err: any) {
        request.log.error(`[Painel] connect falhou (${instance.provider}): ${err.message}`)
        return reply.status(502).send({
          error: 'Falha ao conectar no provider',
          provider: instance.provider,
          detail: err?.response?.data?.message ?? err.message,
        })
      }
    },
  )

  // ── GET /instances/:id/qr ──────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/instances/:id/qr',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })
      if (instance.provider === 'CLOUD_API') {
        return reply.status(400).send({ error: 'Cloud API não utiliza QR Code' })
      }

      const expired = !instance.qrExpiresAt || instance.qrExpiresAt.getTime() < Date.now()
      if (instance.qrCode && !expired) {
        return reply.send({
          qrCode: instance.qrCode,
          qrExpiresAt: instance.qrExpiresAt,
          connectionState: instance.connectionState,
        })
      }

      try {
        const updated = await refreshQr(instance)
        return reply.send({
          qrCode: updated.qrCode,
          qrExpiresAt: updated.qrExpiresAt,
          connectionState: updated.connectionState,
        })
      } catch (err: any) {
        request.log.error(`[Painel] qr falhou (${instance.provider}): ${err.message}`)
        return reply.status(502).send({ error: 'Falha ao renovar QR no provider' })
      }
    },
  )

  // ── GET /instances/:id/status ──────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/instances/:id/status',
    { preHandler: requirePanelAuth },
    async (request, reply) => {
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id, memberScopeId(request))
      if (!instance) return reply.status(404).send({ error: 'Instância não encontrada' })

      try {
        const connectionState = await syncInstanceStatus(instance)
        return reply.send({ connectionState })
      } catch (err: any) {
        request.log.error(`[Painel] status falhou (${instance.provider}): ${err.message}`)
        // Degrada graciosamente para o painel: devolve o estado conhecido (sem 502 ruidoso).
        return reply.send({ connectionState: instance.connectionState, stale: true })
      }
    },
  )

  // ══════════════════════════════════════════════════════════
  // OWNER — atribuição de dono de instância + gestão de time
  // (expõe a Fase 3 no painel). Guard: requirePanelOwner.
  // ══════════════════════════════════════════════════════════

  // ── POST /instances/:id/owner — (Re)atribui o dono da instância ─
  app.post<{ Params: { id: string } }>(
    '/instances/:id/owner',
    { preHandler: requirePanelOwner },
    async (request, reply) => {
      // OWNER enxerga todas as da conta — sem escopo de membro aqui.
      const instance = await findInstanceByIdOrSlug(request.params.id, request.apiClient!.id)
      if (!instance) return reply.redirect('/admin')

      const raw = (request.body ?? {}) as Record<string, unknown>
      const parsed = assignOwnerSchema.safeParse({ ownerUserId: emptyToUndefined(raw.ownerUserId) ?? null })
      if (!parsed.success) {
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Dono inválido.')}`)
      }

      try {
        await assignInstanceOwner({
          instanceId: instance.id,
          apiClientId: request.apiClient!.id,
          ownerUserId: parsed.data.ownerUserId,
        })
        return reply.redirect(`/admin/instances/${instance.id}?ok=${encodeURIComponent('Dono da instância atualizado.')}`)
      } catch (err: any) {
        if (err instanceof InstanceError) {
          return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent(err.message)}`)
        }
        request.log.error(`[Painel] Falha ao atribuir dono: ${err.message}`)
        return reply.redirect(`/admin/instances/${instance.id}?err=${encodeURIComponent('Falha ao atribuir o dono.')}`)
      }
    },
  )

  // ── GET /team — Gestão de time da própria conta (OWNER) ────
  app.get<{ Querystring: { ok?: string; err?: string } }>(
    '/team',
    { preHandler: requirePanelOwner },
    async (request, reply) => {
      const users = await listUsers(request.apiClient!.id)
      return renderPage(
        app,
        reply,
        'team',
        {
          title: 'Meu time — ApiEnvios',
          user: request.authUser,
          users,
          ok: request.query.ok ? decodeURIComponent(request.query.ok) : null,
          err: request.query.err ? decodeURIComponent(request.query.err) : null,
        },
        { user: request.authUser, isAdmin: isSuperAdmin(request), isOwner: true, activeNav: 'team' },
      )
    },
  )

  // ── POST /team/users — Cria um MEMBER na própria conta ─────
  app.post('/team/users', { preHandler: requirePanelOwner }, async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>
    const parsed = teamMemberSchema.safeParse({
      email: raw.email,
      password: raw.password,
      name: emptyToUndefined(raw.name),
    })
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? 'Dados inválidos.'
      return reply.redirect(`/admin/team?err=${encodeURIComponent(msg)}`)
    }
    try {
      await createUserForClient({
        apiClientId: request.apiClient!.id,
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
        role: 'MEMBER', // TRAVADO: OWNER não cria OWNER/SUPER_ADMIN.
      })
      return reply.redirect(`/admin/team?ok=${encodeURIComponent('Membro adicionado.')}`)
    } catch (err: any) {
      if (err instanceof ProvisioningError && err.code === 'EMAIL_TAKEN') {
        return reply.redirect(`/admin/team?err=${encodeURIComponent('E-mail já cadastrado.')}`)
      }
      request.log.error(`[Painel] Falha ao criar membro: ${err.message}`)
      return reply.redirect(`/admin/team?err=${encodeURIComponent('Falha ao criar o membro.')}`)
    }
  })

  // ── POST /team/users/:id/edit — Edita um MEMBER da própria conta ─
  app.post<{ Params: { id: string } }>(
    '/team/users/:id/edit',
    { preHandler: requirePanelOwner },
    async (request, reply) => {
      const raw = (request.body ?? {}) as Record<string, unknown>
      const parsed = teamEditSchema.safeParse({
        name: emptyToUndefined(raw.name),
        password: emptyToUndefined(raw.password),
      })
      if (!parsed.success) {
        return reply.redirect(`/admin/team?err=${encodeURIComponent('Informe um novo nome ou senha.')}`)
      }
      // Alvo precisa ser MEMBER da PRÓPRIA conta (anti-escalonamento / cross-tenant).
      const target = await prisma.user.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id, role: 'MEMBER' },
        select: { id: true },
      })
      if (!target) return reply.redirect(`/admin/team?err=${encodeURIComponent('Membro não encontrado.')}`)

      await updateUser(target.id, { name: parsed.data.name, password: parsed.data.password })
      return reply.redirect(`/admin/team?ok=${encodeURIComponent('Membro atualizado.')}`)
    },
  )

  // ── POST /team/users/:id/delete — Apaga um MEMBER da própria conta ─
  app.post<{ Params: { id: string } }>(
    '/team/users/:id/delete',
    { preHandler: requirePanelOwner },
    async (request, reply) => {
      const target = await prisma.user.findFirst({
        where: { id: request.params.id, apiClientId: request.apiClient!.id, role: 'MEMBER' },
        select: { id: true },
      })
      if (!target) return reply.redirect(`/admin/team?err=${encodeURIComponent('Membro não encontrado.')}`)

      await deleteUser(target.id)
      return reply.redirect(`/admin/team?ok=${encodeURIComponent('Membro removido.')}`)
    },
  )
}
