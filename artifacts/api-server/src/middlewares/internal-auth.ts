import { type Request, type Response, type NextFunction } from "express";

// Autenticação server-to-server simples por secret compartilhado — não existe
// nenhum mecanismo de admin/API-key no projeto ainda, e isso não precisa de mais
// que isso: só usado pra disparar manualmente (via curl) a regeneração de
// oportunidades sem esperar os 2 dias do scheduler, nunca exposto ao frontend.
export function requireInternalToken(req: Request, res: Response, next: NextFunction): void {
  const token = process.env.INTERNAL_JOB_TOKEN;
  if (!token) {
    res.status(503).json({ error: "INTERNAL_JOB_TOKEN não configurado" });
    return;
  }
  if (req.header("authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "Not authorized" });
    return;
  }
  next();
}
