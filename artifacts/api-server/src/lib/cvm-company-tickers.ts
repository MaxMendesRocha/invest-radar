import { downloadCvmZip, readCvmEntry, CvmDownloadError } from "./cvm-data";
import { kindFromTicker } from "./b3-ticker";
import { logger } from "./logger";

/**
 * O mapa ticker → CNPJ, do Formulário Cadastral (FCA) da CVM.
 *
 * O FCA é o cadastro anual da companhia aberta, e o arquivo `valor_mobiliario` lista os
 * papéis que ela tem em negociação — com `CNPJ_Companhia` e `Codigo_Negociacao` na mesma
 * linha. É o mesmo portal, formato e pipeline das demonstrações, o que significa que o
 * ticker e o CNPJ saem da mesma fonte que publica os números.
 *
 * Ver o docstring de `company_tickers` (lib/db) para as medições de cobertura e
 * unicidade.
 */

/**
 * Desde quando o FCA é publicado nesse formato. Cada arquivo tem ~400 KB, então oito
 * anos custam 3 MB — irrelevante perto dos 375 MB das demonstrações.
 *
 * A janela inteira é lida sempre, e não só o ano corrente, porque o FCA é ANUAL: uma
 * companhia que não entregou o formulário deste ano ainda tem os papéis dela no arquivo
 * do ano passado. Medido: o arquivo de 2026 sozinho traz 384 companhias; os oito anos
 * juntos trazem 430.
 */
export const FCA_START_YEAR = 2019;

export interface TickerMapping {
  ticker: string;
  cnpj: string;
  companyName: string;
  securityKind: string | null;
  tradingEndedAt: string | null;
  /** Data de referência do formulário — usada para o registro mais recente vencer. */
  referenceDate: string;
  version: number;
}

function normalizeCnpj(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * Códigos que não seguem a convenção da B3 são descartados.
 *
 * Não é zelo: companhia preenche esse campo com "0000", "N/A" e "NÃO HÁ" em vez de
 * deixar vazio, e eram exatamente esses seis valores que apareciam ligados a vários
 * CNPJs — o único obstáculo a ticker ser chave primária. Descartados eles, os 650
 * tickers restantes têm um CNPJ cada.
 *
 * A régua é `kindFromTicker`, e não uma expressão regular nova aqui: já existe um lugar
 * neste projeto que define o que é código de negociação válido, e duas definições
 * divergindo fariam o cadastro aceitar um ticker que a ponte não reconhece.
 */
function isTradableCode(ticker: string): boolean {
  return kindFromTicker(ticker) !== "desconhecido";
}

/**
 * Mapeamentos de um ano do FCA.
 *
 * **Lança** CvmDownloadError quando o arquivo não vem, para o job distinguir "ano sem
 * dado" de "não consegui o ano".
 */
export async function fetchTickerMappings(year: number): Promise<TickerMapping[]> {
  const entries = await downloadCvmZip(
    `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FCA/DADOS/fca_cia_aberta_${year}.zip`,
    year,
  );
  const rows = readCvmEntry(entries, `fca_cia_aberta_valor_mobiliario_${year}.csv`);
  if (!rows) throw new CvmDownloadError(year, "ZIP do FCA sem o arquivo de valor mobiliário");

  const mappings: TickerMapping[] = [];
  let descartados = 0;

  for (const row of rows) {
    const ticker = (row.Codigo_Negociacao ?? "").trim().toUpperCase().replace(/\s/g, "");
    if (!ticker) continue;
    if (!isTradableCode(ticker)) { descartados++; continue; }

    const cnpj = normalizeCnpj(row.CNPJ_Companhia ?? "");
    if (!cnpj) continue;

    const version = Number(row.Versao ?? "1");
    mappings.push({
      ticker,
      cnpj,
      companyName: (row.Nome_Empresarial ?? "").trim(),
      securityKind: (row.Valor_Mobiliario ?? "").trim() || null,
      tradingEndedAt: (row.Data_Fim_Negociacao ?? "").trim() || null,
      referenceDate: (row.Data_Referencia ?? "").trim(),
      version: Number.isFinite(version) ? version : 1,
    });
  }

  if (descartados > 0) logger.debug({ year, descartados }, "códigos fora da convenção da B3 descartados no FCA");
  if (mappings.length === 0) throw new CvmDownloadError(year, "FCA baixado mas nenhum código de negociação válido");
  return mappings;
}

/**
 * Colapsa vários anos num mapeamento por ticker, com o registro mais recente vencendo.
 *
 * O mais recente importa porque companhia muda de nome (a ORIZON aparece com dois nomes
 * na base de demonstrações) e papel para de negociar. O CNPJ em si não muda — foi medido
 * que nenhum ticker aponta para dois —, então o desempate decide nome, tipo de papel e
 * data de fim, não a identidade da companhia.
 */
export function collapseToLatest(mappings: TickerMapping[]): TickerMapping[] {
  const byTicker = new Map<string, TickerMapping>();
  for (const m of mappings) {
    const current = byTicker.get(m.ticker);
    if (!current) { byTicker.set(m.ticker, m); continue; }
    const mais_novo =
      m.referenceDate > current.referenceDate ||
      (m.referenceDate === current.referenceDate && m.version > current.version);
    if (mais_novo) byTicker.set(m.ticker, m);
  }
  return Array.from(byTicker.values());
}
