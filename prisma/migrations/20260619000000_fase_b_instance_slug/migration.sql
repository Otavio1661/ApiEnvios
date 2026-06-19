-- Fase B — nome único por tenant + slug único global da instância.

-- 1) Adiciona a coluna slug (nullable; será backfilled abaixo).
ALTER TABLE "Instance" ADD COLUMN "slug" TEXT;

-- 2) Backfill: gera slug em kebab-case a partir do name (ou do id quando sem name),
--    garantindo unicidade GLOBAL com sufixo numérico em caso de colisão.
DO $$
DECLARE
  rec    RECORD;
  base   TEXT;
  cand   TEXT;
  n      INT;
BEGIN
  FOR rec IN SELECT "id", "name" FROM "Instance" WHERE "slug" IS NULL ORDER BY "createdAt" ASC LOOP
    -- Normaliza name → kebab-case (sem acentos): minúsculas, não-alfanumérico → '-', colapsa/trim '-'.
    base := lower(coalesce(rec."name", ''));
    base := translate(base,
      'àáâãäåèéêëìíîïòóôõöùúûüçñ',
      'aaaaaaeeeeiiiiooooouuuucn');
    base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
    base := regexp_replace(base, '(^-+|-+$)', '', 'g');
    IF base IS NULL OR length(base) = 0 THEN
      base := 'inst-' || rec."id";
      base := lower(regexp_replace(base, '[^a-z0-9]+', '-', 'g'));
      base := regexp_replace(base, '(^-+|-+$)', '', 'g');
    END IF;
    base := left(base, 40);
    base := regexp_replace(base, '-+$', '', 'g');

    cand := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM "Instance" WHERE "slug" = cand) LOOP
      n := n + 1;
      cand := left(base, 40 - (length(n::text) + 1)) || '-' || n::text;
    END LOOP;

    UPDATE "Instance" SET "slug" = cand WHERE "id" = rec."id";
  END LOOP;
END $$;

-- 2b) Dedup de name por tenant: registros existentes podem ter nomes repetidos dentro
--     da mesma conta (o unique [apiClientId, name] passa a valer agora). Mantém o mais
--     antigo intacto e sufixa os demais (" (2)", " (3)"...) para não perder informação.
DO $$
DECLARE
  rec RECORD;
  cand TEXT;
  k INT;
BEGIN
  -- Seleciona apenas as ocorrências EXCEDENTES (rn > 1) de cada (apiClientId, name),
  -- preservando a mais antiga com o nome original.
  FOR rec IN
    SELECT "id", "apiClientId", "name"
    FROM (
      SELECT "id", "apiClientId", "name",
             row_number() OVER (PARTITION BY "apiClientId", "name" ORDER BY "createdAt" ASC) AS rn
      FROM "Instance"
      WHERE "name" IS NOT NULL
    ) t
    WHERE t.rn > 1
    ORDER BY "apiClientId", "name"
  LOOP
    k := 1;
    LOOP
      k := k + 1;
      cand := rec."name" || ' (' || k::text || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "Instance" WHERE "apiClientId" = rec."apiClientId" AND "name" = cand
      );
    END LOOP;
    UPDATE "Instance" SET "name" = cand WHERE "id" = rec."id";
  END LOOP;
END $$;

-- 3) Índices de unicidade.
--    slug: único GLOBAL (usado na URL sem contexto de tenant; NULLs são distintos no Postgres).
CREATE UNIQUE INDEX "Instance_slug_key" ON "Instance"("slug");
--    name: único POR TENANT quando preenchido (NULLs distintos → vários sem nome são permitidos).
CREATE UNIQUE INDEX "Instance_apiClientId_name_key" ON "Instance"("apiClientId", "name");
