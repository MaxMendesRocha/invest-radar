import { pgTable, text, date, timestamp, index } from "drizzle-orm/pg-core";

/**
 * A ponte entre o ticker que o usuário digita e o CNPJ pelo qual a CVM identifica a
 * companhia.
 *
 * Existe porque `financial_facts` é chaveada por CNPJ — o que está certo, já que PETR3 e
 * PETR4 são a mesma demonstração — e o app só conhecia o CNPJ de FII, que vem pronto do
 * endpoint de fundos da brapi. Para ação não havia mapa nenhum, e o resultado é que as
 * 187.982 linhas de demonstração ingeridas **não alcançavam um único ativo de ação da
 * carteira**. Sem esta tabela, a série da CVM é um arquivo bonito que ninguém consulta.
 *
 * ## De onde vem
 *
 * Do Formulário Cadastral (FCA) da CVM, arquivo `valor_mobiliario`, no mesmo portal e
 * pipeline das demonstrações. Isso importa: o ticker e o CNPJ saem da MESMA fonte que
 * publica os números, então não há um terceiro que possa discordar. As alternativas
 * consideradas eram a lista de empresas listadas da B3 e casar nome da brapi com
 * `DENOM_SOCIAL` da CVM — as duas introduziriam uma fonte a mais e, no caso do nome,
 * casamento aproximado onde existe identificador exato.
 *
 * ## Por que ticker pode ser chave primária
 *
 * Medido sobre os oito anos de FCA (2019–2026), depois de descartar os códigos que não
 * seguem a convenção da B3: **650 tickers, 650 pares distintos, zero ticker apontando
 * para mais de um CNPJ.** O lixo descartado eram companhias preenchendo o campo com
 * "0000", "N/A" ou "NÃO HÁ" em vez de deixar vazio — e eram justamente esses seis que
 * apareciam ligados a vários CNPJs.
 *
 * ## O que o mapa cobre, e o que não cobre de propósito
 *
 * 618 ações, 30 units e 2 BDRs, em 430 companhias. Conferido contra tickers reais:
 * ABEV3, BBDC4, EGIE3, ITUB4, MGLU3, PETR4, RENT3, VALE3 e WEGE3 resolvem; AAPL34,
 * MSFT34, BOVA11, HGLG11, MXRF11 e XPML11 **não** — e é o comportamento correto. Apple e
 * Microsoft não prestam contas à CVM, e fundo imobiliário tem registro próprio, fora do
 * FCA, que o app já obtém pela brapi. O mapa cobre exatamente o conjunto que estava
 * inalcançável.
 *
 * De brinde, ele desfaz parte da ambiguidade do sufixo 11 descrita em `b3-ticker.ts`:
 * um código terminado em 11 que aparece AQUI é unit de companhia listada, não FII nem
 * ETF.
 */
export const companyTickersTable = pgTable("company_tickers", {
  /** Código de negociação da B3, maiúsculo e sem o sufixo de fracionário. */
  ticker: text("ticker").primaryKey(),
  /** Só dígitos, no mesmo formato de `financial_facts.cnpj`, para o join ser direto. */
  cnpj: text("cnpj").notNull(),
  companyName: text("company_name").notNull(),
  /** "Ações Ordinárias", "Ações Preferenciais", "Units"... — como a CVM classifica. */
  securityKind: text("security_kind"),
  /**
   * `Data_Fim_Negociacao`: quando o papel parou de ser negociado. Preenchido em 32 das
   * 537 linhas de 2026 — é deslistagem real, não campo morto. Fica aqui porque um ticker
   * que parou de negociar é, por si, um sinal sobre o dado que se vai ler.
   */
  tradingEndedAt: date("trading_ended_at", { mode: "string" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // O caminho inverso (quais papéis esta companhia tem) é o que responde "PETR3 e PETR4
  // dividem a mesma demonstração".
  index("company_tickers_cnpj_idx").on(t.cnpj),
]);

export type CompanyTicker = typeof companyTickersTable.$inferSelect;
export type InsertCompanyTicker = typeof companyTickersTable.$inferInsert;
