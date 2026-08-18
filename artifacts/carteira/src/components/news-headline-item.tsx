import { useState } from "react";
import type { NewsItem } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ExternalLink, Newspaper } from "lucide-react";

const IMPACT_BADGE_CLASS: Record<string, string> = {
  "Muito Positivo": "border-emerald-600/60 text-emerald-700 dark:text-emerald-500",
  "Positivo": "border-emerald-600/60 text-emerald-700 dark:text-emerald-500",
  "Neutro": "text-muted-foreground",
  "Negativo": "border-destructive/60 text-destructive",
  "Muito Negativo": "border-destructive/60 text-destructive",
};

/**
 * Manchete clicável — abre um modal com o resumo real (RSS do InfoMoney, não raspagem
 * de página) e um link pra matéria completa. Antes disso a manchete era só texto
 * plano: o link real já vinha da API e ficava sem uso, sem jeito nenhum de agir sobre
 * uma notícia além de ler o título.
 */
export function NewsHeadlineItem({ item, className }: { item: NewsItem; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <li className={className}>
        <button
          type="button"
          onClick={(e) => {
            // stopPropagation: em Análise de Ativos o card inteiro é clicável (expande
            // ao clicar) — sem isso, clicar numa manchete também expandia/recolhia o
            // card por baixo do modal.
            e.stopPropagation();
            setOpen(true);
          }}
          className="text-left hover:underline underline-offset-2 decoration-dotted"
        >
          - {item.impact ? `[${item.impact}] ` : ""}
          {item.title}
        </button>
      </li>
      <Dialog open={open} onOpenChange={setOpen}>
        {/* stopPropagation aqui também: React re-emite eventos de dentro do portal
            pela árvore de componentes (não a de DOM), então um clique no link "Ler no
            InfoMoney" borbulharia pro onClick do card por trás sem isso. */}
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <div className="flex items-center gap-2 flex-wrap">
              <Newspaper className="w-4 h-4 text-muted-foreground shrink-0" />
              {item.impact && (
                <Badge variant="outline" className={IMPACT_BADGE_CLASS[item.impact] ?? ""}>
                  {item.impact}
                </Badge>
              )}
            </div>
            <DialogTitle className="text-pretty text-left">{item.title}</DialogTitle>
          </DialogHeader>
          <DialogDescription className="text-sm text-foreground text-pretty text-justify hyphens-auto leading-relaxed">
            {item.summary ?? "Resumo não disponível para esta notícia — confira a matéria completa."}
          </DialogDescription>
          <DialogFooter>
            {item.link && (
              <Button asChild>
                <a href={item.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2">
                  Ler no InfoMoney <ExternalLink className="w-4 h-4" />
                </a>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
