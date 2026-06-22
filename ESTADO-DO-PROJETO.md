# Estado do Projeto — ApiEnvios

> Documento de contexto consolidado. Última atualização: **2026-06-22**.
> Serve para retomar o desenvolvimento sabendo exatamente o que existe, o que falta,
> como o ambiente está montado e quais bugs ainda precisam ser resolvidos.
> Complementa `CONTEXT.md` (fases 0–5) e `CONTEXT-fases-6-8.md` (fases 6–8).

---

## 1. O que é o projeto

Plataforma **multi-instância multi-tenant** de envio de WhatsApp, no modelo **UltraMsg**
(ponte: Sistemas → ApiEnvios → usuários). Cada conta (tenant) tem **instâncias**; cada
instância é um **pool de números** (ver Fase C). Aplicações externas autenticam por
**token de instância**; o dono da conta gerencia por **API key de conta**; humanos entram
no **painel web** por login JWT (cookie).

Suporta 3 providers (**Evolution / WAHA / Cloud API**). O **fallback automático entre
providers é OPT-IN por tenant** (`ApiClient.fallbackEnabled`). Objetivo: entregabilidade
com isolamento por tenant e **mitigação de ban** (espaçamento anti-ban serializado, warm-up,
rodízio de números).

### Stack
Node 20+ · TypeScript · **Fastify 4** · Prisma 5 (PostgreSQL 16) · Redis 7 + BullMQ ·
Zod · Pino · Eta (painel server-rendered) + Alpine.js (CDN) · Vitest. Docker Compose para a infra.

> **Pin importante:** os plugins `@fastify/*` estão fixados nas majors compatíveis com
> **Fastify 4** (`cookie@^9`, `static@^7`, `view@^9`, `formbody@^7`). As majors v10/v11
> exigem Fastify 5 e **quebram o boot** — não subir sem migrar o Fastify.

---

## 2. ✅ O que já foi feito

### Fases 0–5 (núcleo) — concluídas
- **Fase 0:** migrations versionadas.
- **Fase 1:** multi-tenancy + token por instância; guards `authAccount`/`authInstance`/`requireAdmin`; escopo por tenant em todas as queries.
- **Fase 2:** ciclo de vida da instância + QR (estilo UltraMsg); envio por token.
- **Fase 3:** fila BullMQ + worker (retry/backoff); jobs repetíveis (reset-counters, scheduled-messages); `sendWithFallback` opt-in.
- **Fase 4:** webhooks inbound de status (Evolution/WAHA/Cloud → SENT→DELIVERED→READ).
- **Fase 5:** rate limit por tenant (Redis), anti-ban serializado por instância (lock Redis), health check, warm-up dinâmico, logger Pino.

### Fases 6–8 — concluídas
- **Fase 6:** usuários + login JWT (criação só pelo admin). Modelo `User`, guards `authJwt`/`authManage`, rotas `/v1/auth/*` e `/v1/admin/*`, `provisioning.service.ts` compartilhado (REST + painel).
- **Fase 7:** painel web server-rendered (`/admin`) — login, dashboard, detalhe da instância, QR via polling, envio de teste, logout, **e a tela admin-only `/admin/manage`** (gestão de contas/usuários).
- **Fase 8:** testes Vitest — `buildApp()` extraído de `server.ts`; unitários + integração (`app.inject`, mock de prisma/redis). `tsc --noEmit` limpo; suíte verde.

### Admin do painel via ambiente
Usuário admin inicial criado pelo seed a partir de variáveis **opcionais**:
`ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` / `ADMIN_SEED_NAME` (lidas em `src/config/index.ts`,
aplicadas em `prisma/seed.ts` por upsert). **Vazias ⇒ seed roda sem criar admin.** Sem
credenciais hardcoded no código (só no `.env`).

### Correções (2026-06-19)
- `waha.provider.ts` persiste `providerId` (NOWEB retorna em `key.id`) — fecha o casamento do inbound DELIVERED/READ.
- TOCTOU de e-mail: P2002 → `EMAIL_TAKEN` → 409 (não 500).
- Seed WAHA aponta para a sessão `default`; `.trim()` nas vars `ADMIN_SEED_*`.

### Ajustes do painel de instâncias (2026-06-19) — pedido do usuário, em fases

| Fase | Entrega | Commit |
|------|---------|--------|
| **A — QR Code** | WAHA NOWEB devolve `/auth/qr` como **PNG binário** (não JSON `{value}`); `getQr` agora pede `format=image` (arraybuffer) e converte p/ `data:image/png;base64,...`. Validado (PNG `89504e47`). | `2ff8d3d` |
| **B — Nome + slug** | `Instance.slug` (único global, usável na URL `/v1/instance/<slug>/...`) + apelido único por conta (`@@unique([apiClientId, name])`); lookup por **id OU slug**; `PATCH /v1/instances/:id` (rename); UI de renomear. Isolamento entre tenants preservado. | `1de9c3e` |
| **C1 — Modelo pool** | Novo model **`InstanceNumber`** (filho da Instance) com provider/providerInstanceId/phone/status/connectionState/qrCode/contadores/ban. Migração **aditiva** (backfill 1 número por instância). | `1fde0dd` |
| **C2 — Conexão por número** | Service + REST `/v1/instances/:id/numbers...` (add/list/connect/qr/status/delete), escrito no `InstanceNumber`, escopado por tenant; webhook inbound por número (aditivo). | `5445576` |
| **C3 — Roteamento anti-ban** | Envio escolhe o **número** do pool (CONNECTED, ACTIVE/WARMING, sob limite diário, **menos usado**); ban/rotação por número; `Message.numberId`; reset reseta números; `dailyLimitFor` aceita `{status,createdAt}`. Single-number pool = comportamento idêntico ao atual. | `815998e` |
| **C4 — UI do pool** | Seção "Números do pool" no painel: listar/adicionar/conectar/QR/status/remover por número (Alpine `numberPanel`), stats somando `InstanceNumber.sentToday`. | `973ebfa` |

---

## 3. 🏗️ Arquitetura do pool (Fase C) — como ficou

```
ApiClient (tenant)
  └── Instance (POOL nomeado: name único por conta, slug único global, token de envio)
        └── InstanceNumber[] (cada número/sessão real: provider, providerInstanceId,
                              phone, connectionState, qrCode, contadores anti-ban, ban tracking)
```

- **Envio:** cliente manda para a **instância** (por token). O roteador escolhe o melhor
  `InstanceNumber` do pool (conectado, não banido, abaixo do limite diário, **menos usado**)
  e envia por aquele número. Ban detectado → marca o número, registra `NumberRotation`, rotaciona.
- **Provider do pool:** **Evolution** (suporta multi-instância nativo). **WAHA é edição CORE**
  (só 1 sessão `default`) — serve como 1 número extra, não para múltiplos.
- **Transição:** `Instance.*` (contadores/ban) não são mais escritos no envio (vivem no número).
  Migrações foram **aditivas** (nenhuma coluna removida) — limpeza das colunas legadas da Instance
  fica para o futuro.

---

## 4. 🐛 O que falta / bugs conhecidos (passada única, combinada com o usuário)

| # | Item | Prioridade |
|---|------|------------|
| 1 | **Evolution não devolve o QR** — `connect` responde `200` `QR_PENDING` mas `qrCode: null`. Bug em `evolution.provider.ts` (QR provavelmente em outro campo/endpoint). **Destrava o uso real do pool.** | 🔴 Alta |
| 2 | **WAHA Core só aceita sessão `default`** — instância WAHA tentando `inst-<id>` retorna 502 "get WAHA PLUS". Tratar/avisar na UI; múltiplos números → Evolution. | 🟡 Média |
| 3 | **Raiz `/` → 404 JSON** — adicionar redirect `/` → `/admin`. | 🟢 Baixa |
| 4 | **Slug: dupla normalização** — slug explícito é re-`slugify()` sem revalidar; pode gravar slug vazio/curto em borda. | 🟢 Baixa |
| 5 | **`console.error` em `src/utils/redis.ts:14`** — trocar por logger Pino. | 🟢 Baixa |
| 6 | **WAHA `default` desconectado** — durante testes de QR foi feito logout; número 554497341687 precisa re-escanear (operacional, não é código). | — |
| 7 | **Stats agregados da Instance** — telas que somavam `Instance.sentToday` foram ajustadas no detalhe (C4), mas vale revisar outras telas/endpoints (`/v1/instances/stats`) para somar `InstanceNumber`. | 🟢 Baixa |

### Roadmap maior (futuro, fora do escopo imediato)
- **Produção/Deploy:** Dockerfile multi-stage; métricas Prometheus (`/metrics`).
- **Funcionalidades:** templates Cloud API (mensagens proativas); gestão de membros pela conta (OWNER convida MEMBER).
- **Dívida técnica:** cache de tenant (Redis); assinatura/secret nos webhooks inbound; convergir `/v1/numbers*` → `/v1/instances*` e remover legado; health check notificar em `BANNED`; remover colunas legadas da Instance após a transição da Fase C.

---

## 5. 🖥️ Ambiente de desenvolvimento

Tudo roda via Docker Compose:

| Container | Porta | Observação |
|-----------|-------|------------|
| `apienvios_app` | 3002 | App (volume do código + `node_modules` em volume anônimo) |
| `apienvios_postgres` | 5432 | db `apienvios` / user `apienvios` / senha `senha123` |
| `apienvios_redis` | 6379 | filas + locks anti-ban + rate-limit |
| `apienvios_waha` | 3078 | edição **CORE** (1 sessão `default`), engine NOWEB |
| `apienvios_evolution` | 8081 | suporta multi-instância |

### Painel
- URL: **http://localhost:3002/admin/login**
- Admin: `otavio.silva1661@gmail.com` / `admin123` (configurável via `.env`)

### ⚠️ GOTCHA do container
O `node_modules` do `apienvios_app` é um **volume anônimo separado**. Após mudança de schema
Prisma ou de dependências é preciso:
```bash
docker exec apienvios_app npm install            # se mudou deps
docker exec apienvios_app npx prisma migrate deploy
docker exec apienvios_app npx prisma generate
docker restart apienvios_app
```
Sem isso o client Prisma fica **stale** e o login retorna **500** (`prisma.user` undefined).
Os QAs que rodam a app local (`tsx`) não pegam esse problema — só o container.

---

## 6. ✅ Qualidade / estado técnico

- `npx tsc --noEmit` **limpo**.
- Suíte Vitest **verde** (≈82 testes + 1 skip justificado).
- Migrações **versionadas e aditivas**; **backup do banco** feito antes da Fase C
  (`C:\dev\ApiEnvios-backups\`).
- Todo o código está no GitHub (`origin/main`).

### Processo de desenvolvimento adotado
Cada mudança passa por um fluxo **multi-agente**: desenvolvedor sênior → verificador (aderência
ao plano) → avaliador de contexto → QA (testa rotas + envio real). Padrões obrigatórios:
Fastify · Zod · Prisma · **PT-BR** em mensagens/comentários · **Pino** (nada de `console.*`) ·
`tsc --noEmit` limpo + validação de runtime por fase.

---

## 7. Próximo passo

**Passada única de bugs** (seção 4), começando pelo **#1 (Evolution QR)** — é o que destrava
o uso real do pool de números. Depois, os itens de baixa prioridade e, eventualmente, o
roadmap maior.
