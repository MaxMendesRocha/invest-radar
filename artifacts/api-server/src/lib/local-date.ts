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
