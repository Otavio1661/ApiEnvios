// src/providers/index.ts
// Registry único de providers. Fonte única das instâncias dos providers,
// usada por provider-router.service.ts e instances.route.ts (evita duplicação).
import { EvolutionProvider } from './evolution.provider'
import { WahaProvider } from './waha.provider'
import { CloudApiProvider } from './cloudapi.provider'
import type { IWhatsappProvider, Provider } from '../types'

export const providers: Record<Provider, IWhatsappProvider> = {
  EVOLUTION: new EvolutionProvider(),
  WAHA: new WahaProvider(),
  CLOUD_API: new CloudApiProvider(),
}
