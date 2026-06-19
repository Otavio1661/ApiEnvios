// src/services/instance.service.ts
// Lógica compartilhada de instâncias (gestão/QR/status) reusada tanto pela API REST
// (src/routes/instances.route.ts) quanto pelo painel web (src/web/panel.route.ts).
// NÃO contém regra de negócio nova: apenas centraliza o que antes estava inline na rota.
import type { Instance } from '@prisma/client'
import type { FastifyBaseLogger } from 'fastify'
import { prisma } from '../utils/prisma'
import { config } from '../config'
import { providers } from '../providers'

// Tempo de validade do QR em segundos
export const QR_TTL_SECONDS = 45

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
    // Já existe no provider: reconecta para obter o QR atual (sem recriar)
    const result = await provider.connect(providerInstanceId)
    qrCode = result.qrCode
  }

  return prisma.instance.update({
    where: { id: instance.id },
    data: {
      instanceId: providerInstanceId,
      qrCode: qrCode ?? null,
      qrExpiresAt: new Date(Date.now() + QR_TTL_SECONDS * 1000),
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

export function createInstance(input: {
  name?: string
  provider: Instance['provider']
  priority?: number
  apiClientId: string
}) {
  return prisma.instance.create({
    data: {
      name: input.name,
      provider: input.provider,
      priority: input.priority ?? 0,
      apiClientId: input.apiClientId,
    },
  })
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

  await registerInboundWebhook(instance, log)
  const updated = await refreshQr(instance)
  return {
    instanceId: updated.instanceId,
    qrCode: updated.qrCode,
    qrExpiresAt: updated.qrExpiresAt,
    connectionState: updated.connectionState,
  }
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
