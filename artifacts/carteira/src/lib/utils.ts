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

export function formatPercent(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "percent",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 100)
}
