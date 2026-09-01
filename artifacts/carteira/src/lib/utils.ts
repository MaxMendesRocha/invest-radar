import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value)
}

/**
 * "07/08 às 11h32" — usado para datar um preço defasado (Asset.priceAsOf,
 * PortfolioSummary.pricesStale). Sem ano de propósito: o preço só é servido dentro de
 * uma janela de 30 dias, então dia/mês e hora são o que responde "de quando é isso".
 */
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const day = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit" }).format(date)
  const time = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(date)
  return `${day} às ${time.replace(":", "h")}`
}

/** "2026-08-06" -> "06/08". Data pura, sem hora — ex. data-base do Tesouro. */
export function formatShortDate(iso: string): string {
  const [, month, day] = iso.split("-")
  return month && day ? `${day}/${month}` : iso
}

// Minúsculo: entra no meio de uma frase ("de sexta, 28/08"), não como rótulo isolado.
const DIA_DA_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"]

/**
 * De quando é a data-base do Tesouro, em relação a hoje.
 *
 * O PU de título público nunca é de agora: o dado aberto publica com um pregão de
 * atraso, então numa terça o app mostra o preço de segunda e numa segunda o de sexta. A
 * data sozinha ("28/08") responde a que dia o valor se refere, mas não avisa que ele não
 * é o de hoje — quem lê numa segunda à noite não converte "28/08" para "isto é de sexta"
 * sem parar para pensar. O dia da semana faz essa conversão pelo leitor, e some quando a
 * data-base é a de hoje.
 *
 * ## Sempre em UTC
 *
 * A data-base chega como `2026-08-28T00:00:00Z`. Lida com `getDay()` num fuso a oeste de
 * Greenwich, ela devolve o dia ANTERIOR — a meia-noite UTC de sexta é quinta às 21h em
 * Brasília. O dia da semana existe justamente para denunciar defasagem; errado por um,
 * ele mentiria com mais convicção do que a data crua que veio substituir.
 *
 * ## `desatualizado` é outra coisa
 *
 * O atraso normal é de um pregão, e nem feriado prolongado passa de quatro ou cinco dias
 * corridos (conferido contra o Carnaval). Além de uma semana já não é a natureza da
 * fonte: é o job de sincronização parado — e aí vale o âmbar que o app reserva para
 * problema de verdade. Âmbar todo dia viraria ruído que ninguém lê justamente no dia em
 * que ele fizer falta.
 */
export function baseDateVintage(iso: string): { dataCurta: string; dia: string | null; desatualizado: boolean } {
  const dataIso = iso.slice(0, 10)
  const dataCurta = formatShortDate(dataIso)
  const [y, m, d] = dataIso.split("-").map(Number)
  if (!y || !m || !d) return { dataCurta, dia: null, desatualizado: false }

  const base = Date.UTC(y, m - 1, d)
  const agora = new Date()
  const hoje = Date.UTC(agora.getFullYear(), agora.getMonth(), agora.getDate())
  const diasCorridos = Math.round((hoje - base) / 86_400_000)

  if (diasCorridos <= 0) return { dataCurta, dia: null, desatualizado: false }
  return {
    dataCurta,
    dia: DIA_DA_SEMANA[new Date(base).getUTCDay()] ?? null,
    desatualizado: diasCorridos > 7,
  }
}

/**
 * "sexta, 28/08" quando a taxa não é de hoje; "28/08" quando é. Feito para compor a
 * frase das sugestões de aporte, que já dizem "taxa de ...".
 *
 * Sem o âmbar de `baseDateVintage` de propósito: ali o número marca uma posição que a
 * pessoa TEM, e um valor velho distorce o patrimônio; aqui ele é referência para uma
 * compra que ela ainda vai fazer, e o dia da semana basta para situar.
 */
export function rateVintage(iso: string): string {
  const { dataCurta, dia } = baseDateVintage(iso)
  return dia ? `${dia}, ${dataCurta}` : dataCurta
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}
