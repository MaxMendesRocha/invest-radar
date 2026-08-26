import type { DuPontBreakdown } from "@workspace/api-client-react";

/**
 * De onde vem o ROE — a decomposição de cinco fatores, com a identidade à vista.
 *
 * ## Por que a identidade aparece
 *
 * Os cinco números multiplicados DÃO o ROE. Mostrar o produto na tela é o que impede o
 * card de afirmar duas coisas incompatíveis: se a conta não fechasse, estaria escrito ali.
 * Foi por isso que a decomposição vinda da série da CVM, construída antes desta, foi
 * descartada — ela fecharia num valor levemente diferente do ROE que o provedor calcula,
 * e os dois números apareceriam no mesmo card discordando. A decomposição tem de vir da
 * mesma fonte que o ROE que ela decompõe.
 *
 * ## Por que os fatores não são ordenados
 *
 * Não há "alavanca dominante" aqui, e a ausência é resultado de medição, não omissão. A
 * primeira versão elegia a dominante comparando os logaritmos dos fatores — como o ROE é
 * o produto deles, no log é a soma. O harness derrubou no primeiro caso não-banco: margem
 * é sempre fração e giro quase sempre também, enquanto alavancagem é sempre maior que 1,
 * então ela ganhava SEMPRE. O card mostra os cinco e a identidade, sem ranqueá-los.
 */

/**
 * Cada fator vira o par (número exibido, valor exibido) — e a identidade multiplica o
 * VALOR EXIBIDO, não o de precisão cheia.
 *
 * Medido no primeiro desenho, com um caso de banco: os fatores impressos davam 18,9% e a
 * linha afirmava 19,2%, porque o produto usava o giro sem arredondar. Quem conferisse a
 * conta na tela encontraria um erro — e a identidade existe justamente para poder ser
 * conferida. Ela fecha sobre o que está escrito; o preço disso é um arredondamento de
 * décimo no resultado, e é bem menor do que o de uma equação que não bate.
 *
 * Três casas abaixo de 0,2 porque é onde vive o giro do ativo de banco (0,05 a 0,15): a
 * duas casas, 0,132 vira 0,13, e num ROE de 19% isso é um terço de ponto percentual —
 * precisão real perdida no fator mais informativo da decomposição. Carga fiscal e peso do
 * juro ficam acima do corte e continuam com duas, que é o que se lê sem esforço.
 */
function exibido(v: number): { texto: string; valor: number } {
  const casas = Math.abs(v) < 0.2 ? 3 : 2;
  const valor = Number(v.toFixed(casas));
  const texto = valor.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
  return { texto, valor };
}

function exibidoPct(v: number): { texto: string; valor: number } {
  const percentual = Number((v * 100).toFixed(1));
  return {
    texto: `${percentual.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`,
    valor: percentual / 100,
  };
}

export function DuPontCard({ duPont }: { duPont: DuPontBreakdown }) {
  if (!duPont) return null;

  const carga = exibido(duPont.taxBurden);
  const juro = exibido(duPont.interestBurden);
  const margem = exibidoPct(duPont.ebitMargin);
  const giro = exibido(duPont.assetTurnover);
  const alavanca = exibido(duPont.leverage);

  const roe = carga.valor * juro.valor * margem.valor * giro.valor * alavanca.valor;

  const fatores = [
    { rot: "Carga fiscal", val: `${carga.texto}×`, sub: "lucro ÷ LAIR" },
    { rot: "Peso do juro", val: `${juro.texto}×`, sub: "LAIR ÷ EBIT" },
    { rot: "Margem EBIT", val: margem.texto, sub: "EBIT ÷ receita" },
    { rot: "Giro", val: `${giro.texto}×`, sub: "receita ÷ ativo" },
    { rot: "Alavancagem", val: `${alavanca.texto}×`, sub: "ativo ÷ PL" },
  ];

  return (
    // Bloco dentro do card do parecer, com a mesma moldura da triagem e do preço-alvo —
    // não um Card aninhado noutro Card.
    <section className="mt-6 space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">De onde vem o ROE</h4>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          decomposição de 5 fatores
        </span>
      </div>

      {/* Três por linha (duas fileiras, 3 + 2) e cinco numa linha só a partir de lg — a
          ordem é a da identidade, e ela se lê da esquerda para a direita nos dois casos.
          O corte é lg e não sm porque a barra lateral aparece em md e come 256px: medido
          em 768px, cinco colunas davam ~66px por bloco e "ALAVANCAGEM" transbordava.

          O rótulo tem altura mínima para que os valores fiquem na mesma linha de base
          quando um deles quebra em duas linhas — desalinhados, cinco fatores parecem
          cinco coisas diferentes em vez dos termos de um produto. */}
      <div className="grid grid-cols-3 gap-2 lg:grid-cols-5">
        {fatores.map((f) => (
          <div key={f.rot} className="rounded-md bg-muted/50 p-2 text-center">
            <p className="flex min-h-[2.6em] items-center justify-center font-mono text-[10px] uppercase leading-tight tracking-wider text-muted-foreground">
              {f.rot}
            </p>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{f.val}</p>
            <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{f.sub}</p>
          </div>
        ))}
      </div>

      {/* Sem o sufixo "×" dos fatores aqui: ao lado do sinal de multiplicação ele vira
          "0,66× × 0,85×", que se lê pior e, medido em 430px, empurrava o resultado da
          identidade para fora da tela — justamente a parte que a linha existe para
          mostrar. */}
      <div className="rounded bg-muted/50 px-2.5 py-2">
        <p className="text-center font-mono text-xs tabular-nums text-pretty">
          {carga.texto} × {juro.texto} × {margem.texto} × {giro.texto} × {alavanca.texto} ={" "}
          <strong>{exibidoPct(roe).texto}</strong>
        </p>
      </div>

      <p className="text-[11px] text-muted-foreground text-pretty">
        Os cinco fatores multiplicados dão o ROE, e vêm todos da mesma fonte — a identidade fica à
        vista justamente para que dois números do app não possam discordar sobre a mesma empresa. Um
        ROE alto sustentado por alavancagem e um sustentado por margem são situações diferentes; a
        decomposição mostra qual é qual sem afirmar qual é melhor.
      </p>
    </section>
  );
}
