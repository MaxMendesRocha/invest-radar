import { useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Target } from "lucide-react";
import { formatCurrency, formatPercent } from "@/lib/utils";
import { usePriceTarget } from "@/hooks/use-price-target";

/**
 * Preço-alvo dentro de Minha Carteira, ao lado da cotação que ele contradiz ou confirma.
 *
 * Nasceu de um relato direto: "não encontrei onde cadastrar o preço-alvo". O controle
 * existia só no Parecer de Ativo, que exige buscar um ticker — defensável para quem
 * ainda não tem a posição, errado para quem já tem. Quem já comprou procura o ativo
 * onde ele está.
 *
 * O gatilho é uma linha e o formulário vive num diálogo, não embutido: a tabela do
 * desktop tem 9 colunas e o cartão do mobile já mostra cinco números. Um formulário
 * aberto no meio disso empurraria a linha inteira. Diálogo também é o idioma que esta
 * página já usa para editar e vender.
 */
export function PriceTargetControl({
  ticker,
  currentPrice,
  className = "",
  align = "left",
}: {
  ticker: string;
  currentPrice: number | null;
  className?: string;
  align?: "left" | "right";
}) {
  const [isOpen, setIsOpen] = useState(false);
  const { target, error, setError, save, remove, isSaving } = usePriceTarget(ticker, {
    onSaved: () => setIsOpen(false),
  });
  const [value, setValue] = useState("");
  const [source, setSource] = useState("");

  const open = () => {
    setValue(target ? String(target.targetPrice).replace(".", ",") : "");
    setSource(target?.source ?? "");
    setError(null);
    setIsOpen(true);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save(value, source);
  };

  const upside = target?.upsidePercent ?? null;
  const alignment = align === "right" ? "justify-end text-right" : "";

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={`flex flex-wrap items-baseline gap-x-1.5 text-xs hover:underline ${alignment} ${className}`}
        title={target ? `Editar preço-alvo de ${ticker}` : `Definir preço-alvo de ${ticker}`}
      >
        {target ? (
          <>
            <span className="text-muted-foreground">Alvo</span>
            <span className="font-mono text-foreground">{formatCurrency(target.targetPrice)}</span>
            {upside != null && (
              <span className={`font-mono font-medium ${upside >= 0 ? "text-green-600 dark:text-green-500" : "text-destructive"}`}>
                {/* formatPercent e não toFixed: o upside fica encostado no L&P, que é
                    pt-BR. "-74.7%" ao lado de "+64,15%" parece número de outro sistema. */}
                {upside >= 0 ? "+" : ""}{formatPercent(upside)}
              </span>
            )}
          </>
        ) : (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Target className="h-3 w-3" /> Definir alvo
          </span>
        )}
      </button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Preço-alvo de {ticker}</DialogTitle>
            <DialogDescription className="text-pretty">
              O número é seu — de uma casa de análise que você acompanha ou do seu próprio cálculo. O Radar não
              tem preço-alvo: nenhum provedor de dados aberto publica esse dado. O app só calcula o upside
              contra a cotação real.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor={`alvo-${ticker}`}>
                  Alvo (R$)
                </label>
                <Input id={`alvo-${ticker}`} inputMode="decimal" value={value} required
                  onChange={(e) => setValue(e.target.value)} placeholder="29,92" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor={`fonte-${ticker}`}>
                  Fonte (opcional)
                </label>
                <Input id={`fonte-${ticker}`} value={source} maxLength={80}
                  onChange={(e) => setSource(e.target.value)} placeholder="Eleven, meu cálculo…" />
              </div>
            </div>

            {currentPrice != null && (
              <p className="text-xs text-muted-foreground">
                Cotação atual: <span className="font-mono">{formatCurrency(currentPrice)}</span>
              </p>
            )}
            {error && <p className="text-xs text-destructive text-pretty">{error}</p>}

            <DialogFooter className="gap-2 sm:justify-start">
              <Button type="submit" size="sm" disabled={isSaving}>
                {isSaving ? "Salvando..." : "Salvar"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setIsOpen(false)}>
                Cancelar
              </Button>
              {target && (
                <Button type="button" size="sm" variant="ghost" className="text-destructive"
                  onClick={() => { remove.mutate({ ticker }); setIsOpen(false); }}>
                  Remover
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
