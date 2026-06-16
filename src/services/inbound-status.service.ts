// src/services/inbound-status.service.ts
// Parse TOLERANTE dos callbacks inbound de cada provider.
// Cada provider tem um formato de payload diferente; extraímos o `providerId`
// (ID da mensagem no provider) e mapeamos o status de entrega para MessageStatus.
import type { Provider, MessageStatus, InboundStatusUpdate, InstanceConnState } from '../types'

// Ranking do funil de entrega — usado para garantir que o status só AVANÇA.
const STATUS_RANK: Record<string, number> = {
  QUEUED: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
}

// Retorna true se `next` é um avanço em relação a `current` no funil de entrega.
export function isStatusAdvance(current: MessageStatus, next: MessageStatus): boolean {
  const c = STATUS_RANK[current]
  const n = STATUS_RANK[next]
  // Se algum não estiver no funil (FAILED/CANCELLED/SCHEDULED), não sobrescreve.
  if (c === undefined || n === undefined) return false
  return n > c
}

// ── Evolution ─────────────────────────────────────────────────
// Eventos: messages.update / MESSAGES_UPDATE → status de entrega.
//          connection.update → connectionState. qrcode.updated → qrCode.
function mapEvolution(payload: any): InboundStatusUpdate | null {
  const event = String(payload?.event ?? payload?.type ?? '').toLowerCase()
  const data = payload?.data ?? payload

  // connection.update → estado de conexão
  if (event.includes('connection')) {
    const state = String(data?.state ?? data?.connection ?? '').toLowerCase()
    const connectionState = mapEvolutionConnState(state)
    return { providerId: '', connectionState }
  }

  // qrcode.updated → novo QR
  if (event.includes('qrcode')) {
    const qrCode = data?.qrcode?.base64 ?? data?.base64 ?? data?.qrcode
    return { providerId: '', qrCode: typeof qrCode === 'string' ? qrCode : undefined }
  }

  // messages.update (default) → status de entrega
  const providerId = data?.keyId ?? data?.key?.id ?? data?.id
  const rawStatus = String(data?.status ?? data?.update?.status ?? '').toUpperCase()
  const status = mapEvolutionAck(rawStatus)
  if (!providerId) return null
  return { providerId: String(providerId), status }
}

function mapEvolutionAck(raw: string): MessageStatus | undefined {
  switch (raw) {
    case 'DELIVERY_ACK':
      return 'DELIVERED'
    case 'READ':
    case 'PLAYED':
      return 'READ'
    case 'SERVER_ACK':
    case 'SENT':
      return 'SENT'
    default:
      return undefined
  }
}

function mapEvolutionConnState(state: string): InstanceConnState | undefined {
  switch (state) {
    case 'open':
      return 'CONNECTED'
    case 'close':
      return 'DISCONNECTED'
    case 'connecting':
      return 'QR_PENDING'
    default:
      return undefined
  }
}

// ── WAHA ──────────────────────────────────────────────────────
// Eventos: message.ack → status de entrega. session.status / state.change → connectionState.
function mapWaha(payload: any): InboundStatusUpdate | null {
  const event = String(payload?.event ?? '').toLowerCase()
  const p = payload?.payload ?? payload

  if (event.includes('session') || event.includes('state')) {
    const raw = String(p?.status ?? p?.state ?? payload?.status ?? '').toUpperCase()
    return { providerId: '', connectionState: mapWahaSessionState(raw) }
  }

  // message.ack (default)
  const providerId = p?.id ?? p?.ackId ?? p?.messageId
  const ackName = String(p?.ackName ?? '').toUpperCase()
  const ackNum = typeof p?.ack === 'number' ? p.ack : Number(p?.ack)
  const status = mapWahaAck(ackNum, ackName)
  if (!providerId) return null
  return { providerId: String(providerId), status }
}

function mapWahaAck(ack: number | undefined, ackName: string): MessageStatus | undefined {
  // ackName tem prioridade quando presente
  if (ackName === 'DEVICE') return 'DELIVERED'
  if (ackName === 'READ' || ackName === 'PLAYED') return 'READ'
  if (ackName === 'SERVER') return 'SENT'
  // Fallback numérico: 1=SENT(server), 2=DELIVERED(device), 3=READ
  switch (ack) {
    case 1:
      return 'SENT'
    case 2:
      return 'DELIVERED'
    case 3:
    case 4:
      return 'READ'
    default:
      return undefined
  }
}

function mapWahaSessionState(raw: string): InstanceConnState | undefined {
  switch (raw) {
    case 'WORKING':
    case 'CONNECTED':
      return 'CONNECTED'
    case 'STOPPED':
    case 'FAILED':
      return 'DISCONNECTED'
    case 'STARTING':
    case 'SCAN_QR_CODE':
      return 'QR_PENDING'
    default:
      return undefined
  }
}

// ── Cloud API ─────────────────────────────────────────────────
// Estrutura: entry[].changes[].value.statuses[] com { id, status: sent|delivered|read }.
function mapCloudApi(payload: any): InboundStatusUpdate | null {
  const statuses =
    payload?.entry?.[0]?.changes?.[0]?.value?.statuses ??
    payload?.statuses
  const st = Array.isArray(statuses) ? statuses[0] : undefined
  if (!st) return null
  const providerId = st?.id
  const status = mapCloudApiStatus(String(st?.status ?? '').toLowerCase())
  if (!providerId) return null
  return { providerId: String(providerId), status }
}

function mapCloudApiStatus(raw: string): MessageStatus | undefined {
  switch (raw) {
    case 'sent':
      return 'SENT'
    case 'delivered':
      return 'DELIVERED'
    case 'read':
      return 'READ'
    default:
      return undefined
  }
}

// ── Dispatcher ────────────────────────────────────────────────
// Recebe o provider (já normalizado para o enum) e o payload bruto; retorna o update
// parseado ou null se o payload não puder ser interpretado.
export function mapInboundStatus(provider: Provider, payload: any): InboundStatusUpdate | null {
  try {
    switch (provider) {
      case 'EVOLUTION':
        return mapEvolution(payload)
      case 'WAHA':
        return mapWaha(payload)
      case 'CLOUD_API':
        return mapCloudApi(payload)
      default:
        return null
    }
  } catch {
    return null
  }
}

// Normaliza o param :provider da rota (case-insensitive) para o enum Provider.
export function normalizeProvider(raw: string): Provider | null {
  switch (raw.toLowerCase()) {
    case 'evolution':
      return 'EVOLUTION'
    case 'waha':
      return 'WAHA'
    case 'cloud_api':
    case 'cloudapi':
    case 'cloud-api':
      return 'CLOUD_API'
    default:
      return null
  }
}
