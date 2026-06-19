# CONTEXT — Fases 6 a 8 (ApiEnvios)

> Mapeamento detalhado das Fases 6, 7 e 8 com **estado real verificado no código**
> (auditoria em 2026-06-18). Complementa o `CONTEXT.md` da raiz (Fases 0–5).
> Legenda de status: ✅ concluído · 🟡 parcial/opcional pendente · ⛔ não iniciado.
>
> Obs.: o destino originalmente pedido (`.claude/`) é um diretório protegido nesta
> sessão e não pôde ser gravado; por isso o arquivo está na raiz do projeto.

---

## Visão geral do estado

| Fase | Tema | Status | Resumo |
|------|------|--------|--------|
| 6 | Usuários + login JWT (criação só pelo admin) | ✅ Concluída | Modelo `User`, JWT, guards `authJwt`/`authManage`, rotas de auth e admin, seed OWNER, migration aplicada |
| 7 | Painel web server-rendered (estilo UltraMsg) | ✅ Concluída | `src/web/` com login/dashboard/detalhe, QR via polling, envio de teste, logout **e a tela admin-only de gestão de contas/usuários** (`/admin/manage`) |
| 8 | Testes automatizados (Vitest) | ✅ Concluída | Vitest + coverage, `buildApp()` extraído, unitários (inbound-status, warmup, rate-gate, provider-router) + integração (`app.inject`). `tsc --noEmit` limpo, **41 testes passando / 1 skip justificado (429)** |

> **Atualização 2026-06-19:** Fases 7 (tela admin) e 8 (testes) concluídas e validadas em runtime
> (fluxo multi-agente: dev → verificador → avaliador de contexto → QA). Envio real para WhatsApp
> confirmado (`SENT` via WAHA). Detalhes atualizados nas seções abaixo.

---

## Fase 6 — Usuários + login JWT (criação SOMENTE pelo admin) — ✅

**Decisão reafirmada:** não há self-service. Só o admin da plataforma cria contas e usuários;
usuários comuns apenas logam e gerenciam suas próprias instâncias.

### Mapeamento arquivo → entrega

| Item do plano | Arquivo | Status | Observações |
|---------------|---------|--------|-------------|
| Modelo `User` + enum `UserRole` | `prisma/schema.prisma` (L186–202, enum L250–253) | ✅ | `id, email @unique, passwordHash, name?, role @default(OWNER), emailVerified, apiClientId+relação, timestamps`; `@@index([apiClientId])` |
| Relação `users User[]` em `ApiClient` | `prisma/schema.prisma` (L178) | ✅ | |
| Migration | `prisma/migrations/20260617190448_fase6_users/` | ✅ | aplicada |
| Hashing bcryptjs | `src/utils/password.ts` | ✅ | `hashPassword`/`verifyPassword` (JS puro, evita build nativo no Windows) |
| Registro `@fastify/jwt` | `src/server.ts` (L50–54) | ✅ | secret = `config.app.jwtSecret`; aceita Bearer **e** cookie `token` |
| Guard `authJwt` | `src/middlewares/auth.middleware.ts` (L129–154) | ✅ | valida JWT, carrega `User`+`ApiClient`, anexa `request.apiClient` + `request.authUser` |
| Guard combinado `authManage` (API key **ou** JWT) | `src/middlewares/auth.middleware.ts` (L163–177) | ✅ | heurística: 3 segmentos com ponto ⇒ JWT; senão API key (mantém compat. programática) |
| `authManage` aplicado às rotas de gestão | `instances.route.ts`, `messages.route.ts`, `webhooks.route.ts` | ✅ | confirmado em todos os preHandlers |
| Login público (sem register) | `src/routes/auth.route.ts` | ✅ | `POST /v1/auth/login`, `GET /v1/auth/me`, `POST /v1/auth/change-password`. **Não há rota de cadastro.** |
| Provisionamento admin-only | `src/routes/admin.route.ts` | ✅ | `POST /v1/admin/clients` (cria tenant + OWNER opcional, transação atômica, 409 se email existe), `POST/GET /v1/admin/users`, `DELETE /v1/admin/users/:id` — todos `[authAccount, requireAdmin]` |
| Config JWT | `src/config/index.ts` (L21–22, L71) | ✅ | `JWT_SECRET` (fallback dev), `JWT_EXPIRES_IN` (`'7d'`); aviso se secret default |
| Seed usuário OWNER dev | `prisma/seed.ts` (L38–50) | ✅ | OWNER do cliente dev, senha `dev123456` |
| `User.emailVerified` (flag stub) | `prisma/schema.prisma` (L192) | ✅ | sem infra de envio (conforme plano) |

**Validação esperada (manual / quando o shell voltar):** admin cria conta+owner via
`POST /v1/admin/clients`; usuário comum → 403 ao criar conta/usuário; `login` retorna `token`;
`GET /v1/instances` com `Authorization: Bearer <token>` funciona escopado; JWT inválido → 401;
API key programática continua funcionando; não existe rota pública de cadastro.

---

## Fase 7 — Painel web (estilo UltraMsg, server-rendered) — ✅ (🟡 1 opcional)

### Mapeamento arquivo → entrega

| Item do plano | Arquivo | Status | Observações |
|---------------|---------|--------|-------------|
| Deps de view | `package.json` | ✅ | `@fastify/view`, `eta`, `@fastify/static`, `@fastify/cookie`, `@fastify/formbody` |
| Registro dos plugins | `src/server.ts` (L46–70) | ✅ | cookie → jwt (lê cookie) → formbody → view(Eta) → static `/admin/assets/` |
| Rotas do painel (prefixo `/admin`) | `src/web/panel.route.ts` | ✅ | registrado em `server.ts` L110 |
| Templates Eta | `src/web/views/{layout,login,dashboard,instance}.eta` | ✅ | |
| CSS estático | `src/web/public/styles.css` | ✅ | servido em `/admin/assets/` |
| Sessão via cookie httpOnly + `requirePanelAuth` | `src/web/panel.route.ts` (L53–75) | ✅ | redireciona p/ `/admin/login` (302, não 401 JSON); Secure só em prod |
| `/admin/login` (só login) | `panel.route.ts` (L94–144) | ✅ | sem página de cadastro |
| `/admin` dashboard (instâncias + API key) | `panel.route.ts` (L153–167) | ✅ | reusa `listInstances` + `toInstanceResponse` |
| `/admin/instances/:id` detalhe + QR + status | `panel.route.ts` (L183–326) | ✅ | `connect`/`qr`/`status` JSON p/ Alpine (polling); QR base64 reusado do service |
| Enviar mensagem de teste | `panel.route.ts` (L213–247) | ✅ | enfileira via `enqueueSend` (mesma fila da API) |
| `POST /admin/instances` (cria) + `POST /admin/logout` | `panel.route.ts` (L147–150, L170–180) | ✅ | |
| Reuso sem duplicar lógica | `src/services/instance.service.ts` | ✅ | service extraído e consumido pela API REST **e** pelo painel |
| Alpine.js via CDN | `src/web/views/*.eta` | ✅ | (CSP desativado no helmet p/ CDN + inline) |
| **(Opcional)** área admin-only na UI p/ criar contas/usuários | `src/web/panel.route.ts` (`/admin/manage*`, guard `requirePanelAdmin`), `src/web/views/manage.eta`, link "Gestão" em `layout.eta` | ✅ **concluída** | Reusa o service extraído `src/services/provisioning.service.ts` (mesmo consumido por `/v1/admin/*`) — zero duplicação de regra. Cria conta+OWNER (transação atômica), cria/remove usuários (trava de auto-remoção), bloqueio de não-admin. QA: criação/duplicidade/delete validados em runtime |

**Validação esperada:** login pela UI → dashboard mostra a conta; criar instância → aparece com
Status/URL/ID/Token; abrir instância → Conectar mostra QR; (com WAHA real) escanear → CONNECTED;
enviar teste → aparece em "últimas mensagens"; logout limpa o cookie; `/admin` sem login → redirect.

---

## Fase 8 — Testes automatizados (Vitest) — ✅ CONCLUÍDA

Suíte Vitest implementada e verde. `tsc --noEmit` limpo; `npm test` → **41 passando / 1 skip justificado**.

### Mapa de entrega

| Item | Arquivo | Status |
|------|---------|--------|
| Deps `vitest`, `@vitest/coverage-v8` + scripts `test`/`test:watch`/`test:cov` | `package.json` | ✅ |
| Config Vitest (env node, globals, coverage v8) | `vitest.config.ts` | ✅ |
| Fábrica do app (`export buildApp()` + `start()`; auto-start só com `require.main === module`) | `src/server.ts` | ✅ — `buildApp()` monta plugins+rotas sem `listen`/Prisma/Redis/workers |
| Unitário: `mapInboundStatus` + `isStatusAdvance` | `src/services/inbound-status.service.test.ts` | ✅ |
| Unitário: `dailyLimitFor` (ACTIVE vs WARMING) | `src/services/warmup.service.test.ts` | ✅ |
| Unitário: `acquireInstanceSlot` (redis mockado) | `src/utils/rate-gate.test.ts` | ✅ — lock NX, timeout→throw, release Lua |
| Unitário: `sendWithFallback`/`sendViaInstance` | `src/services/provider-router.service.test.ts` | ✅ — `prisma`+`providers` mockados; fallback opt-in, ban detection, contadores |
| Integração (`app.inject`): auth 401/403, isolamento de tenants, inbound (SENT→DELIVERED→READ + provider inválido 404), login JWT, provisionamento admin-only (403/201) | `src/integration.test.ts` | ✅ — mock de `prisma`/`redis` (determinístico, sem DB real) |
| Rate limit 429 | `src/integration.test.ts` | 🟡 `it.skip` justificado — emular o store Lua interno do `@fastify/rate-limit` geraria teste frágil; comportamento validado em runtime |

**Decisão de DB de teste:** optou-se por **mock de `prisma`/`redis`** (via `vi.hoisted`/`vi.mock`) em vez de
Postgres dedicado — mais robusto em CI; a montagem de plugins/rotas/guards é exercitada de verdade, só a
camada de dados é simulada.

> **Correção de quebra pré-existente (descoberta na Fase 8):** os plugins `@fastify/cookie`,
> `@fastify/static`, `@fastify/view` e `@fastify/formbody` estavam em majors para **Fastify 5**
> (cookie 11 / static 9 / view 12 / formbody 8), incompatíveis com o **Fastify 4** do projeto — o
> que **também impedia o `npm run dev` de subir**. Rebaixados para as majors compatíveis com Fastify 4
> (`@fastify/cookie@^9`, `@fastify/static@^7`, `@fastify/view@^9`, `@fastify/formbody@^7`). Boot e
> testes destravados.

---

## Padrões a manter (todas as fases)
Fastify · Zod · Prisma · PT-BR nas mensagens/comentários · logger Pino (nada de `console.*`) ·
`tsc --noEmit` limpo + validação de runtime obrigatórios por fase.
