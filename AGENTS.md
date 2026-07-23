# Processos_BE

Dashboard + API de acompanhamento de processos trabalhistas da Burlington English, com atualização automática via DataJud (CNJ) e Comunicações (PJe). Serve o painel, expõe uma API REST e roda cron de sincronização.

## Stack
- **Linguagem/runtime:** Node.js (JavaScript, CommonJS)
- **Framework HTTP:** Express `^5.2.1`
- **Cron:** `node-cron` `^4.2.1` (local) + Vercel Cron (produção)
- **Banco:** PostgreSQL via `pg` `^8.20.0` (Neon em produção). Tabela `processos_data (key TEXT PK, value JSONB, updated_at)`; criada de forma idempotente em `initDB()`. Sem `DATABASE_URL`, cai em fallback de arquivos JSON locais.
- **Deploy:** Vercel (`@vercel/node`, roteia todo tráfego para `burlington-server.js`), com dois crons diários.
- **Package manager:** npm (`package-lock.json`).

## Comandos
- `npm start` / `npm run dev` — sobe o servidor: `node burlington-server.js` (porta `3100` local).
- Não há `test`, `lint` nem `build` definidos em `package.json`. Em produção o Vercel usa o builder `@vercel/node` (sem etapa de build própria).

## Estrutura
- `burlington-server.js` — arquivo único com todo o servidor: dashboard, rotas da API, integração DataJud/Comunicações e agendamento de cron.
- `burlington_processos_data.json` — snapshot dos processos (fallback local / seed).
- `burlington_comunicacoes_cache.json` — cache de comunicações do PJe.
- `test_pet.js` — script solto de teste manual (não é suíte automatizada).
- `vercel.json` — builds, rotas e definição dos crons.

Rotas principais expostas pelo servidor: `GET /` (dashboard), `GET /astrea`, `GET /api/processos`, `GET /api/status`, `GET /api/alertas`, `GET /api/progress`, `GET /api/processo/:id` (`/full`, `/peticoes`), `GET /api/comunicacoes` (`/:id`), `POST /api/atualizar`, `POST /api/comunicacoes/atualizar`, `GET /api/cron/atualizar`, `GET /api/cron/comunicacoes`.

## Convenções de código
- JavaScript CommonJS (`require`), sem TypeScript, sem bundler.
- Escrita em disco protegida por `safeWriteFile()` — o filesystem do Vercel é read-only; toda persistência real deve ir para o Postgres.
- Camada de storage abstrata (`loadData`/`saveData` por `key`): Postgres quando `DATABASE_URL` existe, senão arquivos JSON. Mantenha essa abstração ao adicionar novos dados persistidos.
- Rotas de cron (`/api/cron/*`) exigem `Authorization: Bearer <CRON_SECRET>` quando rodando no Vercel.

## Variáveis de ambiente
Nunca commite valores. Configure em `.env` (local) e no painel da Vercel (produção):
- `DATABASE_URL` — string de conexão Postgres/Neon (SSL). Ausente ⇒ fallback para JSON local.
- `CRON_SECRET` — token exigido no header das rotas `/api/cron/*` em produção.
- `VERCEL` — setada pela plataforma (`'1'`); usada para detectar ambiente serverless.

> **Atenção:** há uma `API_KEY` do DataJud **hardcoded** em `burlington-server.js`. Ela deveria ser movida para uma variável de ambiente. Não introduza novos segredos em código.

## CI/CD & Deploy
- **Deploy:** Vercel com auto-deploy da `main` (`vercel.json` v2, builder `@vercel/node`).
- **Crons (Vercel):** `POST`/`GET` em `/api/cron/atualizar` às `10:00` e `22:00` UTC diariamente.
- **CI:** não há workflows em `.github/workflows/`. Recomendação (via PR): workflow mínimo com `npm ci` + `node --check burlington-server.js` (checagem de sintaxe) e, idealmente, um smoke test que suba o servidor e bata em `/api/status`.

## Boas práticas de PR
- Branches: `feat/…`, `fix/…`, `chore/…`.
- Commits no padrão Conventional Commits.
- PRs pequenos e focados. Checklist: servidor sobe sem erro (`npm start`), nenhum segredo commitado, sem quebrar a abstração de storage, screenshot do dashboard se a UI mudar.
- ≥1 review, squash merge, `main` sempre deployável.

## Testes
- Não há suíte automatizada (`test_pet.js` é manual). Recomendação proporcional: adicionar testes básicos das rotas da API (ex.: `node:test` ou `vitest` + `supertest`) cobrindo `/api/status` e `/api/processos`.

## Segurança & dados
- Nunca commitar `.env`, `CRON_SECRET`, `DATABASE_URL` nem a chave do DataJud. Migrar a `API_KEY` hardcoded para env é prioridade de segurança.
- Dados de processos trabalhistas contêm informação pessoal (partes, advogados): tratar sob LGPD — não expor publicamente, restringir acesso ao dashboard.
- Revisar dependências (`express`, `pg`, `node-cron`) periodicamente.

## Gotchas
- Filesystem do Vercel é **read-only**: qualquer `writeFile` é silenciosamente ignorado por `safeWriteFile`. Persistência precisa do Postgres.
- Sem `DATABASE_URL`, os dados vêm de JSONs versionados — não confie neles em produção.
- Express **5** tem mudanças de comportamento vs. v4 (roteamento, tratamento de erros async) — verifique antes de portar padrões antigos.
- Os JSONs de dados são grandes (MBs) e estão versionados; evite inchá-los ainda mais no git.
