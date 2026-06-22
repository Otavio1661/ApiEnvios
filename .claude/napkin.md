# Napkin — ApiEnvios

## Ambiente (servidor r4server, Docker)

- Containers: `apienvios_app` (3002), `apienvios_postgres` (**5433**→5432, dedicado), `apienvios_redis` (6379), `apienvios_evolution` (8081), `apienvios_waha` (3078). Rede `apienvios_apienvios_net`.
- Acesso remoto: `https://dev-api.r4dev.com.br` (API) e `https://dev-app.r4dev.com.br` (painel). Tunnel cloudflare dedicado `apienvios` (serviço systemd `cloudflared-apienvios`).
- Painel admin: `otavio.silva1661@gmail.com` / `admin123`. API keys seed: `admin-key-123456` (ADMIN), `dev-key-123456` (conta dev).
- Evolution apikey: `evolution-key-dev-123`.

## GOTCHA: docker-compose 1.29.2 quebrado neste host

`docker-compose up -d <svc>` falha com `KeyError: 'ContainerConfig'` ao RECRIAR um serviço (incompatível com Docker engine novo). Workaround: `docker rm -f <container>` (inclusive órfãos `<hash>_<nome>`) ANTES do `up`. Para serviços sem volume persistente (evolution), subir via `docker run` direto na rede `apienvios_apienvios_net` com `--network-alias` evita o bug. PENDÊNCIA: instalar plugin `docker compose` v2.

## GOTCHA: env nova no compose exige recriar (não `restart`)

`docker restart` NÃO relê env do compose. Mudou env? `docker rm -f` + `docker-compose up -d` (ou docker run).

## GOTCHA: node_modules é volume anônimo no apienvios_app

Após mudar deps/schema: `docker exec apienvios_app npm install && npx prisma generate && npx prisma migrate deploy` + restart. Senão Prisma fica stale → login 500.

## Bug #1 (Evolution QR) — ✅ RESOLVIDO PONTA A PONTA (2026-06-22)

Validado: criar número Evolution → connect → `GET .../qr` retorna `data:image/png;base64,...` em ~3s (critério ≤15s), QR persiste no polling, zero ECONNREFUSED. WAHA sem regressão.

Três correções combinadas:
1. **`PUBLIC_BASE_URL=http://app:3002`** (compose/.env) — antes era default `localhost:3000`, inalcançável do container evolution.
2. **Ordem do webhook** — `connectNumber`/`connectInstance` (`instance.service.ts`) e rota `instances.route.ts` agora registram o webhook ANTES **e** DEPOIS do refreshQr (best-effort, idempotente): WAHA precisa antes (pendingWebhookUrl entra no config da sessão), Evolution precisa depois (sessão `num-<id>`/`inst-<id>` só existe após o create; antes dá 404). Também: carimbar `qrExpiresAt` no webhook e não sobrescrever QR com null no polling.
3. **`CONFIG_SESSION_PHONE_VERSION=2.3000.1035194821`** — ESSENCIAL. A Evolution 2.2.3 com Baileys travava em loop de reconexão (`{count:0}`, nunca emitia QR). A versão do WhatsApp Web tem que ser a ATUAL (pegar de Baileys `baileys-version.json`). Valores velhos (ex.: 2.2413.51 de 2024) NÃO funcionam. Se voltar a quebrar no futuro, atualizar esse valor para a versão corrente do WhatsApp Web.

## Self-heal de sessão (2026-06-22)

`refreshQr`/`refreshQrNumber` (`instance.service.ts`): se `provider.connect()` der 404 (sessão sumiu no provider — deletada/perdida), AUTO-RECRIA via createInstance com o mesmo nome. Antes, isso fazia o painel retornar **502** ("Erro de rede ao conectar") na seção Números do pool. Corrigido e testado.

## ATENÇÃO: instância CONNECTED ≠ número do pool CONNECTED

Há DUAS sessões Evolution por instância: `inst-<id>` (nível instância, legado) e `num-<id>` (cada número do pool). O ENVIO (Fase C3) roteia pelo NÚMERO DO POOL. Escanear o QR da instância NÃO habilita envio — tem que conectar (escanear QR) o NÚMERO em "Números do pool". Mensagem com `numberId: None` + FAILED = nenhum número do pool conectado. Possível melhoria de UX futura: unificar/clarificar no painel.

## Sessões Evolution órfãs

Deletar instância/número no nosso banco NÃO deleta a sessão na Evolution → vira órfã e gera `[Inbound] Número inexistente` repetido. Limpar via `DELETE /instance/delete/<name>` na Evolution comparando `fetchInstances` com o DB.

## PENDÊNCIA: Evolution roda via `docker run`, não pelo compose

Por causa do bug do docker-compose 1.29.2, a Evolution foi recriada via `docker run` (com `--restart unless-stopped`, volta no reboot). O `docker-compose.yml` está atualizado e correto (é a fonte da verdade), mas um `docker-compose up` direto falha. Ao instalar `docker compose` v2, recriar tudo pelo compose para alinhar.

## Pipeline multi-agente (definido pelo usuário)

Avaliador (spec) → Dev Sênior (implementa) → Analista (aderência) → QA (testa runtime+rotas). Não commitar (usuário decide).
