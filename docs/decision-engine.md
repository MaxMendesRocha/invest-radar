# Decision Engine — o que cabe no app, o que não cabe, e por quê

Este documento mapeia a especificação **Invest Radar — Decision Engine** (231 seções)
contra o que o aplicativo realmente tem. Existe para os próximos PRs terem referência e
para que ninguém precise reabrir a discussão sobre por que um pedaço da especificação não
foi implementado.

A conclusão de uma frase: a especificação **não é uma direção nova**. É a generalização de
uma coisa que o app já faz para FIIs e não faz para ações.

---

## A tese, e onde o app já concorda

> Ativo excelente pode ser uma péssima compra quando está caro.
> Ativo barato pode ser uma péssima compra quando a tese está deteriorando.

Isso já está parcialmente codificado. `screenForPurchase` existe justamente porque o
status COMPRAR/MANTER/VENDER depende de quanto o ativo pesa na carteira e não serve para
quem não tem posição. E `computeFiiPriceZones` **já produz faixa de compra em reais**,
derivada da curva de P/VP e do yield exigido sobre a Selic líquida.

Ou seja: os §45–48 da especificação (preço ideal / compra forte / preço máximo) **já
existiam — só que para FII**. Estender para ações era o item de maior valor e menor risco,
e é o que `computeStockPriceZones` faz (seção própria abaixo).

---

## O que já existe (não reconstruir)

| Especificação | No código |
|---|---|
| QualityScore | `analyzeFundamentals`, com interpolação em vez de faixas |
| RiskScore (parcial) | `evalVolatility`, `risk-metrics-engine`, `correlation-engine` |
| TimingScore §24 | `technical-engine` |
| PortfolioFit / concentração §40–43 | `concentrationLimitsFor`, `computeTrimSuggestion`, `allocation-engine` |
| Dividend trap §55 | `distribution-quality-engine`, `dividend-value-engine` |
| Faixas de entrada §45–48 | `computeFiiPriceZones` (FII) e `computeStockPriceZones` (ação) |
| Renda fixa §18 | `treasury-opinion-engine` |
| Ranking §51–52 | `opportunity-ranking`, que já separa "melhores" de "compre agora" |
| Kill switch §93 (parcial) | `resolveAnalysisStatus` VENDER + `statusReason` |
| Alertas §66 | tabela `alerts` + Radar |
| §202–203 (IA não calcula, IA não julga) | já é regra da casa, escrita em `funcionalidades.md` |

O último item merece nota: a especificação chegou de forma independente ao mesmo princípio
que este projeto já seguia. É um bom sinal sobre o resto dela.

---

## O que a série da CVM destravou

A primeira leitura da especificação concluiu que as regras de deterioração (§27) estavam
**bloqueadas por falta de histórico**, e que a saída seria começar a guardar o retrato
semanal e esperar alguns anos.

Isso estava errado. A CVM publica as demonstrações padronizadas das companhias abertas
(DFP) em dados abertos, no **mesmo portal, formato e pipeline** do informe mensal de FII
que o app já ingeria. A série não precisa ser acumulada: ela já existe.

Medido na ingestão real: **57.048 fatos, 625 companhias, 2014 a 2026, em 52 segundos.**

### As três colunas que fazem a diferença

| Coluna | O que resolve |
|---|---|
| `period_end` | a que período o número se refere |
| `published_at` (`DT_RECEB`) | **quando ele passou a ser público** — §133 |
| `version` (`VERSAO`) | retificação convive com a publicação original — §132 |

O `published_at` é o que separa esta tabela de um cache de indicadores. Medido na
Petrobras, a demonstração de 31/12 leva de **54 a 85 dias** para sair. Sem essa distinção,
qualquer estudo retrospectivo usaria em janeiro um número que só existiu em março — e
concluiria que o modelo acerta.

### A armadilha de leitura, e por que existe um leitor próprio

Cada DFP traz o exercício corrente **e** o anterior. O resultado de 2023 aparece no DFP de
2023 e de novo no de 2024:

```
2023-12-31 | publicado 2024-03-25 |  85 dias | R$ 125,2 bi
2023-12-31 | publicado 2025-02-26 | 423 dias | R$ 125,2 bi
```

Ler `published_at` sem cuidado conclui que o resultado de 2023 só ficou público em 2025 —
descartando onze meses de informação que existia. Por isso `financial-history.ts` aplica
duas regras diferentes de propósito: **valor da maior versão, publicação da menor data.**

### O que a CVM *não* entrega: capex, e portanto FCF

O plano de contas é padronizado; o texto ao lado dele não é. Medido no DFP de 2024:

| Conta | Rótulos distintos | Comparável entre empresas? |
|---|---|---|
| `6.01` caixa das operações | 3, todos sinônimos | sim |
| `6.02` caixa de investimento | 1 | sim |
| `6.02.01` subconta | **310 entre 430 companhias** | não |

Capex vive numa subconta de investimento e **não tem código estável** — só 179 das 430
companhias mencionam "imobilizado" ou "intangível" no rótulo. Extrair por casamento de
texto acertaria menos da metade e erraria em silêncio no resto.

Consequência: **FCF não sai desta fonte** pela fórmula do §136 (FCO − capex). O que fica é
o caixa das operações, com 100% de cobertura — suficiente para conversão de caixa
(FCO ÷ lucro), que é a pergunta que mais importa: o lucro declarado virou dinheiro?

### Cobertura ingerida

| Métrica | Conta | Cobertura |
|---|---|---|
| receita | `3.01` | 100% |
| ebit | `3.05` | 100% |
| lucro_liquido | rótulo `consolidado do período` (`3.09`/`3.11`/`3.13`) | 100% |
| ativo_total | `1` | 100% |
| caixa | `1.01.01` | 99,1% |
| divida_curto_prazo | `2.01.04` | 96,6% |
| divida_longo_prazo | `2.02.01` | 98,7% |
| patrimonio_liquido | rótulo `Patrimônio Líquido Consolidado` (`2.03`/`2.07`/`2.08`) | 100% |
| caixa_operacional | `6.01` | 100% (somando método direto e indireto) |

Na maioria das métricas o código é o mesmo para banco e para empresa operacional; só o
rótulo muda (`3.01` é "Receita de Venda" na indústria e "Receitas de Intermediação
Financeira" no banco). Chavear por código, e não por texto, é o que faz o mapeamento
atravessar setores.

### Duas exceções que invertem a regra

Em **duas** métricas acontece o inverso — **o rótulo é estável e o código é que se move**.
As duas são de instituição financeira, e as duas custaram um bug.

#### 1. O lucro líquido

Banco tem DRE mais curta (sem custo de mercadoria vendida, sem as linhas intermediárias de
uma indústria), então a numeração desloca. Medido no DFP de 2024, o rótulo
"Lucro/Prejuízo Consolidado do Período" aparece em **três códigos**: `3.09` (Itaú,
Santander, BTG), `3.11` (o caso comum) e `3.13`.

Chavear por `3.11` produzia dois defeitos ao mesmo tempo:

| | por ano | efeito |
|---|---|---|
| Lucro em outro código | 9 companhias | ficavam **sem lucro nenhum** |
| `3.11` é outra conta | 2 companhias | recebiam **o número errado** em silêncio |

O segundo é o pior: para essas duas, `3.11` é "Resultado Líquido das Operações
Continuadas" e o lucro de verdade está no `3.13`. Não faltava dado — entrava dado errado
com toda a cara de certeza.

Na base acumulada, **17 das 664 companhias não tinham uma única linha de lucro**, entre
elas os maiores bancos do país. Depois da troca para busca por rótulo: **625 de 627**, e as
duas que sobram são listagens recentes sem exercício anual fechado (têm lucro trimestral).

#### 2. O patrimônio líquido — o mesmo defeito, pior

O balanço patrimonial passivo de instituição financeira usa outro plano de contas inteiro,
e o `2.03` que numa companhia comum é o patrimônio vira outra coisa:

| | `2.03` — o que o código pegava | Onde o PL realmente está |
|---|---|---|
| Banco do Brasil | *Provisões* — R$ 39 bi | `2.07` — R$ 194 bi |
| Itaú Unibanco | *Passivos Financeiros ao Custo Amortizado* — R$ 2.351 bi | `2.08` — R$ 215 bi |

O Itaú entrava com **um passivo de R$ 2,3 trilhões gravado como patrimônio líquido** — dez
vezes o valor certo, e de outra natureza. Qualquer ROE ou alavancagem calculado sobre isso
seria ficção com cara de medição.

Medido no BPP consolidado de 2025, o rótulo "Patrimônio Líquido Consolidado" aparece em
**438 de 438 companhias**; o código `2.03` cobriria 428 (97,7%), e as outras 13 usam `2.07`
ou `2.08`. Depois da correção, o PL sobre ativo total fica em 7,9% no Banco do Brasil e
7,0% no Itaú — capitalização normal de banco — contra 34,1% na Petrobras e 39,7% na Vale.

O defeito foi encontrado pela decomposição DuPont: nenhuma tela consumia
`patrimonio_liquido` até então, então o número errado estava gravado sem nunca ter sido
exibido. É o argumento a favor de construir a leitura antes de confiar no dado.

O rótulo é seguro aqui, e isso foi conferido antes de trocar a regra: no DRE consolidado
inteiro, "consolidado do período" aparece só nas linhas de lucro final — nenhum falso
positivo, e nenhuma companhia com o rótulo em dois códigos no mesmo período.

A lição generalizável: **qual identificador é estável depende da conta**, e supor que é
sempre o código foi o que escondeu o defeito.

### O trimestral (ITR): a defasagem cai de um ano para um trimestre

O ITR tem estrutura idêntica à do DFP — mesmos arquivos, mesmos códigos, mesmo índice com
`DT_RECEB` —, então mudou só a URL. O ganho é recentidade: medido na Petrobras, a série
anual termina em 31/12/2025 e a trimestral em 30/06/2026.

Ingestão medida: **187.982 fatos** (56.751 anuais + 131.231 trimestrais), 625 companhias
no anual e 559 no trimestral. A execução leva de **2min40s a 7 minutos** — medido mais de uma
vez, e a variação é o tempo de resposta do portal da CVM, não o processamento.

**O mesmo `period_end` é publicado duas vezes.** O ITR traz, para o mesmo fim de período,
o trimestre isolado e o acumulado do ano — no 2T de 2025 do Banco do Brasil, R$ 78 mi e
R$ 149 mi ambos em 30/06. Medido no arquivo de 2025: 1.794 de 2.706 chaves têm mais de um
período. Daí a coluna `period_kind` (`saldo` / `exercicio` / `trimestre` / `acumulado`),
que entra na chave única — sem ela, **22.689 linhas** seriam descartadas em silêncio, e
quais sobreviveriam dependeria da ordem das linhas no CSV.

As duas formas são guardadas porque uma confere a outra: 1T + 2T tem que fechar com o
semestre. Medido, fecham em **96,4%** dos casos (3.167 de 3.285); o resto erra em unidades
de porcento porque a companhia retificou o 1T ao publicar o 2T — que é precisamente a
razão de `version` e `published_at` existirem nesta tabela.

**Limitação declarada:** o último trimestre do exercício praticamente não existe no ITR
(42 linhas em 39 mil, 0,11%). Quem quiser o 4T tem de derivá-lo do DFP menos o acumulado
de nove meses.

### A escala que a fonte declara errado

`ESCALA_MOEDA` diz em que unidade a linha está, e às vezes diz errado. A ODONTOPREV
declarou MIL no 1T de 2021, **UNIDADE no 2T** e MIL no 3T, com valores da mesma ordem de
grandeza nos três — aplicar a escala ao pé da letra punha o 2T mil vezes menor, uma queda
de 99,9% inventada sobre uma empresa real. O mesmo defeito estava na base anual já
ingerida: a BRK Ambiental tinha 2020 gravado como R$ 2.382.216 **e** R$ 2.382.216.000.

`dropInconsistentScale` descarta as linhas cuja escala contradiz a que a companhia usou no
resto da série — 513 linhas no anual, 1.594 no trimestral. Duas decisões de projeto:

- **MIL vence, e não a escala mais frequente.** O BCO PINE declarou MIL no 1T de 2024 e
  UNIDADE no 2T e 3T: a minoria é que estava certa. MIL é 97,6% das linhas do arquivo, e
  quando a companhia se contradiz é o desvio que se descarta, não a norma.
- **Descartar, não corrigir.** Corrigir seria afirmar que o declarante quis dizer MIL. É
  quase certo que quis — mas "quase certo" aplicado em silêncio a um número que vira
  recomendação é o erro que este projeto já pagou caro. Buraco na série o motor enxerga;
  número errado, não.

Consequência operacional: a janela inteira é relida a cada execução, e não só os dois anos
recentes. A conferência enxerga a contradição comparando anos, então uma janela curta
regravaria o que a longa descartou — medido, 308 linhas voltaram numa execução de dois
anos logo após um backfill de nove. A correção se desfaria sozinha, semana após semana.

---

## O que continua bloqueado

| Bloqueado | Motivo |
|---|---|
| Consenso de analistas §151 | brapi responde 403; a CVM não publica isso |
| ETFs §144 | TER, holdings e tracking só no site do gestor — seria scraping |
| Guidance §215 | não existe em formato estruturado |
| DCF §11 | ver abaixo |

### Sobre o DCF

Com FCO e dívida da CVM, um DCF fica tecnicamente construível. Continua **não
recomendado**: projeção de fluxo e WACC teriam de ser arbitrados, e são exatamente os dois
insumos que dominam o resultado. A especificação oferece a saída no §57–58 (matriz de
sensibilidade e robustez), que é honesta — mas a *faixa* de premissas também seria
arbitrada. Valuation por múltiplo normalizado contra o próprio setor usa dado observado, e
responde à mesma pergunta sem inventar duas variáveis.

O §220–221 (Monte Carlo, 10.000 simulações) é o mesmo problema multiplicado: a
distribuição de saída é inteiramente determinada por distribuições de entrada inventadas.

---

## Onde discordar da especificação

**Os pesos.** Somando §4, §6, §22, §24, §28, §40 e §62, são cerca de **60 parâmetros
definidos à mão**. O §111 alerta contra overfitting — e o documento então fornece os 60
números.

Este projeto já pagou essa conta: a escala de score original ia de 0 a 100 no papel, mas o
universo real cabia entre **43 e 74**, com 29% dos ativos empatados, e os status COMPRAR e
VENDER **nunca dispararam na vida do aplicativo**. Ninguém tinha percebido porque ninguém
tinha medido.

Regra para qualquer peso novo: **medir o efeito sobre o universo real antes de subir.** É o
terceiro princípio da casa, e é o que impede a especificação de virar 60 chutes bem
formatados.

**A stack do §197** (Python, FastAPI, SQLAlchemy, Celery, Redis) não se aplica: o app é
TypeScript com Express, Drizzle e scheduler no próprio processo, e a matemática aqui é
aritmética, não aprendizado de máquina.

**As três camadas do §177–180** (Raw / Canonical / Feature) são arquitetura de data
warehouse para um time. O princípio — nunca descartar o bruto, guardar proveniência —
vale, e está em `source_url`. As camadas, não nesta escala.

---

## O portão de dado insuficiente

O app produzia uma nota com exatamente a mesma cara de confiança tendo visto três
indicadores ou oito, e a partir dela dizia "Comprar". `AGUARDAR` é a recusa de opinar, e
vem **antes** dos outros três status — não é um estado entre MANTER e VENDER.

### Lacuna nomeada, e não `DataConfidence = 0–100`

A especificação pede uma nota de 0 a 100 somando cinco componentes ponderados (30%
freshness, 25% completeness, …). Cada um desses pesos seria arbitrado, e este projeto já
pagou essa conta uma vez. O que se entrega no lugar é uma **lista de lacunas
verificáveis**, cada uma com severidade que decide sozinha:

| Lacuna | Severidade | Limiar, e de onde ele vem |
|---|---|---|
| `sem_cotacao` | bloqueia | não há preço nenhum; a posição está sendo avaliada pelo preço médio de compra |
| `cotacao_muito_datada` | bloqueia | > 7 dias. O maior fechamento contínuo da B3 é o carnaval (sexta → quarta, 5 dias corridos); acima de uma semana não há explicação de calendário |
| `cotacao_datada` | limita | ≤ 7 dias — a chamada ao vivo falhou e o app caiu no último preço guardado |
| `sem_dimensoes` | bloqueia | nenhum indicador |
| `dimensao_unica` | bloqueia | a nota **é** esse indicador; mesmo argumento que já justificava o mínimo de 3 para ação |
| `cobertura_parcial` | limita | menos de metade da régua. As 81 ações do universo têm 6,9 indicadores em média, então o corte atinge a exceção |

As três faixas da especificação sobrevivem (`suficiente` / `parcial` / `insuficiente`),
decididas pela pior lacuna presente — regra transparente em vez de soma ponderada.

### A assimetria que a medição revelou

A régua de ação exigia 3 indicadores. **A de FII não tinha piso nenhum:** bastava uma das
quatro dimensões, e a renormalização transformava um peso de 35% (yield) em 100%. O fundo
saía com nota cheia apoiada num número só. `dimensao_unica` fecha isso.

### O que o portão NÃO cala

`VENDER` por concentração sobrevive. Quanto do patrimônio está num papel é aritmética
sobre a carteira da própria pessoa — não depende de provedor nenhum. Calar sobre uma
posição de 60% porque a cotação envelheceu seria trocar um alerta real por silêncio. Já o
`statusReason` de fundamento fraco some: a nota pode estar baixa só porque metade dos
indicadores não veio.

Na triagem pré-compra o resultado vira `sem_dados`, e não `nao_atende` — "não atende"
afirma que a régua foi aplicada e o ativo ficou abaixo do corte, e com dado insuficiente a
régua não chegou a ser aplicada.

### Duas ideias derrubadas por medição

**Faixa de plausibilidade do valor.** A intenção era marcar indicador absurdo — o P/L
149.050 que a brapi devolve para TSMC34 é corrupção da razão de conversão do BDR, e o
`interpolate` satura, então o clamp decide a nota e não o dado (TSMC34 → 22 "Crítico",
LILY34 com P/L 2,6 → 92 "Excelente"). Medi a faixa real com as demonstrações da CVM antes
de definir limiar, sobre 505 companhias:

| | p01 | mediana | p99 | máximo |
|---|---|---|---|---|
| ROE | −229% | **9,5%** | 243% | **1877** |
| Margem líquida | −454% | 5,6% | 156% | 13,8 |

Companhia com patrimônio pequeno e lucro normal produz ROE que parece absurdo e é
verdadeiro. Qualquer faixa que pegasse o BDR corrompido reprovaria empresa real — e o caso
do BDR já é barrado pelo mínimo de indicadores. A ideia saiu.

(De passagem: a curva de `evalROE` termina em 25%, e o p99 do universo real é 243%. Isso é
calibração de score, não de confiança, e fica registrado aqui sem ser mexido — mexer exige
medir o efeito sobre o universo inteiro.)

**Cruzamento brapi × CVM (§172).** Era o sinal mais valioso que faltava. Duas descobertas
o adiaram:

1. **Cruzar razões não funciona.** Comparei o mesmo ROE visto pelo anual e pelos quatro
   trimestres mais recentes — duas visões *legítimas*, ambas da CVM. Divergência mediana
   de **32%**, p90 de 237%, e 13% das empresas acima de 2×. Qualquer limiar apertado
   marcaria ruído. Cruzar **níveis** (`netIncome` contra `lucro_liquido`) é o caminho
   certo, porque é o mesmo número com a mesma definição.
2. **Falta a ponte ticker → CNPJ.** `financial_facts` é chaveada por CNPJ; o app só
   conhece o CNPJ de **FII**, que vem do endpoint de fundos da brapi. Para ação não há
   mapa, e o cadastro da CVM (`cad_cia_aberta.csv`) **não publica ticker**.

Ou seja: os 187.982 fatos ingeridos ainda **não alcançam nenhum ativo de ação do usuário**.
Isso bloqueia o cruzamento, o valor justo por múltiplo e as regras de deterioração — os
três itens seguintes desta lista. Construir esse mapa passou a ser o pré-requisito de
tudo, e as fontes candidatas são a lista de empresas listadas da B3 ou o casamento por
nome entre `DENOM_SOCIAL` da CVM e o `longName` da brapi.

---

## A ponte ticker → CNPJ

`financial_facts` é chaveada por CNPJ, o que está certo — PETR3 e PETR4 são a mesma
demonstração. Mas a carteira é chaveada por ticker, e o app só conhecia o CNPJ de FII
(vem pronto do endpoint de fundos da brapi). O resultado é que os **187.982 fatos
ingeridos não alcançavam um único ativo de ação**: um arquivo bonito que ninguém
consultava.

### A fonte é a própria CVM

O Formulário Cadastral (FCA), arquivo `valor_mobiliario`, traz `CNPJ_Companhia` e
`Codigo_Negociacao` na mesma linha — mesmo portal e mesmo pipeline das demonstrações.
Isso importa: o ticker e o CNPJ saem da **mesma fonte que publica os números**, então não
há um terceiro que possa discordar.

As alternativas eram a lista de empresas listadas da B3 e casar o nome da brapi com
`DENOM_SOCIAL` da CVM. As duas acrescentariam uma fonte, e a segunda usaria casamento
aproximado onde existe identificador exato. (O cadastro simples da CVM,
`cad_cia_aberta.csv`, **não** publica ticker — foi o primeiro lugar em que olhei.)

Oito anos de FCA custam **3 MB** contra os 375 MB das demonstrações. A janela inteira é
lida sempre porque o formulário é anual: o arquivo de 2026 sozinho traz 384 companhias, e
os oito anos juntos trazem 430.

### Por que ticker pode ser chave primária

Medido sobre 2019–2026, depois de descartar códigos fora da convenção da B3: **650
tickers, 650 pares distintos, zero ticker apontando para mais de um CNPJ.**

O lixo descartado eram companhias preenchendo o campo com `0000`, `N/A` ou `NÃO HÁ` em
vez de deixar vazio — e eram exatamente esses seis valores que apareciam ligados a vários
CNPJs. O filtro é `kindFromTicker` (de `b3-ticker.ts`), e não uma expressão regular nova:
já existe um lugar que define o que é código de negociação válido, e duas definições
divergindo fariam o cadastro aceitar um ticker que a ponte não reconhece.

### O que cobre — e o que não cobre, de propósito

618 ações, 30 units, 2 BDRs, em 430 companhias. **382 das 627 companhias com
demonstração (61%) ficaram alcançáveis.** As 245 restantes são emissoras registradas na
CVM sem ação em bolsa — dívida, capital fechado com registro.

Conferido contra tickers reais: ABEV3, BBDC4, EGIE3, ITUB4, MGLU3, PETR4, RENT3, VALE3 e
WEGE3 resolvem. AAPL34, MSFT34, BOVA11, HGLG11, MXRF11 e XPML11 **não** — e é o
comportamento correto: Apple não presta contas à CVM, e fundo imobiliário tem registro
próprio, fora do FCA. O mapa cobre exatamente o conjunto que estava inalcançável.

Dois cuidados na leitura: `PETR4F` (fracionário) normaliza para `PETR4`, porque é o mesmo
papel e a CVM cadastra só o código cheio; e ausência devolve série **vazia**, nunca erro —
para um BDR isso é a resposta certa, não uma falha.

De brinde, o mapa desfaz parte da ambiguidade do sufixo 11 descrita em `b3-ticker.ts`: um
código terminado em 11 que aparece aqui é unit de companhia listada, não FII nem ETF.

### O que isso destrava

`getFinancialSeriesForTicker("PETR4", "receita")` devolve doze exercícios com a receita
real da Petrobras (R$ 497,5 bi em 2025) e a série trimestral até 30/06/2026. Os itens 6 e
7 desta lista — valor justo por múltiplo normalizado e regras de deterioração — dependiam
disso e passam a ser construíveis.

O cruzamento brapi × CVM também: com o CNPJ em mãos, dá para comparar `netIncome` da
brapi contra `lucro_liquido` da CVM. Comparando **níveis**, não razões — a medição da
seção anterior mostrou que razões divergem 32% na mediana por motivo legítimo.

---

## Faixa de entrada em reais para ação (§45–48)

Era a maior assimetria entre as duas réguas: `computeFiiPriceZones` já produzia faixa de
compra em reais para FII, e ação não tinha equivalente. O módulo novo
(`stock-price-zones.ts`) segue a mesma estrutura de propósito — se as duas telas dizem
"faixa de entrada", a expressão precisa significar a mesma coisa nas duas.

### Duas leituras que podem discordar

Como no FII, são contas independentes: **por lucro** (o múltiplo que o setor paga por
lucro, aplicado ao lucro normalizado da companhia) e **por patrimônio** (o P/VP do setor
aplicado ao valor patrimonial por ação). Elas medem coisas diferentes, e o desacordo é a
informação — empresa barata pelo patrimônio e cara pelo lucro é uma descrição, não erro de
conta. Forçar uma média esconderia justamente o caso interessante.

**A de patrimônio é a mais firme, e isso foi medido.** Sobre cinco exercícios das
companhias na base:

| | volatilidade mediana | companhias com ano não positivo |
|---|---|---|
| Lucro líquido | **0,70** | 258 de 491 (53%) |
| Patrimônio líquido | **0,20** | 101 de 500 (20%) |

O patrimônio é 3,5× mais estável. A leitura por lucro discrimina mais e oscila mais — as
duas aparecem, e a ordem em que se lê é do leitor.

### Lucro normalizado: por que não usar o último exercício

O desvio-padrão do lucro anual é **70% da média** na companhia mediana. Avaliar pelo
último exercício ancora a conta num número que quase nunca representa a empresa.

A normalização é a **mediana** de até cinco exercícios — mediana e não média porque, com
53% das companhias tendo algum ano de prejuízo, a média despenca ou vira negativa por
causa de um exercício. Mesma escolha que `sector-benchmarks` já tinha feito pelo mesmo
motivo.

Quanto isso muda, medido sobre as 307 companhias com último exercício e mediana ambos
positivos: a razão mediana é 0,93 — pequena no agregado. Mas **88 (29%) têm normalizado
abaixo de 70% do último ano** e 48 (16%) acima de 140%. Em quase metade dos casos a base
de avaliação se move mais de 30%.

E há **66 companhias em que o sinal inverte**: 27 com último exercício positivo e mediana
não positiva (um ano bom depois de quatro ruins), 39 no contrário. São exatamente os casos
em que avaliar pelo último ano erra mais feio — e onde o motor agora se recusa a produzir
faixa em vez de produzir uma com sinal trocado.

### A faixa vem da dispersão do setor, não de uma margem arbitrada

A especificação sugere `MaximumBuyPrice = FairValue × (1 − MOS)` com MOS de 20% — os 20%
seriam um número escolhido. Aqui o intervalo é o **primeiro quartil e a mediana do próprio
setor**: comprar ao múltiplo do p25 é pagar o que se paga pelas mais baratas do setor; ao
da mediana, o que se paga por uma típica.

É a mesma lógica de `FII_PVP_HEALTHY_DISCOUNT_RANGE`, com a diferença de que ali a faixa é
fixa (0,85–0,95 do VP) e aqui é medida em cada setor a cada varredura. Isso exigiu os
quartis em `sector_benchmarks` — o item 5 desta lista, que existia precisamente porque
faixa precisa de dispersão e não só de valor central.

### Sem número de ações

O lucro por ação do último exercício é `preço ÷ P/L`, e o valor patrimonial por ação é
`preço ÷ P/VP`. Mesmo truque de `computeFiiPriceZones`, que obtém o VP/cota sem pedir a
quantidade de cotas. A série da CVM entra como **fator** (`normalizado ÷ último`), não como
valor absoluto — o que também a torna imune a erro de escala na conversão por ação.

---

## Ordem sugerida

1. ~~`financial_facts` a partir do DFP da CVM~~ — **feito**.
2. ~~**ITR (trimestral)**, mesma tabela~~ — **feito**, com uma coluna a mais na chave
   (`period_kind`) porque o trimestral publica o mesmo `period_end` duas vezes.
3. ~~**Confiança no dado + portão de AGUARDAR**~~ — **feito**, com duas mudanças de
   desenho decididas por medição. Ver a seção própria abaixo.
4. ~~**Ponte ticker → CNPJ**~~ — **feito**. Veio do Formulário Cadastral da CVM, a mesma
   fonte das demonstrações. Ver a seção própria abaixo.
5. ~~**Percentis por setor**~~ — **feito** (p25/p75 de P/L e P/VP). Foram feitos junto
   com o item 6, que é quem precisa deles: faixa exige dispersão, não valor central.
6. ~~**Valor justo por múltiplo normalizado → faixas de entrada para ações**~~ (§45–48) —
   **feito**, com a faixa saindo do p25 e da mediana do próprio setor em vez de uma
   margem de segurança arbitrada. Ver a seção própria acima.
7. **Regras de deterioração** (§27), agora que a série existe e alcança a carteira:
   `consecutiveDeclines` já está em `financial-history.ts`, e o lucro normalizado dá a
   base contra a qual medir a queda.
8. **Cruzamento brapi × CVM** (§172), destravado pela ponte: comparar `netIncome` contra
   `lucro_liquido` em NÍVEL, nunca em razão.

---

## Como rodar

O backfill baixa ~13 MB por ano e leva menos de um minuto para os doze anos:

```
POST /api/internal/financial-facts/sync
Authorization: Bearer $INTERNAL_JOB_TOKEN
```

Depois disso o job semanal só rebaixa os dois anos mais recentes — exercício fechado não é
republicado com frequência que justifique o contrário.

Conferência: `harness/financial-facts-check.mts`.
