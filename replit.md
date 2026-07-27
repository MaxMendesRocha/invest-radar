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
- Env opcional: `ANTHROPIC_API_KEY` (api-server) — gerada em https://console.anthropic.com, paga por uso (não é a mesma chave/assinatura do Claude). Sem ela, o Radar de Notícias mostra as manchetes reais sem classificação de impacto (`impact: null`); com ela, cada manchete é classificada via Claude Haiku.

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

- `lib/db` — schema Drizzle (users, assets, alerts, opportunities, transactions, analyses, investor_profiles, portfolio_snapshots), fonte de verdade do banco
- `lib/api-spec/openapi.yaml` — fonte de verdade dos contratos de API
- `lib/api-zod`, `lib/api-client-react` — gerados via Orval a partir do OpenAPI (não editar à mão)
- `artifacts/api-server` — backend Express (rotas em `src/routes`)
- `artifacts/carteira` — frontend (páginas em `src/pages`)
- `artifacts/mockup-sandbox` — sandbox de design do Replit, não faz parte do app publicado

## Architecture decisions

- Cotações reais via brapi.dev (`artifacts/api-server/src/lib/market-data.ts`), com cache em memória de 5 min (uma requisição por ticker, em paralelo — ver gotcha abaixo). Cobre `acoes`, `fiis`, `etfs`, `bdrs`; `renda_fixa`/`fundos` não têm ticker de bolsa. O helper compartilhado `getPricesFor(items)` (também exporta `QUOTED_CATEGORIES`) é usado por `assets.ts`, `portfolio.ts` e `opportunities.ts` — não duplicar essa lógica de novo num quarto lugar, importar dali.
- **Saúde do Portfólio** (`/portfolio/health`, página `saude.tsx`): com 0 ativos retorna todas as dimensões zeradas (`score: 0`) em vez dos fallbacks de "sem ações na carteira" (era um bug: carteira vazia mostrava Score 34, Risco 80, Dividendos 50, Crescimento 68 — os mesmos fallbacks usados pra carteira só-renda-fixa). O frontend usa `assetCount` de `/portfolio/summary` pra decidir entre o card de score e o estado "Diagnóstico Indisponível" que já existia mas nunca era acionado. Com ativos reais, `risk`/`dividends` continuam sendo heurísticas grosseiras por categoria (não por fundamentos) e `growth` continua fixo em 68 — simplificação aceita por ora, mesma pendência de fonte de dados fundamentalista do motor de análise.
- **Histórico de patrimônio** (`portfolio_snapshots`, `artifacts/api-server/src/lib/portfolio-history.ts`): 1 linha por usuário por dia (upsert por `userId`+`date`), gravada toda vez que `/portfolio/summary` é chamado — sem cron, sem job agendado, o histórico real cresce sozinho só de o usuário usar o app no dia a dia. `/portfolio/evolution` e `/portfolio/benchmarks` usam o snapshot real do mês quando existe; meses sem snapshot ainda caem no fallback simulado de antes (o real vai ocupando o lugar do simulado com o tempo, nunca o contrário). Carteira vazia mostra 0% reto, não ganho fabricado (esse era um bug: `/portfolio/benchmarks` nunca consultava os ativos do usuário, era só `Math.random()`). CDI/IBOV/IFIX continuam simulados, sem fonte real conectada ainda.
- Motor de análise (`artifacts/api-server/src/lib/analysis-engine.ts`) é **regras determinísticas**, não IA/LLM. Foi construído pra usar fundamentos reais da brapi.dev (`?modules=defaultKeyStatistics,financialData`: P/L, P/VP, ROE, dívida/patrimônio, margem líquida, DY, crescimento, variação 12m, beta), mas **esses módulos exigem o plano pago** (~R$100+/mês) — no plano atual, a chamada retorna `MODULES_NOT_AVAILABLE` pra qualquer ticker fora dos 4 liberados pra teste (PETR4, VALE3, ITUB4, MGLU3). Por isso `analyzeFundamentals()`/`getFundamentals()` ficam **prontos mas não são chamados** pela rota — `computeAnalysis()` em `analysis.ts` retorna `pendingAnalysis()` (`available: false`) pra qualquer ativo com ticker de bolsa, até decidirmos a fonte de dados (upgrade de plano, ler CVM direto, ou outro provedor). Resultados com `available: false` nunca são persistidos em `analyses` nem geram alerta no Radar. Categorias sem ticker (`renda_fixa`/`fundos`) usam `analysisForUnquotedAsset()` — esse caso é `available: true`, é uma limitação estrutural (não tem o que analisar), não uma pendência de dados. Frontend (`analise.tsx`, coluna "Status" em `carteira.tsx`) mostra badge "Em breve" quando `available === false`, sem fingir um score. `newsItems` sempre vem vazio até a Fase 3 — nunca fabricar manchete falsa ali.
- Autenticação por sessão (`express-session`, cookie httpOnly), sem distinção de perfis, conforme o prompt original.
- Perfil de investidor (`/profile`, `investor_profiles`) é **opcional** — preenchido em Configurações, não no cadastro. Score 0-100 somado a partir de 5 perguntas (20 pts cada), classificação Conservador (<34) / Moderado (34-66) / Arrojado (≥67).
- `opportunities` é populada por `pnpm --filter @workspace/scripts run seed-opportunities` (lista curada de 18 tickers, não são dados live — ver `scripts/src/seed-opportunities.ts`). `/opportunities` reordena o Top 10 pelo `riskLevel` compatível com a classificação do perfil do usuário (Conservador prioriza risco Baixo, Arrojado prioriza Alto); sem perfil definido, mantém a ordenação simples por score. `currentPrice` é buscado só pros 10 já rankeados (cotação real, mesmo cache de `market-data.ts`) — os demais campos (score, potentialReturn, dividendYield) continuam curados/fixos.
- Navegação mobile (`app-layout.tsx`, abaixo de `md`): barra superior com hambúrguer (abre o drawer com todos os itens) + barra inferior fixa com os 5 destinos mais usados (Início, Carteira, Radar, Análise, Oportunidades). Dividendos/Saúde/Configurações ficam só no drawer. Desktop usa a sidebar fixa de sempre, sem nenhuma das duas barras.
- **Macro** (`artifacts/api-server/src/lib/macro-data.ts`): Selic, IPCA (12m) e câmbio via API pública do Banco Central (SGS), sem chave, cache de 6h. `/dados/ultimos/N` do SGS tem limite de 20 pontos — pra tendência da Selic (janela de ~6 meses) usar `/dados?dataInicial=...&dataFinal=...` em vez disso. Exibido num painel no topo do Radar Inteligente. `/analysis/generate` gera alerta `macroeconomico` quando IPCA 12m > 4,5% ou Selic em trajetória de alta.
- **Alerta de concentração** (`computeConcentrationAlerts` em `analysis.ts`, chamado por `/analysis/generate`): não depende de nenhuma fonte de dados nova, só reusa preço (`getPricesFor`) e setor (`sectorFor`, movido de `portfolio.ts` pra `market-data.ts` pra não duplicar) já calculados. Três regras: ativo único ≥40% do patrimônio = `Critico`, ≥25% = `Alto`; setor único ≥50% = `Alto`; menos de 3 ativos distintos = `Medio` ("baixa diversificação"). Gera alerta tipo `concentracao` (enum já existia no OpenAPI, nunca tinha sido usado). Validado direto contra o Supabase de produção com um usuário de teste (100% em 1 ativo → Critico; diluído pra ~27%/73% → Alto/Critico corretos), dados de teste removidos depois.
- **Notícias** (`artifacts/api-server/src/lib/news.ts`): busca via RSS de busca nativo do WordPress do InfoMoney (`?feed=rss2&s=termo`) — não usar o feed geral (`/feed/`), ele só tem ~10 itens no total e raramente menciona uma empresa específica; a busca por nome já traz resultado direto. O termo de busca é o nome popular da empresa, não o nome de registro que a brapi.dev retorna (`Vale S.A.` não aparece em manchete nenhuma, mas `Vale` sim) — `COMPANY_ALIASES` cobre os tickers mais negociados (Petrobras, Itaú, Bradesco etc.) onde nome popular ≠ nome legal; fora da lista, usa a primeira palavra do nome legal como aproximação. Classificação de impacto via Claude Haiku (`classifyImpact`, cacheada 24h por manchete) — sem `ANTHROPIC_API_KEY`, mostra a manchete real sem classificação, nunca inventa impacto. Notícia negativa/muito negativa em ativo da carteira gera alerta tipo `noticias`. `XMLParser` precisa de `{ htmlEntities: true }`, senão entidades como `&#8220;` aparecem cruas no título.

## Product

Ver `attached_assets/Prompt_Agente_Gestao_Carteira_Investimentos_*.md` para a especificação completa (classificação MANTER/ATENÇÃO/REAVALIAR/POSSÍVEL SAÍDA, Radar Inteligente, score 0-100, dashboards de carteira/saúde/oportunidades).

## User preferences

- Projeto migrou do fluxo Replit para deploy próprio: **Vercel** (frontend) + **Railway** (api-server) + **Supabase** (Postgres) — não assumir que `.replit`/`artifact.toml` seguem sendo a fonte de verdade de deploy.

## Deploy (Vercel + Railway + Supabase) — no ar e validado

- Frontend: https://invest-radar-carteira.vercel.app
- API: https://invest-radar-production.up.railway.app (não é pra usuário final acessar direto — sempre pelo domínio da Vercel, que faz proxy de `/api/*` pra cá)
- Banco: Supabase, projeto `gzqqwpetlfruokgnfmzp`, connection string do pooler (modo *transaction*, porta 6543) guardada como `DATABASE_URL` no Railway

Arquitetura: a Vercel faz *rewrite* de `/api/*` pro domínio do Railway (`artifacts/carteira/vercel.json`) — o navegador nunca vê dois domínios diferentes, então sessão/cookie funcionam exatamente como em dev local (proxy do Vite) e não precisou mexer em CORS nem em `sameSite`. Não confundir com a arquitetura serverless da Vercel — o api-server continua sendo um processo Node tradicional no Railway, só o frontend estático vai pra Vercel.

**Pra reproduzir do zero** (ex: outro ambiente, staging):

1. **Supabase**: criar projeto → pegar connection string do pooler (Settings → Database → Connect → Transaction pooler) → rodar `DATABASE_URL="<string>" pnpm --filter @workspace/db run push` e depois `pnpm --filter @workspace/scripts run seed-opportunities` apontando pra ela
2. **Railway**: "Deploy from GitHub repo" — **raiz do repo como root directory**, não `artifacts/api-server` (o pnpm workspace precisa do repo inteiro pra resolver os pacotes `@workspace/*`). Se ele auto-detectar o monorepo e criar um serviço por pacote (`@workspace/carteira`, `@workspace/api-spec` etc.), **apague todos exceto um** e configure esse com root directory vazio — só assim ele usa o `railway.json` da raiz. Env vars: `DATABASE_URL`, `SESSION_SECRET`, `BRAPI_TOKEN`, `ANTHROPIC_API_KEY`, `NODE_ENV=production` (`PORT` é automático). Gerar o domínio em Settings → Networking → Generate Domain.
3. **Vercel**: import project, **Root Directory = `artifacts/carteira`**, env var `BASE_PATH=/` (obrigatória, ver gotcha — sem ela o build falha). Editar `artifacts/carteira/vercel.json` trocando o domínio do rewrite pelo domínio real do Railway antes do deploy.

Depois do primeiro deploy dos três, testar cadastro/login/navegação pelo domínio da Vercel antes de considerar concluído — foi assim que os três gotchas abaixo (pnpm 11, cookie de sessão, rotas 404) apareceram.

## Gotchas

- **Windows dev**: `pnpm-workspace.yaml` tinha overrides que zeravam os binários nativos não-Linux de `esbuild`, `rollup`, `lightningcss` e `@tailwindcss/oxide` (comentário original: "replit uses linux-x64 only"). Já removidas as entradas `win32-*` — se voltar a quebrar após um `pnpm install`, comece por aí.
- **Git Bash / MSYS no Windows**: `BASE_PATH=/` é reescrito para o path do Git (`/Program Files/Git/...`) pelo MSYS. Rode com `MSYS_NO_PATHCONV=1` na frente do comando.
- O script `dev` do `api-server` usava `export NODE_ENV=...` (sintaxe bash), que quebra no shell padrão do pnpm no Windows (cmd.exe). Já corrigido — `NODE_ENV` não é obrigatório, só é comparado com `"production"` em `app.ts`/`logger.ts`.
- `lib/db/drizzle.config.ts` usava `path.join(__dirname, ...)`, que gerava um path com `\` no Windows e o drizzle-kit não encontrava o schema. Trocado para path relativo simples.
- **brapi.dev**: os planos free/free-token permitem só **1 ticker por requisição**. `market-data.ts` faz uma requisição por ticker (em paralelo) — nunca volte a agrupar tickers numa chamada só (`/quote/A,B,C`), a API rejeita a lista inteira e derruba o preço de todos os ativos daquele lote, não só do que causou o problema.
- `vite.config.ts` da carteira exigia `PORT` mesmo pra `vite build` (que não abre porta nenhuma) — isso quebraria todo build na Vercel. Corrigido: `PORT` só é exigido quando `command === 'serve'` (dev/preview). `BASE_PATH` continua sempre obrigatório (afeta os paths dos assets no HTML gerado, isso sim importa pro build) — configurar como env var na Vercel.
- **Railway/Nixpacks não suporta pnpm 11** — trata como v9 desconhecida e quebra com um erro enganoso (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, sem nenhuma relação óbvia com versão de pnpm). `package.json` está fixado em `pnpm@10.34.5` por causa disso — não subir pra 11.x sem checar se o Nixpacks já suporta.
- **Cookie de sessão não era definido em produção** (login retornava 200 mas sem `Set-Cookie`): Railway/Vercel terminam TLS antes da requisição chegar no processo Node, e sem `app.set("trust proxy", 1)` o Express não confia no `X-Forwarded-Proto`, então `req.secure` fica `false` e o `express-session` recusa definir um cookie `secure: true` (não é só a flag, ele nem tenta). Já corrigido em `app.ts` — se voltar a acontecer num novo ambiente atrás de proxy, é o primeiro lugar pra olhar.
- **Rotas client-side davam 404 na Vercel** (`/login`, `/carteira` etc. só existem no React Router, não são arquivos): faltava um rewrite catch-all pro `index.html` em `vercel.json`, depois do rewrite de `/api/*` (ordem importa, primeiro match vence).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
