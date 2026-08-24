/**
 * Data "de hoje" no fuso do usuário, não em UTC.
 *
 * `new Date().toISOString().slice(0,10)` devolve a data UTC. O servidor roda em UTC
 * e o usuário está em horário de Brasília (UTC−3), então entre 21h e 0h a data
 * gravada já era a do dia seguinte. Isso deslocava o snapshot diário de patrimônio e,
 * na virada do mês, atribuía os últimos dias de um mês ao mês seguinte nas
 * comparações de fechamento (findSnapshotForMonth, portfolio-history.ts).
 *
 * O fuso é configurável por APP_TIMEZONE porque é uma decisão de produto — qual
 * calendário o app considera "o dia" —, não uma constante técnica.
 */
const APP_TIMEZONE = process.env.APP_TIMEZONE ?? "America/Sao_Paulo";

const DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "YYYY-MM-DD" no fuso do app. en-CA já formata nessa ordem. */
export function todayInAppTimezone(): string {
  return DATE_FORMATTER.format(new Date());
}

/**
 * Normaliza para "YYYY-MM-DD" o valor de data vindo do corpo validado pelo zod.
 *
 * O zod gerado a partir de `format: date`/`date-time` no OpenAPI entrega **Date**
 * (`z.coerce.date()`), enquanto as colunas de data usam `mode: "string"`. Quem testa
 * `typeof value === "string"` para decidir o que gravar recebe sempre `false` depois
 * da coerção — e cai num `String(date)`, que produz `Tue Jul 14 2026 00:00:00 GMT+0000`
 * e o Postgres rejeita.
 *
 * Esse bug já apareceu duas vezes por estar copiado dentro de uma rota em vez de
 * compartilhado: primeiro em assets.ts (toda data de compra era descartada em
 * silêncio), depois em transactions.ts (todo POST de provento devolvia 500, ou seja,
 * registrar dividendo nunca funcionou). Por isso mora aqui agora.
 *
 * O corte é feito sobre o ISO em UTC de propósito: o valor já chega como instante
 * absoluto do provedor ou do formulário, e reinterpretá-lo em fuso local deslocaria
 * a data em pagamentos gravados à meia-noite.
 */
export function isoDate(value: string | Date): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/**
 * Piso de data para operação. A B3 nasceu em 1890 e nenhuma posição de pessoa física
 * chega perto disso — o valor não precisa ser exato, precisa ser inequivocamente antes
 * de qualquer compra real e depois de zero.
 */
const EARLIEST_TRADE_DATE = "1900-01-01";

/**
 * Data de operação implausível — ou null quando passa.
 *
 * Nasceu de um cadastro real com data no ano 0001, que o `<input type="date">` aceita
 * sem piscar (basta digitar "1" no campo de ano) e o servidor gravava. Não é só feio na
 * tela: a data de compra decide direito a provento, é a origem da série de rentabilidade
 * e ordena o replay dos lançamentos — uma data no ano 1 ou no futuro contamina os três.
 *
 * Comparação de string funciona porque ISO "YYYY-MM-DD" ordena lexicograficamente igual
 * a cronologicamente, e evita construir Date só para comparar.
 */
/**
 * A mesma checagem de faixa, mais a data que **não existe no calendário**.
 *
 * `2026-02-30` é aceito pelo `<input type="date">` em alguns navegadores e pelo
 * `z.coerce.date()` sempre: o `Date` do JavaScript não recusa dia inválido, ele
 * **transborda** para o mês seguinte. O usuário digita 30 de fevereiro, o app grava 2 de
 * março e ninguém é avisado da troca.
 *
 * Só o texto original denuncia isso, porque depois da coerção a data já é outra — por
 * isso esta função recebe o valor cru além do normalizado, e compara os dois.
 */
export function invalidTradeDate(raw: unknown, iso: string): string | null {
  if (typeof raw === "string" && raw.length >= 10 && raw.slice(0, 10) !== iso) {
    return `Data inexistente no calendário (${raw.slice(0, 10)}) — confira o dia e o mês.`;
  }
  return implausibleTradeDate(iso);
}

export function implausibleTradeDate(iso: string): string | null {
  if (iso < EARLIEST_TRADE_DATE) {
    return `Data anterior a ${EARLIEST_TRADE_DATE.slice(0, 4)} — confira o ano digitado.`;
  }
  if (iso > todayInAppTimezone()) {
    return "Data no futuro — informe a data em que a operação aconteceu.";
  }
  return null;
}
