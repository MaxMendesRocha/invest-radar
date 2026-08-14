import type { ErrorRequestHandler, Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

/**
 * O que acontece quando um handler estoura.
 *
 * Sem isto, o Express usa o handler padrão: HTML com stack trace, sem `content-type`
 * JSON. O cliente tenta ler o corpo, não acha campo de erro nenhum e mostra a mensagem
 * genérica que ele mesmo escreveu — então uma falha de schema, uma queda do provedor de
 * cotação e um bug de código chegam à tela exatamente iguais. Foi o que aconteceu com o
 * preço-alvo: a tabela não existia em produção e a única informação disponível, aqui e
 * na tela, era "não foi possível salvar".
 *
 * A regra é: a causa vai inteira para o log, e para o cliente vai só o que ele pode
 * fazer alguma coisa a respeito. Stack trace e SQL não atravessam.
 */

/** Códigos SQLSTATE têm exatamente 5 caracteres alfanuméricos maiúsculos. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * O drizzle embrulha o erro do pg num DrizzleQueryError e põe o original em `cause`,
 * então o código não está na superfície. Descer a cadeia é o que encontra o 42P01.
 */
function sqlStateOf(err: unknown, depth = 0): string | null {
  if (depth > 5 || !err || typeof err !== "object") return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && SQLSTATE.test(code)) return code;
  return sqlStateOf((err as { cause?: unknown }).cause, depth + 1);
}

/** 42P01 = undefined_table. Em produção significa uma coisa só: migração não aplicada. */
const UNDEFINED_TABLE = "42P01";

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  // Resposta já começou a sair: mexer no status agora corromperia o corpo. O default
  // do Express derruba a conexão, que é o certo — o cliente vê a resposta truncada.
  if (res.headersSent) {
    next(err);
    return;
  }

  const sqlState = sqlStateOf(err);
  logger.error({ err, sqlState, method: req.method, url: req.originalUrl.split("?")[0] }, "unhandled error");

  if (sqlState === UNDEFINED_TABLE) {
    // 503 e não 500: o código está correto, o banco é que está atrás dele. Distinguir
    // importa porque a correção é um comando de migração, não um deploy.
    res.status(503).json({
      error:
        "Este recurso depende de uma tabela que ainda não existe no banco deste ambiente. " +
        "A migração do schema precisa ser aplicada.",
    });
    return;
  }

  res.status(500).json({ error: "Erro interno no servidor." });
};
