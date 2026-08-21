import { detectCorporateEvents, type FiiMonthlyPoint } from "../src/lib/corporate-events-engine";
import { isinPrefixForTicker, fetchFiiMonthlyRows } from "../src/lib/cvm-data";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

const month = (m: string, cotas: number | null, amort: number | null = null): FiiMonthlyPoint =>
  ({ dataReferencia: m, cotasEmitidas: cotas, amortizacaoFracao: amort });

// ── Desdobramento: o caso real do DVFF11 ────────────────────────────────────
// Cotas 1.100.950 → 11.009.500 em nov/2023, com PL parado — desdobramento 1:10.
{
  const series = [
    month("2023-09-01", 1_100_950),
    month("2023-10-01", 1_100_950),
    month("2023-11-01", 11_009_500),
    month("2023-12-01", 11_009_500),
  ];
  const before = detectCorporateEvents(series, "2023-01-15");
  check("desdobramento 1:10 detectado (compra anterior)",
    before.length === 1 && before[0].type === "desdobramento" && before[0].ratio === 10 && before[0].date === "2023-11-01",
    JSON.stringify(before));

  const after = detectCorporateEvents(series, "2024-06-01");
  check("compra posterior ao evento -> nenhum aviso", after.length === 0, JSON.stringify(after));

  const unknown = detectCorporateEvents(series, null);
  check("sem data de compra -> avisa marcando a incerteza",
    unknown.length === 1 && unknown[0].purchaseDateUnknown === true, JSON.stringify(unknown));
}

// ── Grupamento: a razão inversa, sentido oposto ─────────────────────────────
{
  const series = [month("2025-01-01", 50_000_000), month("2025-02-01", 5_000_000)];
  const ev = detectCorporateEvents(series, "2024-01-01");
  check("grupamento 10:1 detectado",
    ev.length === 1 && ev[0].type === "grupamento" && ev[0].ratio === 10, JSON.stringify(ev));
}

// ── Emissão nova NÃO é evento ───────────────────────────────────────────────
// A variação mais comum de todas (64% dos FIIs, 6.049 ocorrências em 2022-2026) e a que
// não mexe no preço médio de quem não subscreveu. Se isto quebrar, o aviso vira ruído.
{
  const series = [
    month("2025-01-01", 1_000_000),
    month("2025-02-01", 1_340_000), // +34%, emissão
    month("2025-03-01", 1_620_000), // +21%, outra
  ];
  const ev = detectCorporateEvents(series, "2024-01-01");
  check("emissão gradual não vira evento", ev.length === 0, JSON.stringify(ev));
}

// ── Lixo do arquivo não vira evento ─────────────────────────────────────────
// Existe fundo com razão de ×262.600 entre dois meses no arquivo real.
{
  const series = [month("2024-03-01", 1_000), month("2024-04-01", 262_600_000)];
  const ev = detectCorporateEvents(series, "2020-01-01");
  check("razão absurda ignorada (erro de preenchimento)", ev.length === 0, JSON.stringify(ev));
}

// ── Amortização: limiar de 1% acumulado ─────────────────────────────────────
{
  const baixo = [
    month("2025-01-01", 1_000_000, 0.0018),
    month("2025-02-01", 1_000_000, 0.0018),
  ];
  check("amortização abaixo de 1% acumulado não avisa",
    detectCorporateEvents(baixo, "2024-01-01").length === 0,
    JSON.stringify(detectCorporateEvents(baixo, "2024-01-01")));

  const alto = Array.from({ length: 8 }, (_, i) =>
    month(`2025-0${i + 1}-01`, 1_000_000, 0.0018));
  const ev = detectCorporateEvents(alto, "2024-01-01");
  check("amortização acumulada acima de 1% avisa",
    ev.length === 1 && ev[0].type === "amortizacao" && (ev[0].accumulatedFraction ?? 0) >= 0.01,
    JSON.stringify(ev));

  // Só conta o que veio DEPOIS da compra — meses anteriores são problema de outro dono.
  const parcial = detectCorporateEvents(alto, "2025-06-01");
  check("amortização anterior à compra não entra na soma", parcial.length === 0, JSON.stringify(parcial));
}

// ── Escala dos campos da CVM: fração, não percentual ────────────────────────
// Regressão contra o erro de fator 100. O campo se chama "Percentual_" mas é fração:
// DY de 0,0074884 vezes VP/cota de 8,6801 dá R$ 0,0650, exatamente o rendimento que o
// DVFF11 pagou naquele mês. Se alguém "corrigir" dividindo por 100, o limiar de
// amortização vira inalcançável e o detector silencia sem avisar ninguém.
{
  const produto = 0.0074884 * 8.6801;
  check("campo Percentual_ da CVM é fração (0,0074884 × 8,6801 = R$ 0,0650)",
    Math.abs(produto - 0.065) < 0.0001, `obtido R$ ${produto.toFixed(6)}`);
}

// ── Ticker → prefixo de ISIN ────────────────────────────────────────────────
{
  check("DVFF11 -> BRDVFFCTF", isinPrefixForTicker("DVFF11") === "BRDVFFCTF", String(isinPrefixForTicker("DVFF11")));
  check("HGLG11 -> BRHGLGCTF", isinPrefixForTicker("HGLG11") === "BRHGLGCTF", String(isinPrefixForTicker("HGLG11")));
  check("ticker curto demais -> null", isinPrefixForTicker("XP11") === null, String(isinPrefixForTicker("XP11")));
}

// ── Checagem ao vivo contra o arquivo real da CVM ───────────────────────────
if (process.env.SKIP_LIVE_CHECKS !== "1") {
  console.log("\n--- ao vivo: informe mensal de FII da CVM ---");
  const rows = await fetchFiiMonthlyRows(2023);
  check("2023 tem linhas", rows.length > 1000, `${rows.length} linhas`);

  // O ano de 2023 usa a coluna CNPJ_Fundo_Classe; 2022 e anteriores usam CNPJ_Fundo.
  // Ler só o nome novo fazia o backfill devolver zero linha em silêncio.
  const antigo = await fetchFiiMonthlyRows(2020);
  check("2020 também tem linhas (coluna CNPJ_Fundo, nome antigo)", antigo.length > 1000, `${antigo.length} linhas`);

  const dvff = rows.filter((r) => r.cnpj === "39863059000149").sort((a, b) => a.dataReferencia.localeCompare(b.dataReferencia));
  check("DVFF11 encontrado em 2023", dvff.length > 0, `${dvff.length} meses`);

  if (dvff.length > 0) {
    const ev = detectCorporateEvents(
      dvff.map((r) => ({ dataReferencia: r.dataReferencia, cotasEmitidas: r.cotasEmitidas, amortizacaoFracao: r.amortizacaoFracao })),
      "2023-01-01",
    );
    check("desdobramento real do DVFF11 detectado no dado ao vivo",
      ev.some((e) => e.type === "desdobramento" && e.ratio === 10 && e.date === "2023-11-01"),
      JSON.stringify(ev));

    // O ISIN é preenchido de forma inconsistente: em 2023 o DVFF11 vem com o campo
    // vazio, em 2026 vem BRDVFFCTF006. Por isso a resolução ticker → CNPJ varre a
    // tabela inteira em vez de olhar só o ano mais recente da compra — basta UM mês,
    // de qualquer ano, trazer o ISIN pra que toda a série do fundo fique alcançável.
    const anoCorrente = await fetchFiiMonthlyRows(new Date().getUTCFullYear());
    const comIsin = anoCorrente.filter((r) => r.cnpj === "39863059000149" && r.isin);
    check("ISIN do DVFF11 casa com o prefixo derivado do ticker (ano corrente)",
      comIsin.some((r) => r.isin!.startsWith(isinPrefixForTicker("DVFF11")!)),
      String(comIsin[0]?.isin));

    check("ISIN vazio em 2023 não impede a resolução (por isso varremos todos os anos)",
      dvff.every((r) => r.isin === null) && comIsin.length > 0,
      `2023 com ISIN: ${dvff.filter((r) => r.isin).length}, ano corrente com ISIN: ${comIsin.length}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} caso(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os casos passaram.");
