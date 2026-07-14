// src/providers/index.ts
// Registry único de providers. Fonte única das instâncias dos providers,
// usada por provider-router.service.ts e instances.route.ts (evita duplicação).
import { EvolutionProvider } from './evolution.provider'
import { WuzapiProvider } from './wuzapi.provider'
import { CloudApiProvider } from './cloudapi.provider'
import type { IWhatsappProvider, Provider } from '../types'

export const providers: Record<Provider, IWhatsappProvider> = {
  EVOLUTION: new EvolutionProvider(),
  WUZAPI: new WuzapiProvider(),
  CLOUD_API: new CloudApiProvider(),
}
