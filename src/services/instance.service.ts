// src/services/instance.service.ts
// Lógica compartilhada de instâncias (gestão/QR/status) reusada tanto pela API REST
// (src/routes/instances.route.ts) quanto pelo painel web (src/web/panel.route.ts).
// NÃO contém regra de negócio nova: apenas centraliza o que antes estava inline na rota.
import { Prisma, type Instance, type InstanceNumber, type Provider } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { prisma } from '../utils/prisma'
import { config } from '../config'
import { providers } from '../providers'
import { slugify } from '../utils/slug'

// Tempo de validade do QR em segundos
export const QR_TTL_SECONDS = 45

// Erro de negócio das operações de instância (ex.: nome/slug duplicado).
// O caller decide o mapeamento: API REST → status HTTP (409); painel → ?err=.
export class InstanceError extends Error {
  constructor(
    message: string,
    public readonly code: 'NAME_TAKEN' | 'SLUG_TAKEN' | 'NOT_FOUND',
  ) {
    super(message)
    this.name = 'InstanceError'
  }
}

// Identifica violação de unicidade do Prisma (P2002) e diz qual coluna bateu.
// Usado para distinguir conflito de slug (global) de conflito de name (por tenant).
function uniqueViolationTarget(err: unknown): 'slug' | 'name' | 'other' | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return null
  }
  const target = err.meta?.target
  const fields = Array.isArray(target) ? target.join(',') : String(target ?? '')
  if (fields.includes('slug')) return 'slug'
  if (fields.includes('name')) return 'name'
  return 'other'
}

// Gera um slug único GLOBAL a partir de uma base, adicionando sufixo numérico
// em caso de colisão (vendas-sp, vendas-sp-2, vendas-sp-3...). Reusado no
// backfill e na criação de instância. `ignoreId` permite ignorar a própria
// instância ao renomear.
export async function generateUniqueSlug(base: string, ignoreId?: string): Promise<string> {
  const root = slugify(base) || 'instancia'
  let candidate = root
  let n = 1
  // Loop limitado a colisões reais; na prática para em 1–2 iterações.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await prisma.instance.findUnique({
      where: { slug: candidate },
      select: { id: true },
    })
    if (!existing || existing.id === ignoreId) return candidate
    n += 1
    candidate = `${root}-${n}`
  }
}

// Monta a representação UltraMsg da instância, incluindo apiUrl pública.
export function toInstanceResponse(instance: Instance) {
  return {
    ...instance,
    apiUrl: `${config.app.publicBaseUrl}/v1/instance/${instance.id}`,
  }
}

// URL pública da API da instância (coluna "API URL" do painel).
export function instanceApiUrl(instance: Pick<Instance, 'id'>): string {
  return `${config.app.publicBaseUrl}/v1/instance/${instance.id}`
}

// Mapeia o status do provider para o connectionState do banco.
export function mapConnectionState(
  status: string,
  current: Instance['connectionState'],
): Instance['connectionState'] {
  switch (status) {
    case 'connected':
      return 'CONNECTED'
    case 'disconnected':
      return 'DISCONNECTED'
    case 'qr_required':
      return 'QR_PENDING'
    case 'banned':
      return 'BANNED'
    default:
      return current // 'unknown' → mantém o estado atual
  }
}

// Cria a instância no provider na 1ª vez (persistindo instanceId) e renova o QR
// via connect(). Centraliza a lógica compartilhada entre connect e qr.
// Retorna a instância atualizada. Lança em caso de erro do provider.
export async function refreshQr(instance: Instance): Promise<Instance> {
  const provider = providers[instance.provider]
  let providerInstanceId = instance.instanceId
  let qrCode: string | undefined

  if (!providerInstanceId) {
    // 1ª conexão: cria a instância no provider e persiste o instanceId
    const created = await provider.createInstance(`inst-${instance.id}`)
    providerInstanceId = created.instanceId
    qrCode = created.qrCode
  } else {
    // Já existe no provider: reconecta para obter o QR atual (sem recriar).
    // Auto-recuperação: se a sessão sumiu no provider (404), recria com o mesmo nome.
    try {
      const result = await provider.connect(providerInstanceId)
      qrCode = result.qrCode
    } catch (err: any) {
      if (err?.response?.status === 404) {
        const created = await provider.createInstance(providerInstanceId)
        providerInstanceId = created.instanceId
        qrCode = created.qrCode
      } else {
        throw err
      }
    }
  }

  // O QR da Evolution v2 chega de forma assíncrona via webhook (QRCODE_UPDATED).
  // Aqui o provider pode devolver vazio: nesse caso NÃO sobrescrevemos o qrCode
  // já persistido (evita "apagar" um QR válido). O TTL só é renovado quando há
  // QR novo vindo do provider.
  return prisma.instance.update({
    where: { id: instance.id },
    data: {
      instanceId: providerInstanceId,
      qrCode: qrCode ?? instance.qrCode,
      ...(qrCode ? { qrExpiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000) } : {}),
      connectionState: 'QR_PENDING',
    },
  })
}

// Registra a URL de webhook inbound no provider (best-effort).
// Não lança: falha aqui não deve bloquear o connect (logamos e seguimos).
export async function registerInboundWebhook(
  instance: Instance,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const provider = providers[instance.provider]
    const providerInstanceId = instance.instanceId ?? `inst-${instance.id}`
    const url = `${config.app.publicBaseUrl}/v1/webhooks/inbound/${instance.provider.toLowerCase()}/${instance.id}`
    await provider.setWebhook(providerInstanceId, url)
    log.info(`[Instances] webhook inbound registrado (${instance.provider}): ${url}`)
  } catch (err: any) {
    log.warn(`[Instances] setWebhook falhou (${instance.provider}, best-effort): ${err.message}`)
  }
}

// ── Operações de alto nível (escopadas por tenant) ───────────────
// Reusadas por API e painel. Todas recebem apiClientId para garantir o escopo.

export function listInstances(apiClientId: string) {
  return prisma.instance.findMany({
    where: { apiClientId },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })
}

export function findInstanceScoped(id: string, apiClientId: string) {
  return prisma.instance.findFirst({ where: { id, apiClientId } })
}

// Resolve a instância por id OU slug, sempre escopada ao tenant. Usada pelas
// rotas REST/painel que aceitam tanto o cuid quanto o slug amigável na URL.
export function findInstanceByIdOrSlug(idOrSlug: string, apiClientId: string) {
  return prisma.instance.findFirst({
    where: { apiClientId, OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
  })
}

// Cria a instância.
// - slug EXPLÍCITO: respeitado tal qual (apenas normalizado p/ kebab-case). Se já
//   existir, o banco rejeita (P2002) → InstanceError('SLUG_TAKEN') [409]. O usuário
//   pediu aquele slug específico, então não o "renomeamos" silenciosamente.
// - slug DERIVADO (do name/provider, quando não informado): gerado com sufixo numérico
//   em colisão, para que a criação nunca falhe por slug.
// Conflito de name por tenant → InstanceError('NAME_TAKEN').
export async function createInstance(input: {
  name?: string
  slug?: string
  provider: Instance['provider']
  priority?: number
  apiClientId: string
}): Promise<Instance> {
  const slug = input.slug
    ? slugify(input.slug)
    : await generateUniqueSlug(input.name ?? input.provider.toLowerCase())

  try {
    return await prisma.instance.create({
      data: {
        name: input.name,
        slug,
        provider: input.provider,
        priority: input.priority ?? 0,
        apiClientId: input.apiClientId,
      },
    })
  } catch (err) {
    throw mapUniqueViolation(err)
  }
}

// Atualiza name e/ou slug de uma instância (renomear), escopado por tenant.
// Valida unicidade (global p/ slug; por tenant p/ name) e mapeia P2002 → InstanceError.
// Lança InstanceError('NOT_FOUND') se a instância não for do tenant.
export async function updateInstance(input: {
  id: string
  apiClientId: string
  name?: string
  slug?: string
}): Promise<Instance> {
  const existing = await prisma.instance.findFirst({
    where: { id: input.id, apiClientId: input.apiClientId },
  })
  if (!existing) {
    throw new InstanceError('Instância não encontrada', 'NOT_FOUND')
  }

  const data: Prisma.InstanceUpdateInput = {}
  if (input.name !== undefined) data.name = input.name || null
  if (input.slug !== undefined) {
    // Slug informado no rename é respeitado tal qual (só normalizado). Colisão com
    // OUTRA instância → P2002 → InstanceError('SLUG_TAKEN') [409] no catch abaixo.
    data.slug = slugify(input.slug)
  }

  try {
    return await prisma.instance.update({ where: { id: existing.id }, data })
  } catch (err) {
    throw mapUniqueViolation(err)
  }
}

// Converte P2002 do Prisma em InstanceError tratável (slug/name); relança o resto.
function mapUniqueViolation(err: unknown): unknown {
  const target = uniqueViolationTarget(err)
  if (target === 'slug') return new InstanceError('Slug já está em uso', 'SLUG_TAKEN')
  if (target === 'name') return new InstanceError('Nome já está em uso nesta conta', 'NAME_TAKEN')
  return err
}

// Resultado de uma conexão: ou QR (provider com fluxo de QR) ou já conectado (Cloud API).
export interface ConnectResult {
  instanceId: string | null
  qrCode: string | null
  qrExpiresAt: Date | null
  connectionState: Instance['connectionState']
}

// Conecta a instância: Cloud API vira CONNECTED; demais geram/renova QR.
// Registra o webhook inbound (best-effort) antes do createInstance.
// Lança em caso de erro do provider (caller decide o status HTTP — 502).
export async function connectInstance(
  instance: Instance,
  log: FastifyBaseLogger,
): Promise<ConnectResult> {
  if (instance.provider === 'CLOUD_API') {
    const updated = await prisma.instance.update({
      where: { id: instance.id },
      data: { connectionState: 'CONNECTED', qrCode: null, qrExpiresAt: null },
    })
    return {
      instanceId: updated.instanceId,
      qrCode: null,
      qrExpiresAt: null,
      connectionState: updated.connectionState,
    }
  }

  // Webhook ANTES e DEPOIS de criar/renovar a sessão (mesma razão de connectNumber):
  // WAHA precisa do pendingWebhookUrl antes do create; Evolution só aceita setWebhook
  // após a sessão `inst-<id>` existir. registerInboundWebhook é best-effort (idempotente).
  await registerInboundWebhook(instance, log)
  const updated = await refreshQr(instance)
  await registerInboundWebhook(updated, log)
  return {
    instanceId: updated.instanceId,
    qrCode: updated.qrCode,
    qrExpiresAt: updated.qrExpiresAt,
    connectionState: updated.connectionState,
  }
}

// ── Fase C1: pool de números (InstanceNumber) ────────────────────
// Helpers ADITIVOS. Nesta fase o roteamento/QR/envio NÃO usa estes números
// (continua usando os campos da Instance). C2/C3/C4 religam a lógica aqui.

// Lista os números de uma instância, em ordem de prioridade (menor = primeiro).
export function listNumbers(instanceId: string): Promise<InstanceNumber[]> {
  return prisma.instanceNumber.findMany({
    where: { instanceId },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
  })
}

// Cria um número (InstanceNumber) sob uma instância.
export function createNumber(input: {
  instanceId: string
  provider: Provider
  label?: string
  priority?: number
}): Promise<InstanceNumber> {
  return prisma.instanceNumber.create({
    data: {
      instanceId: input.instanceId,
      provider: input.provider,
      label: input.label,
      priority: input.priority ?? 0,
    },
  })
}

// Busca um número por id garantindo que pertence a uma instância do tenant
// (escopo via instance.apiClientId). Retorna null se não for do tenant.
export function findNumberScoped(
  numberId: string,
  apiClientId: string,
): Promise<InstanceNumber | null> {
  return prisma.instanceNumber.findFirst({
    where: { id: numberId, instance: { apiClientId } },
  })
}

// ── Fase C2: conexão/QR/status POR NÚMERO + gestão do pool ───────
// Operações ADITIVAS que ESPELHAM as de Instance (connectInstance/refreshQr/
// syncInstanceStatus/registerInboundWebhook), mas escrevem no InstanceNumber.
// NÃO alteram roteamento/envio/reset (isso é C3). Todas escopadas por tenant
// via instance.apiClientId.

// Adiciona um número (InstanceNumber) sob uma instância do tenant.
// Valida que a instância pertence ao tenant (senão InstanceError NOT_FOUND).
export async function addNumber(input: {
  instanceId: string
  provider: Provider
  label?: string
  priority?: number
  apiClientId: string
}): Promise<InstanceNumber> {
  const instance = await prisma.instance.findFirst({
    where: { id: input.instanceId, apiClientId: input.apiClientId },
    select: { id: true },
  })
  if (!instance) {
    throw new InstanceError('Instância não encontrada', 'NOT_FOUND')
  }

  return createNumber({
    instanceId: instance.id,
    provider: input.provider,
    label: input.label,
    priority: input.priority,
  })
}

// Registra a URL de webhook inbound POR NÚMERO no provider (best-effort).
// A URL aponta para o identificador do número (.../number/:numberId), de forma
// ADITIVA ao caminho por instância. Não lança: falha aqui não bloqueia o connect.
export async function registerNumberInboundWebhook(
  number: InstanceNumber,
  log: FastifyBaseLogger,
): Promise<void> {
  try {
    const provider = providers[number.provider]
    const providerInstanceId = number.providerInstanceId ?? `num-${number.id}`
    const url = `${config.app.publicBaseUrl}/v1/webhooks/inbound/${number.provider.toLowerCase()}/number/${number.id}`
    await provider.setWebhook(providerInstanceId, url)
    log.info(`[Numbers] webhook inbound registrado (${number.provider}): ${url}`)
  } catch (err: any) {
    log.warn(`[Numbers] setWebhook falhou (${number.provider}, best-effort): ${err.message}`)
  }
}

// Cria a sessão no provider na 1ª vez (persistindo providerInstanceId) e renova
// o QR via connect(). Espelha refreshQr() mas escreve no InstanceNumber.
// Lança em caso de erro do provider.
export async function refreshQrNumber(number: InstanceNumber): Promise<InstanceNumber> {
  const provider = providers[number.provider]
  let providerInstanceId = number.providerInstanceId
  let qrCode: string | undefined

  if (!providerInstanceId) {
    // 1ª conexão: cria a sessão no provider e persiste o providerInstanceId
    const created = await provider.createInstance(`num-${number.id}`)
    providerInstanceId = created.instanceId
    qrCode = created.qrCode
  } else {
    // Já existe no provider: reconecta para obter o QR atual (sem recriar).
    // Auto-recuperação: se a sessão sumiu no provider (404 — ex.: deletada
    // manualmente ou perdida), recria com o mesmo nome em vez de falhar.
    try {
      const result = await provider.connect(providerInstanceId)
      qrCode = result.qrCode
    } catch (err: any) {
      if (err?.response?.status === 404) {
        const created = await provider.createInstance(providerInstanceId)
        providerInstanceId = created.instanceId
        qrCode = created.qrCode
      } else {
        throw err
      }
    }
  }

  // O QR da Evolution v2 chega de forma assíncrona via webhook (QRCODE_UPDATED).
  // Aqui o provider pode devolver vazio: nesse caso NÃO sobrescrevemos o qrCode
  // já persistido (evita "apagar" um QR válido). O TTL só é renovado quando há
  // QR novo vindo do provider.
  return prisma.instanceNumber.update({
    where: { id: number.id },
    data: {
      providerInstanceId,
      qrCode: qrCode ?? number.qrCode,
      ...(qrCode ? { qrExpiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000) } : {}),
      connectionState: 'QR_PENDING',
    },
  })
}

// Conecta o número: Cloud API vira CONNECTED; demais geram/renova QR.
// Espelha connectInstance() escrevendo no InstanceNumber. Registra o webhook
// inbound por número (best-effort). Lança em caso de erro do provider.
export async function connectNumber(
  number: InstanceNumber,
  log: FastifyBaseLogger,
): Promise<ConnectResult> {
  if (number.provider === 'CLOUD_API') {
    const updated = await prisma.instanceNumber.update({
      where: { id: number.id },
      data: { connectionState: 'CONNECTED', qrCode: null, qrExpiresAt: null },
    })
    return {
      instanceId: updated.providerInstanceId,
      qrCode: null,
      qrExpiresAt: null,
      connectionState: updated.connectionState,
    }
  }

  // Webhook registrado ANTES e DEPOIS de criar/renovar a sessão, pois os providers
  // diferem:
  //  - WAHA: o setWebhook precisa vir ANTES (guarda pendingWebhookUrl, que entra no
  //    config da sessão criada em refreshQrNumber). A 2ª chamada é um PUT idempotente.
  //  - Evolution: a sessão `num-<id>` só existe APÓS refreshQrNumber; antes dela o
  //    setWebhook retorna 404 (best-effort, sem efeito). A 2ª chamada (com a sessão
  //    já criada) é a que efetivamente registra o webhook para o QRCODE_UPDATED.
  // registerNumberInboundWebhook é best-effort (não lança), então a chamada redundante
  // é segura.
  await registerNumberInboundWebhook(number, log)
  const updated = await refreshQrNumber(number)
  await registerNumberInboundWebhook(updated, log)
  return {
    instanceId: updated.providerInstanceId,
    qrCode: updated.qrCode,
    qrExpiresAt: updated.qrExpiresAt,
    connectionState: updated.connectionState,
  }
}

// Consulta o status no provider e persiste o connectionState mapeado no número.
// Espelha syncInstanceStatus(). Lança em caso de erro do provider.
export async function syncNumberStatus(
  number: InstanceNumber,
): Promise<InstanceNumber['connectionState']> {
  const provider = providers[number.provider]
  const providerStatus = await provider.getInstanceStatus(number.providerInstanceId ?? 'default')
  const connectionState = mapConnectionState(providerStatus, number.connectionState)
  await prisma.instanceNumber.update({
    where: { id: number.id },
    data: { connectionState },
  })
  return connectionState
}

// Remove um número do pool (escopado por tenant). Best-effort no provider:
// tenta deleteInstance(providerInstanceId) e segue mesmo em caso de falha.
// Retorna false se o número não for do tenant (404 no caller).
export async function deleteNumber(
  numberId: string,
  apiClientId: string,
  log?: FastifyBaseLogger,
): Promise<boolean> {
  const number = await findNumberScoped(numberId, apiClientId)
  if (!number) return false

  if (number.providerInstanceId) {
    try {
      await providers[number.provider].deleteInstance(number.providerInstanceId)
    } catch (err: any) {
      log?.warn(`[Numbers] Falha ao remover número no provider (best-effort): ${err.message}`)
    }
  }

  await prisma.instanceNumber.delete({ where: { id: number.id } })
  return true
}

// Consulta o status no provider e persiste o connectionState mapeado.
// Lança em caso de erro do provider (caller decide o status HTTP).
export async function syncInstanceStatus(
  instance: Instance,
): Promise<Instance['connectionState']> {
  const provider = providers[instance.provider]
  const providerStatus = await provider.getInstanceStatus(instance.instanceId ?? 'default')
  const connectionState = mapConnectionState(providerStatus, instance.connectionState)
  await prisma.instance.update({
    where: { id: instance.id },
    data: { connectionState },
  })
  return connectionState
}
