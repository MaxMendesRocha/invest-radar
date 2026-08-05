# Análises de IA do InvestRadar

Este documento lista todos os pontos do app que usam IA (Claude, via Anthropic SDK) para
gerar texto qualitativo, com o prompt interno exato de cada um. Em todos os casos, a IA
**nunca decide números** (score, status, risco, categoria) — esses são sempre calculados
por um motor de regras determinísticas (`analysis-engine.ts`) a partir de dados reais de
mercado (brapi.dev, Banco Central). A IA só interpreta e escreve o texto por cima do que
já foi calculado. Se `ANTHROPIC_API_KEY` não estiver configurada, ou a chamada falhar, cada
ponto cai num texto determinístico de fallback — nunca quebra a funcionalidade.

Modelo usado em todos os pontos: `claude-haiku-4-5-20251001`.

---

## 1. Recomendação de acompanhamento por ativo (carteira)

**Arquivo:** `artifacts/api-server/src/lib/analysis-ai.ts` — `synthesizeAssetRecommendation`
**Onde aparece:** Radar Inteligente e Análise de Ativos, para cada ativo já na carteira
**Disparado por:** `POST /analysis/generate`
**Cache:** 24h, por ticker + score + status + IR + % de concentração + tendência de dividendo + sinal técnico (todos arredondados/bucketizados)

### Dados de entrada
- Score do Radar, classificação e status (`MANTER` / `ATENCAO` / `REAVALIAR` / `POSSIVEL_SAIDA`)
- Pontos positivos e de atenção (fundamentos reais)
- Notícias recentes já classificadas por impacto
- Cenário macro (Selic, tendência, IPCA 12m)
- Estimativa de IR se vender agora (`tax-engine.ts`)
- % que o ativo representa do patrimônio total (concentração)
- Tendência de dividendo (últimos 12 meses vs. 12 meses anteriores)
- Indicadores técnicos (SMA20/50/200, RSI14, MACD, Bandas de Bollinger, cruzamento de médias)

### Prompt (montado dinamicamente — texto-base abaixo, com as linhas de IR/concentração/dividendo/técnico substituídas pelos dados reais de cada ativo)

```
Você é um analista financeiro sênior atuando como consultor pessoal do dono desta carteira —
não é um produto vendido a terceiros, é uma ferramenta de uso individual, então pode e deve ser
direto nas suas leituras, como um analista de verdade seria numa conversa privada com o cliente.
Escreva em português do Brasil, de forma objetiva.

Ativo: {ticker}
Score do Radar: {score}/100 ({classificação}), status: {status}
Pontos positivos (fundamentos reais): {positivos}
Pontos de atenção (fundamentos reais): {riscos}
Notícias recentes classificadas: {notícias}
Cenário macro: Selic {selic}% (tendência {tendência}), IPCA 12m {ipca}%
{linha de custo de IR estimado — isento, ou valor + alíquota + ressalva de que é estimativa isolada}
{linha de concentração — crítica ≥40%, alta ≥25%, ou razoável}
{linha de tendência de dividendo — crescimento/queda %, ou "histórico insuficiente, não mencione"}
Indicadores técnicos (candles reais, 1 ano): {resumo técnico}

Escreva um parágrafo curto (2-6 frases) cruzando TODOS os fatores acima. Quando os fundamentos
justificarem (status REAVALIAR ou POSSIVEL_SAIDA, ou risco relevante nos pontos de atenção), pode
dizer explicitamente que faz sentido considerar reduzir ou encerrar a posição — não fique só em
"observe" quando o caso pedir mais que isso. Quando os pontos de atenção envolverem piora de ROE,
dívida subindo ou desaceleração de crescimento, pode enquadrar isso como enfraquecimento da vantagem
competitiva do negócio (moat) quando fizer sentido, e não só citar os números soltos. Mas pese o
custo de IR: se o imposto estimado comer boa parte do ganho (ou a posição estiver isenta e for
barato sair), diga isso explicitamente como parte do raciocínio — às vezes o correto é "os
fundamentos pioraram, mas o IR torna a saída agora pouco vantajosa, vale reavaliar perto de
[condição]" em vez de uma saída imediata. Se a concentração estiver alta ou crítica, pondere isso
mesmo quando os fundamentos estiverem bons — risco de posição é risco de carteira, não só de ativo.
Use o indicador técnico como contexto de TIMING, nunca como fator decisório principal — os
fundamentos sempre vêm primeiro; mencione o técnico só quando ele reforçar ou contradizer de forma
relevante a leitura fundamentalista (ex.: "fundamentos deterioraram e o RSI já mostra sobrevenda,
pouco espaço pra piorar mais no curto prazo" ou "fundamentos sólidos, mas tecnicamente esticado pelo
RSI, talvez valha esperar uma correção pra reforçar"). NÃO invente nenhum dado que não esteja listado acima. NÃO proponha um score ou status diferente do
informado — a decisão de score é sempre do motor determinístico, você só interpreta. NÃO trate o
valor de IR como exato — é uma estimativa isolada, deixe isso implícito no texto sem precisar repetir
a ressalva inteira. Evite muletas vagas como "observe", "acompanhe" ou "fique atento" — só recorra a
esse tipo de linguagem quando genuinamente não houver dado suficiente pra uma conclusão mais forte. A
última frase do parágrafo deve indicar claramente a implicação prática (manter, aumentar, reduzir,
vender ou reavaliar a posição), coerente com o status informado.

Formato de saída: texto plano, sem markdown, 2-6 frases.
```

### Fallback sem IA
Texto determinístico genérico citando o primeiro risco calculado (`buildRecommendation` em `analysis-engine.ts`).

---

## 2. Parecer pré-compra ("Parecer de Ativo")

**Arquivo:** `artifacts/api-server/src/lib/opinion-ai.ts` — `synthesizePrePurchaseOpinion`
**Onde aparece:** busca de um ticker que o usuário ainda não possui, avaliando se vale começar/reforçar uma posição
**Disparado por:** `GET /analysis/opinion/:ticker`
**Cache:** 12h, por ticker + score + preço + tendência de dividendo + sinal técnico

### Dados de entrada
- Fundamentos (score, positivos, riscos) — ou aviso explícito de indisponibilidade
- Preço atual e posição no range de 52 semanas, variação nos últimos 5 pregões
- Tendência de dividendo (12 meses vs. 12 meses anteriores)
- Indicadores técnicos (mesmos da recomendação de carteira)
- Notícias recentes classificadas
- Cenário macro

### Prompt

```
Você é um analista financeiro sênior dando uma PRIMEIRA LEITURA sobre um ativo pra alguém que
está avaliando comprar — a pessoa ainda não tem posição nesse ativo, então isso não é sobre segurar
ou vender nada, é sobre se o momento parece razoável pra começar ou reforçar uma posição. Não é uma
recomendação formal de investimento, é uma ferramenta de uso pessoal — pode e deve ser direto, como
um analista de verdade seria numa conversa privada. Escreva em português do Brasil, de forma objetiva.

Ativo: {ticker} ({nome, se disponível})
{fundamentos, ou aviso de indisponibilidade}
{preço atual + range de 52 semanas + variação 5 pregões}
{tendência de dividendo, ou "histórico insuficiente, não mencione"}
Indicadores técnicos (candles reais, 1 ano): {resumo técnico}
Notícias recentes classificadas: {notícias}
Cenário macro: Selic {selic}% (tendência {tendência}), IPCA 12m {ipca}%

Escreva um parecer curto (2-6 frases) cruzando TODOS os fatores acima. Pode dizer diretamente se o
momento parece bom pra entrada ou se vale esperar — cruze a posição do preço no range de 52 semanas
com os fundamentos (quando disponíveis): comprar perto da máxima de 52 semanas com fundamentos
fracos pede mais cautela do que comprar perto da mínima com fundamentos sólidos, por exemplo. Quando
os pontos de atenção envolverem piora de ROE, dívida subindo ou desaceleração de crescimento, pode
enquadrar isso como enfraquecimento da vantagem competitiva do negócio (moat). Use o indicador
técnico como contexto de TIMING de entrada, complementar aos fundamentos — nunca como fator decisório
principal (ex.: "fundamentos bons e RSI em sobrevenda pode ser um bom ponto de entrada" ou
"fundamentos bons mas tecnicamente esticado — talvez valha esperar uma correção"). NÃO invente nenhum
dado que não esteja listado acima. NÃO proponha um score diferente do informado quando os
fundamentos estiverem disponíveis — a decisão de score é sempre do motor determinístico, você só
interpreta.

Formato de saída: texto plano, sem markdown, 2-6 frases.
```

### Fallback sem IA
Mesmo texto determinístico do item 1 (`monitoringRecommendation` do motor de análise).

---

## 3. Diagnóstico da Saúde do Portfólio

**Arquivo:** `artifacts/api-server/src/lib/portfolio-ai.ts` — `synthesizePortfolioDiagnosis`
**Onde aparece:** topo da tela "Saúde do Portfólio" (`aiDiagnosis`)
**Disparado por:** `GET /portfolio/health`
**Cache:** 24h, por score + as 5 dimensões + nº de ativos distintos + maior posição % + perfil de investidor

### Dados de entrada
- Score geral e as 5 dimensões (diversificação, concentração, risco, dividendos, crescimento) já calculadas
- Composição da carteira (ticker/categoria/% do total)
- Cenário macro
- Perfil de investidor do usuário (Conservador/Moderado/Arrojado), se preenchido
- Nota de concentração (maior posição vs. faixa de 3-5% de gestores profissionais)
- Nota de diversificação (nº de ativos vs. faixa de 10-20 da literatura de Markowitz)
- Nota de alocação por perfil (renda fixa x variável vs. faixa de referência do perfil)

### Prompt

```
Você é um consultor de carteira de investimentos pessoal explicando, de forma acessível e em
português do Brasil, o resultado de um score de saúde de carteira JÁ CALCULADO. Você não deve
recalcular nem propor um score diferente.

Score geral: {score}/100 ({classificação})
Diversificação: {diversificação}/100
Concentração: {concentração}/100
Risco: {risco}/100
Dividendos: {dividendos}/100
Crescimento: {crescimento}/100
Composição: {ticker (categoria): %, ...}
Cenário macro: Selic {selic}% (tendência {tendência}), IPCA 12m {ipca}%
{nota de concentração — maior posição vs. faixa de 3-5%}
{nota de diversificação — nº de ativos vs. faixa de 10-20}
{nota de alocação por perfil, ou "perfil não preenchido, não compare"}

Escreva um diagnóstico qualitativo (3-6 frases) explicando os pontos fortes e fracos desta
carteira com base SOMENTE nos números acima — interprete, não repita os números literalmente.
Use as referências de concentração, diversificação e alocação por perfil como pano de fundo do
seu raciocínio, citando-as quando forem relevantes pro diagnóstico, mas sem transformar isso numa
lista de regras soltas. Se o diagnóstico geral for fraco (score baixo ou classificação Regular/Ruim),
inclua um lembrete breve de que decisões de rebalanceamento não devem ser tomadas por impulso após
um movimento recente de mercado — vieses como aversão a perda e viés de recência levam a decisões
piores nesse momento. Não invente nenhum dado novo.

Formato de saída: texto plano, sem markdown, 3-6 frases.
```

### Fallback sem IA
`aiDiagnosis` retorna `null` — o frontend mostra um parágrafo genérico fixo no lugar.

---

## 4. Descrição de oportunidades ("Sugestão de Ativos")

**Arquivo:** `artifacts/api-server/src/lib/opportunities-ai.ts` — `describeOpportunity`
**Onde aparece:** tela "Oportunidades", card de cada ativo sugerido
**Disparado por:** `regenerateOpportunities()` (job semanal do scheduler, ou disparo manual via `POST /internal/opportunities/regenerate`) — roda uma vez por ativo qualificado (score ≥ 60) no universo de ~170 tickers, nunca em tempo real por request de usuário
**Cache:** nenhum (o resultado fica persistido na tabela `opportunities` até a próxima regeneração)

### Dados de entrada
- Score do Radar e classificação
- Fundamentos brutos: P/L, P/VP, ROE, Dívida/Patrimônio, Margem líquida, Dividend Yield, Crescimento de receita, Variação 12m, Beta
- Pontos positivos e de atenção já calculados deterministicamente

### Prompt (pede JSON estruturado — validado antes de usar, com fallback determinístico se a resposta vier malformada)

```
Você é um analista que escreve resumos curtos e objetivos de oportunidades de investimento em
ações/FIIs/ETFs/BDRs da B3, para um app de carteira pessoal. NUNCA invente números — use somente
os fornecidos abaixo.

Ticker: {ticker} — {nome} ({categoria})
Score do Radar: {score}/100 ({classificação})
Fundamentos: P/L {pl}, P/VP {pvp}, ROE {roe}%, Dívida/Patrimônio {de}, Margem líquida {margem}%,
Dividend Yield {dy}%, Crescimento de receita {crescimento}%, Variação 12m {var12m}%, Beta {beta}
Pontos positivos calculados: {positivos}
Pontos de atenção calculados: {riscos}

Retorne SOMENTE um JSON válido, sem texto fora dele, no formato:
{"reason": "1-2 frases explicando por que este ativo é uma oportunidade, cruzando os fundamentos",
"positives": ["até 3 frases curtas reescrevendo os pontos positivos de forma mais natural"],
"risks": ["até 3 frases curtas reescrevendo os pontos de atenção de forma mais natural"],
"horizon": "Curto prazo" | "Médio prazo" | "Longo prazo"}
```

### Validação da resposta
`reason` precisa ser string não-vazia; `positives`/`risks` precisam ser arrays de string; `horizon`
precisa ser um dos 3 valores aceitos (senão vira "Médio prazo"). Qualquer falha de parsing/validação
descarta a resposta inteira.

### Fallback sem IA (ou resposta inválida)
`reason` cai no primeiro item de `positives`/`risks` calculado deterministicamente; `positives`/`risks`
usam os 3 primeiros itens calculados; `horizon` vira "Médio prazo".

---

## 5. Classificação de impacto de notícias

**Arquivo:** `artifacts/api-server/src/lib/news.ts` — `classifyImpact`
**Onde aparece:** badge de impacto ao lado de cada manchete (Parecer de Ativo, Radar por ativo)
**Disparado por:** toda vez que uma manchete nova (não cacheada) é buscada para um ticker
**Cache:** 24h, por manchete exata (o impacto de uma manchete não muda)

### Dados de entrada
- O título da manchete (real, buscada no feed RSS de busca do InfoMoney por nome da empresa/ticker)

### Prompt

```
Classifique o impacto da manchete abaixo para um investidor, em exatamente uma destas categorias:
Muito Positivo, Positivo, Neutro, Negativo, Muito Negativo. Responda só com a categoria, sem mais nada.

Manchete: "{título da manchete}"
```

`max_tokens: 12` — é a única chamada do app que não gera texto livre, só uma palavra da lista fixa.

### Fallback sem IA
`impact` fica `null` — a manchete aparece sem badge de impacto, nunca com um impacto chutado.

---

## Resumo de custo/cadência

| Ponto | Quando roda | Cache |
|---|---|---|
| Recomendação por ativo (carteira) | 1x por ativo, ao clicar "Gerar Análise" | 24h |
| Parecer pré-compra | 1x por busca de ticker novo | 12h |
| Diagnóstico da carteira | 1x por carteira, ao abrir Saúde do Portfólio (se score/composição mudou) | 24h |
| Descrição de oportunidades | 1x por ativo qualificado, só no job semanal (~170 tickers varridos, só os com score ≥ 60 chamam IA) | sem cache (persiste até a próxima regeneração) |
| Classificação de notícia | 1x por manchete nova | 24h |
