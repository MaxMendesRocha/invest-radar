import { promisify } from "node:util";
import type { Request } from "express";

/**
 * Emite um ID de sessão novo ANTES de autenticar, mantendo o cookie do cliente.
 *
 * Sem isto, login e registro só escreviam `req.session.userId` em cima da sessão
 * que já existia — e essa sessão pode ter sido fixada por um atacante antes da
 * autenticação (mandar a vítima abrir um link com um ID de sessão conhecido, ou
 * capturar o cookie por outro meio). Se o ID não muda ao autenticar, o mesmo ID
 * vira uma sessão autenticada, e quem o conhecia de antes está dentro.
 *
 * `regenerate()` do express-session reatribui `req.session` para um objeto NOVO
 * dentro do callback — por isso quem chama esta função precisa ler `req.session`
 * de novo DEPOIS do await, nunca guardar a referência de antes.
 */
export async function regenerateSession(req: Request): Promise<void> {
  await promisify(req.session.regenerate.bind(req.session))();
}
