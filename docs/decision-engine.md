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
existem — só que para FII**. Estender para ações é o item de maior valor e menor risco.

---

## O que já existe (não reconstruir)

| Especificação | No código |
|---|---|
| QualityScore | `analyzeFundamentals`, com interpolação em vez de faixas |
| RiskScore (parcial) | `evalVolatility`, `risk-metrics-engine`, `correlation-engine` |
| TimingScore §24 | `technical-engine` |
| PortfolioFit / concentração §40–43 | `concentrationLimitsFor`, `computeTrimSuggestion`, `allocation-engine` |
| Dividend trap §55 | `distribution-quality-engine`, `dividend-value-engine` |
| Faixas de entrada §45–48 | `computeFiiPriceZones` — **só FII** |
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
| lucro_liquido | `3.11` | 98,5% |
| ativo_total | `1` | 100% |
| caixa | `1.01.01` | 99,1% |
| divida_curto_prazo | `2.01.04` | 96,6% |
| divida_longo_prazo | `2.02.01` | 98,7% |
| patrimonio_liquido | `2.03` | 100% |
| caixa_operacional | `6.01` | 100% (somando método direto e indireto) |

O código da conta é o mesmo para banco e para empresa operacional; só o rótulo muda
(`3.01` é "Receita de Venda" na indústria e "Receitas de Intermediação Financeira" no
banco). Chavear por código, e não por texto, é o que faz o mapeamento atravessar setores.

### O trimestral (ITR): a defasagem cai de um ano para um trimestre

O ITR tem estrutura idêntica à do DFP — mesmos arquivos, mesmos códigos, mesmo índice com
`DT_RECEB` —, então mudou só a URL. O ganho é recentidade: medido na Petrobras, a série
anual termina em 31/12/2025 e a trimestral em 30/06/2026.

Ingestão medida: **187.982 fatos** (56.751 anuais + 131.231 trimestrais), 625 companhias
no anual e 559 no trimestral, em **2min40s**.

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

## Ordem sugerida

1. ~~`financial_facts` a partir do DFP da CVM~~ — **feito**.
2. ~~**ITR (trimestral)**, mesma tabela~~ — **feito**, com uma coluna a mais na chave
   (`period_kind`) porque o trimestral publica o mesmo `period_end` duas vezes.
3. **`DataConfidenceScore` + portão de AGUARDAR** (§5, §29.1). O app já sabe `priceAsOf`,
   `pricesStale`, quais fundamentos vieram nulos e o `sampleSize` de cada setor — falta
   virar um número explícito. E agora tem um insumo novo: **cross-validation brapi × CVM**
   (§172), porque dois lucros líquidos discordando é sinal real de confiança baixa.
4. **Percentis P10/P50/P90 por setor** (§7, §142). A varredura semanal já busca os
   fundamentos do universo inteiro e calcula a mediana; guardar os percentis custa uma
   coluna.
5. **Valor justo por múltiplo normalizado → faixas de entrada para ações** (§45–48), com
   Bear/Base/Bull saindo da dispersão observada do setor em vez de cenário arbitrado.
6. **Regras de deterioração** (§27), agora que a série existe: `consecutiveDeclines` já
   está em `financial-history.ts`.

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
