# InvestRadar

Agente de gestão de carteira de investimentos: monitora ativos (ações, FIIs, ETFs, BDRs, fundos, renda fixa), gera score/análise por ativo, alertas do "Radar Inteligente" e oportunidades, com base no prompt em `attached_assets/Prompt_Agente_Gestao_Carteira_Investimentos_*.md`.

## Run & Operate

Local (fora do Replit):

- Suba um Postgres local e crie um banco (ex: `invest_radar`).
- `DATABASE_URL="postgresql://user:pass@127.0.0.1:5432/invest_radar" pnpm --filter @workspace/db run push` — cria/atualiza o schema
- `DATABASE_URL=... pnpm --filter @workspace/scripts run seed-opportunities` — popula a lista curada de Oportunidades (apaga e recria)
- `DATABASE_URL=... SESSION_SECRET=<qualquer-string> PORT=8080 pnpm --filter @workspace/api-server run dev` — API (build + start)
- `PORT=25214 BASE_PATH=/ pnpm --filter @workspace/carteira run dev` — frontend (Vite, com proxy `/api` → `http://localhost:8080`, configurável via `API_PROXY_TARGET`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: `DATABASE_URL`, `SESSION_SECRET` (api-server), `PORT`/`BASE_PATH` (ambos os artifacts)
- Env opcional: `BRAPI_TOKEN` (api-server) — token gratuito em https://brapi.dev/dashboard. Sem ele, só PETR4/VALE3/ITUB4/MGLU3 retornam cotação real; os demais tickers caem no fallback (preço médio de compra). Free tier: 15.000 requisições/mês.

### Testar pelo celular (mesma rede Wi-Fi)

Os dois servidores já escutam em `0.0.0.0` (todas as interfaces) — não precisa mudar nada no código. Falta só liberar o Firewall do Windows pra aceitar conexão de outros dispositivos, uma vez só, num **PowerShell como Administrador**:

```powershell
New-NetFirewallRule -DisplayName "InvestRadar Dev - Frontend" -Direction Inbound -LocalPort 25214 -Protocol TCP -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "InvestRadar Dev - API" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow -Profile Private
```

Depois, com o celular na mesma rede Wi-Fi, abrir `http://<IP-da-máquina>:25214` (descobrir o IP com `ipconfig`, campo IPv4). O proxy `/api` do Vite roda no servidor, então sessão/cookie funcionam normalmente — não é preciso mexer em CORS.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/db` — schema Drizzle (users, assets, alerts, opportunities, transactions, analyses, investor_profiles), fonte de verdade do banco
- `lib/api-spec/openapi.yaml` — fonte de verdade dos contratos de API
- `lib/api-zod`, `lib/api-client-react` — gerados via Orval a partir do OpenAPI (não editar à mão)
- `artifacts/api-server` — backend Express (rotas em `src/routes`)
- `artifacts/carteira` — frontend (páginas em `src/pages`)
- `artifacts/mockup-sandbox` — sandbox de design do Replit, não faz parte do app publicado

## Architecture decisions

- Cotações reais via brapi.dev (`artifacts/api-server/src/lib/market-data.ts`), com cache em memória de 5 min (uma requisição por ticker, em paralelo — ver gotcha abaixo). Cobre `acoes`, `fiis`, `etfs`, `bdrs`; `renda_fixa`/`fundos` não têm ticker de bolsa. O helper compartilhado `getPricesFor(items)` (também exporta `QUOTED_CATEGORIES`) é usado por `assets.ts`, `portfolio.ts` e `opportunities.ts` — não duplicar essa lógica de novo num quarto lugar, importar dali.
- `/portfolio/evolution`: só o valor atual (ponto mais recente) usa cotação real — os 11 pontos anteriores do histórico mensal ainda são simulados em torno dele. Histórico real de preço exige uma tabela de séries temporais (backlog, ver Fase 1 do roadmap).
- Motor de análise (`artifacts/api-server/src/lib/analysis-engine.ts`) é **regras determinísticas**, não IA/LLM. Foi construído pra usar fundamentos reais da brapi.dev (`?modules=defaultKeyStatistics,financialData`: P/L, P/VP, ROE, dívida/patrimônio, margem líquida, DY, crescimento, variação 12m, beta), mas **esses módulos exigem o plano pago** (~R$100+/mês) — no plano atual, a chamada retorna `MODULES_NOT_AVAILABLE` pra qualquer ticker fora dos 4 liberados pra teste (PETR4, VALE3, ITUB4, MGLU3). Por isso `analyzeFundamentals()`/`getFundamentals()` ficam **prontos mas não são chamados** pela rota — `computeAnalysis()` em `analysis.ts` retorna `pendingAnalysis()` (`available: false`) pra qualquer ativo com ticker de bolsa, até decidirmos a fonte de dados (upgrade de plano, ler CVM direto, ou outro provedor). Resultados com `available: false` nunca são persistidos em `analyses` nem geram alerta no Radar. Categorias sem ticker (`renda_fixa`/`fundos`) usam `analysisForUnquotedAsset()` — esse caso é `available: true`, é uma limitação estrutural (não tem o que analisar), não uma pendência de dados. Frontend (`analise.tsx`, coluna "Status" em `carteira.tsx`) mostra badge "Em breve" quando `available === false`, sem fingir um score. `newsItems` sempre vem vazio até a Fase 3 — nunca fabricar manchete falsa ali.
- Autenticação por sessão (`express-session`, cookie httpOnly), sem distinção de perfis, conforme o prompt original.
- Perfil de investidor (`/profile`, `investor_profiles`) é **opcional** — preenchido em Configurações, não no cadastro. Score 0-100 somado a partir de 5 perguntas (20 pts cada), classificação Conservador (<34) / Moderado (34-66) / Arrojado (≥67).
- `opportunities` é populada por `pnpm --filter @workspace/scripts run seed-opportunities` (lista curada de 18 tickers, não são dados live — ver `scripts/src/seed-opportunities.ts`). `/opportunities` reordena o Top 10 pelo `riskLevel` compatível com a classificação do perfil do usuário (Conservador prioriza risco Baixo, Arrojado prioriza Alto); sem perfil definido, mantém a ordenação simples por score. `currentPrice` é buscado só pros 10 já rankeados (cotação real, mesmo cache de `market-data.ts`) — os demais campos (score, potentialReturn, dividendYield) continuam curados/fixos.
- Navegação mobile (`app-layout.tsx`, abaixo de `md`): barra superior com hambúrguer (abre o drawer com todos os itens) + barra inferior fixa com os 5 destinos mais usados (Início, Carteira, Radar, Análise, Oportunidades). Dividendos/Saúde/Configurações ficam só no drawer. Desktop usa a sidebar fixa de sempre, sem nenhuma das duas barras.

## Product

Ver `attached_assets/Prompt_Agente_Gestao_Carteira_Investimentos_*.md` para a especificação completa (classificação MANTER/ATENÇÃO/REAVALIAR/POSSÍVEL SAÍDA, Radar Inteligente, score 0-100, dashboards de carteira/saúde/oportunidades).

## User preferences

- Projeto está migrando do fluxo Replit para deploy próprio (Vercel/Railway/VPS a definir) — não assumir que `.replit`/`artifact.toml` seguem sendo a fonte de verdade de deploy.

## Gotchas

- **Windows dev**: `pnpm-workspace.yaml` tinha overrides que zeravam os binários nativos não-Linux de `esbuild`, `rollup`, `lightningcss` e `@tailwindcss/oxide` (comentário original: "replit uses linux-x64 only"). Já removidas as entradas `win32-*` — se voltar a quebrar após um `pnpm install`, comece por aí.
- **Git Bash / MSYS no Windows**: `BASE_PATH=/` é reescrito para o path do Git (`/Program Files/Git/...`) pelo MSYS. Rode com `MSYS_NO_PATHCONV=1` na frente do comando.
- O script `dev` do `api-server` usava `export NODE_ENV=...` (sintaxe bash), que quebra no shell padrão do pnpm no Windows (cmd.exe). Já corrigido — `NODE_ENV` não é obrigatório, só é comparado com `"production"` em `app.ts`/`logger.ts`.
- `lib/db/drizzle.config.ts` usava `path.join(__dirname, ...)`, que gerava um path com `\` no Windows e o drizzle-kit não encontrava o schema. Trocado para path relativo simples.
- **brapi.dev**: os planos free/free-token permitem só **1 ticker por requisição**. `market-data.ts` faz uma requisição por ticker (em paralelo) — nunca volte a agrupar tickers numa chamada só (`/quote/A,B,C`), a API rejeita a lista inteira e derruba o preço de todos os ativos daquele lote, não só do que causou o problema.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
