import type { PriceZoneVerdict, StockPriceZones, PriceZone } from "@workspace/api-client-react";
import { formatCurrency } from "@/lib/utils";

/**
 * As duas leituras de faixa de entrada: a conclusão na lista, a conta no detalhe.
 *
 * As duas telas leem o MESMO campo do servidor (`priceZoneVerdict`) para decidir "abaixo",
 * "dentro" ou "acima". A comparação `preço × faixa` não é refeita aqui — se fosse, um
 * `<=` desalinhado bastaria para a lista dizer uma coisa e o detalhe outra sobre o mesmo
 * preço. Este arquivo só desenha.
 */

type Reading = "abaixo" | "dentro" | "acima";

const READING_FULL: Record<Reading, string> = {
  abaixo: "abaixo da faixa",
  dentro: "dentro da faixa",
  acima: "acima da faixa",
};

const BASIS_LABEL: Record<"lucro" | "patrimonio", string> = {
  lucro: "por lucro",
  patrimonio: "por patrimônio",
};

// Azul para "abaixo" e não verde: barato é uma descrição do preço, não um aval de compra.
// O verde do app já significa "atende ao corte" no selo de triagem, e repetir o mesmo
// verde aqui faria a régua parecer um segundo veredito de compra, que ela não é.
const READING_STYLE: Record<Reading, string> = {
  abaixo: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  dentro: "bg-green-600/10 text-green-700 dark:text-green-500",
  acima: "bg-amber-500/10 text-amber-700 dark:text-amber-500",
};

function Pastilha({ reading }: { reading: Reading }) {
  return (
    <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${READING_STYLE[reading]}`}>
      {READING_FULL[reading]}
    </span>
  );
}

/**
 * A linha única da lista de Oportunidades.
 *
 * Encabeça pela leitura que o servidor marcou como `lead` — a de patrimônio sempre que
 * ela existe, por ser a mais estável das duas (0,20 de volatilidade mediana contra 0,70
 * do lucro). A outra vai como ressalva na mesma linha, porque esconder a discordância
 * transformaria duas medições numa conclusão que nenhuma delas sozinha sustenta.
 */
export function PriceZoneVerdictLine({ verdict }: { verdict: PriceZoneVerdict }) {
  if (!verdict) return null;

  const leadReading = (verdict.lead === "patrimonio" ? verdict.book : verdict.earnings) as Reading | null;
  if (!leadReading) return null;

  const otherBasis = verdict.lead === "patrimonio" ? "lucro" : "patrimonio";
  const otherReading = (verdict.lead === "patrimonio" ? verdict.earnings : verdict.book) as Reading | null;

  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-xs">
      <Pastilha reading={leadReading} />
      <span className="text-muted-foreground">
        {BASIS_LABEL[verdict.lead]}
        {otherReading && ` · ${otherReading}, ${BASIS_LABEL[otherBasis]}`}
      </span>
    </div>
  );
}

/** Onde a barra desenha um valor, na escala compartilhada pelas duas leituras. */
function scaleFor(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || max || 1;
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;
  return (v: number) => ((v - lo) / (hi - lo)) * 100;
}

function Leitura({
  nome,
  zone,
  reading,
  price,
  pct,
}: {
  nome: string;
  zone: PriceZone;
  reading: Reading | null;
  price: number;
  pct: (v: number) => number;
}) {
  if (!zone) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 text-xs">
        <span className="text-muted-foreground">{nome}</span>
        <span className="font-mono tabular-nums">
          {formatCurrency(zone.low)} – {formatCurrency(zone.fair)}
        </span>
      </div>
      <div className="relative h-6 rounded bg-muted">
        <div
          className="absolute inset-y-0 rounded-sm border-x-2 border-green-600 bg-green-600/15"
          style={{ left: `${pct(zone.low)}%`, right: `${100 - pct(zone.fair)}%` }}
        />
        <div
          className="absolute -inset-y-0.5 w-0.5 bg-foreground"
          style={{ left: `${pct(price)}%` }}
          aria-hidden
        />
      </div>
      {reading && (
        <div className="flex flex-wrap items-baseline gap-1.5">
          <Pastilha reading={reading} />
        </div>
      )}
    </div>
  );
}

/**
 * A régua do detalhe: as duas leituras desenhadas, na MESMA escala de preço.
 *
 * A escala compartilhada é o ponto. Com um eixo por barra, o marcador da cotação cairia
 * em posições diferentes nas duas e a discordância — o caso que realmente importa —
 * viraria um artefato do desenho. Aqui o marcador fica no mesmo x nas duas barras, e o
 * que se move é a faixa verde.
 */
export function PriceZoneRuler({
  zones,
  verdict,
  price,
}: {
  zones: StockPriceZones;
  verdict: PriceZoneVerdict;
  price: number;
}) {
  if (!zones || (!zones.earnings && !zones.book)) return null;

  const marcos = [price];
  if (zones.earnings) marcos.push(zones.earnings.low, zones.earnings.fair);
  if (zones.book) marcos.push(zones.book.low, zones.book.fair);
  const pct = scaleFor(marcos);

  const basis = zones.earningsBasis;

  return (
    // Bloco dentro do card do parecer, com a mesma moldura da triagem e do preço-alvo —
    // não um Card aninhado noutro Card.
    <section className="mt-6 space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">Onde o preço está</h4>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          múltiplos do setor
        </span>
      </div>

      {zones.earnings && (
        <Leitura
          nome="Por lucro normalizado"
          zone={zones.earnings}
          reading={verdict?.earnings as Reading | null}
          price={price}
          pct={pct}
        />
      )}
      {zones.book && (
        <Leitura
          nome="Por patrimônio"
          zone={zones.book}
          reading={verdict?.book as Reading | null}
          price={price}
          pct={pct}
        />
      )}

      <p className="text-[11px] text-muted-foreground text-pretty">
        Cada faixa vai do múltiplo das mais baratas do setor (primeiro quartil) ao da mediana. A marca
        vertical é a cotação de hoje, {formatCurrency(price)}, e está na mesma posição nas duas barras —
        o que muda entre elas é a faixa. Não é preço-alvo nem projeção: é o que o setor paga hoje por
        lucro e por patrimônio, aplicado a esta empresa.
      </p>

      {/* Quantos exercícios sustentam a leitura por lucro. Uma faixa de três anos com
          dois de prejuízo não vale o mesmo que uma de cinco lucrativos, e quem lê
          decide o peso — o motor não decide por ele. */}
      {zones.earnings && basis && (
        <p className="text-[11px] text-muted-foreground text-pretty">
          A leitura por lucro usa a mediana de {basis.years}{" "}
          {basis.years === 1 ? "exercício" : "exercícios"} da CVM, e não os últimos doze meses
          {basis.lossYears > 0
            ? ` — ${basis.lossYears === 1 ? "um deles foi de prejuízo" : `${basis.lossYears} deles foram de prejuízo`}.`
            : ", nenhum de prejuízo."}
        </p>
      )}

      {verdict?.disagree && (
        <p className="border-l-2 pl-2.5 text-xs text-muted-foreground text-pretty">
          As duas leituras discordam, e a diferença é a informação — não existe um número só. Elas
          medem coisas diferentes: uma pergunta o que o setor paga por lucro, a outra o que paga por
          patrimônio. Barata por uma e cara pela outra é uma descrição da empresa, não erro de conta.
        </p>
      )}
    </section>
  );
}
