import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

// Autenticação server-to-server simples por secret compartilhado — não existe
// nenhum mecanismo de admin/API-key no projeto ainda, e isso não precisa de mais
// que isso: só usado pra disparar manualmente (via curl) a regeneração de
// oportunidades sem esperar a semana do scheduler, nunca exposto ao frontend.

/**
 * `!==` compara byte a byte com saída antecipada no primeiro que difere — o tempo de
 * resposta varia com QUANTOS bytes do começo o atacante já acertou, o que dá um canal
 * pra recuperar o segredo byte a byte por medição de tempo. `timingSafeEqual` sempre
 * compara todos os bytes.
 *
 * `timingSafeEqual` lança se os dois buffers tiverem tamanho diferente — por isso o
 * cheque de tamanho vem antes, e não pode ser um `return false` cego: precisamos
 * comparar buffers do mesmo tamanho para chegar até `timingSafeEqual`, então quando os
 * tamanhos diferem a resposta já É "não bate", só não dá pra chamar a função com eles.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.INTERNAL_JOB_TOKEN;
  if (!token) {
    res.status(503).json({ error: "INTERNAL_JOB_TOKEN não configurado" });
    return;
  }
  const provided = req.header("authorization") ?? "";
  if (!safeEqual(provided, `Bearer ${token}`)) {
    res.status(401).json({ error: "Not authorized" });
    return;
  }
  next();
}
