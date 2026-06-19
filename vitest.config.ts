// vitest.config.ts
// Configuração dos testes automatizados (Fase 8).
// - environment 'node': testamos código de backend (Fastify/Prisma/Redis), sem DOM.
// - globals habilitados: usamos describe/it/expect/vi sem import explícito.
// - coverage via provider v8 (nativo do Node, sem instrumentação externa).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Mede cobertura só do código-fonte (ignora os próprios testes e configs).
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**'],
    },
  },
})
