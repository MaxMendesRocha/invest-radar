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

/**
 * Em produção estes dois significam uma coisa só: migração não aplicada.
 *
 * 42703 (coluna inexistente) entrou junto com 42P01 (tabela inexistente) porque o modo
 * de falha é o mesmo e a correção também. Nem toda migração cria tabela — várias só
 * acrescentam coluna a uma que já existe, e nesse caso a tabela responde normalmente
 * até o primeiro SELECT que cita a coluna nova.
 */
const MIGRACAO_PENDENTE = new Set(["42P01", "42703"]);

/**
 * Erro do multer ao receber o upload. Identificado por nome e código, sem importar o
 * multer aqui — este middleware trata a requisição, não conhece as bibliotecas que a
 * produziram, e é o mesmo critério de pato já usado para o corpo malformado acima.
 */
const LIMITES_DE_UPLOAD: Record<string, string> = {
  LIMIT_FILE_SIZE: "Arquivo grande demais. Cada PDF precisa ter até 8 MB.",
  LIMIT_FILE_COUNT: "Arquivos demais em um envio. Envie até 12 por vez.",
  LIMIT_UNEXPECTED_FILE: "Campo de arquivo inesperado no envio.",
};

function uploadLimit(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { name?: unknown; code?: unknown };
  if (e.name !== "MulterError" || typeof e.code !== "string") return null;
  return LIMITES_DE_UPLOAD[e.code] ?? "Não foi possível receber os arquivos enviados.";
}

/**
 * Erro do express.json() ao ler o corpo. Ele marca o próprio erro com `status`/
 * `statusCode` 400 e `type: "entity.parse.failed"` — checar os dois campos cobre tanto
 * JSON inválido quanto corpo grande demais, sem depender do texto da mensagem.
 */
function isMalformedBody(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  return err instanceof SyntaxError && status === 400 ? true : e.type === "entity.parse.failed";
}

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

  // Corpo que não é JSON válido é erro de QUEM CHAMOU, e o express.json() já classifica
  // assim: lança um SyntaxError com `status: 400` embutido. Cair no 500 genérico dizia a
  // coisa errada duas vezes — para o cliente, que não tem o que corrigir num "erro
  // interno", e para o log, onde requisição malformada virava ruído indistinguível de
  // bug de código. Vale para qualquer corpo quebrado, não só para o caso que revelou
  // isto (um JSON escalar no lugar de um objeto).
  if (isMalformedBody(err)) {
    logger.warn({ method: req.method, url: req.originalUrl.split("?")[0] }, "corpo da requisição não é JSON válido");
    res.status(400).json({ error: "Corpo da requisição não é um JSON válido." });
    return;
  }

  // Limite de upload estourado é escolha de quem enviou, e a resposta precisa dizer qual
  // limite foi — "erro interno" num arquivo de 20 MB manda a pessoa tentar de novo
  // exatamente do mesmo jeito. 413 é o status que o navegador e o cliente já entendem.
  const limite = uploadLimit(err);
  if (limite) {
    logger.warn({ method: req.method, url: req.originalUrl.split("?")[0] }, "limite de upload excedido");
    res.status(413).json({ error: limite });
    return;
  }

  const sqlState = sqlStateOf(err);
  logger.error({ err, sqlState, method: req.method, url: req.originalUrl.split("?")[0] }, "unhandled error");

  if (sqlState && MIGRACAO_PENDENTE.has(sqlState)) {
    // 503 e não 500: o código está correto, o banco é que está atrás dele. Distinguir
    // importa porque a correção é um comando de migração, não um deploy.
    res.status(503).json({
      error:
        "Este recurso depende de uma tabela ou coluna que ainda não existe no banco deste " +
        "ambiente. A migração do schema precisa ser aplicada.",
    });
    return;
  }

  res.status(500).json({ error: "Erro interno no servidor." });
};
