import rateLimit from "express-rate-limit";

/**
 * Limita tentativas de login e registro por IP.
 *
 * Sem isto, `/auth/login` aceitava tentativas ilimitadas — força bruta de senha
 * era só uma questão de script e tempo, sem nenhum atrito. `trust proxy` já está
 * configurado em app.ts (Vercel → Railway é um único salto), então `req.ip` aqui
 * reflete o IP real do cliente, não o do proxy — sem isso o limite acertaria
 * todo mundo igual (lido do proxy) ou seria trivial de burlar (lido errado).
 *
 * Por IP, não por e-mail: pegar o ataque mais comum (um script martelando o
 * endpoint) sem precisar normalizar e-mail nem manter estado por conta. Um
 * ataque distribuído por muitos IPs contra uma conta específica escapa disto —
 * é um limite conhecido, não coberto aqui.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Login bem-sucedido não conta pro limite: alguém que loga e desloga várias vezes
  // no dia (troca de dispositivo, sessão expirada) não deve ser punido. Só a
  // sequência de SENHAS ERRADAS conta, que é justamente o que se quer barrar.
  skipSuccessfulRequests: true,
  handler: (_req, res) => {
    res.status(429).json({ error: "Muitas tentativas de login. Tente novamente em alguns minutos." });
  },
});

// Mais apertado que login: criar conta é uma ação rara no uso normal, e o mesmo
// endpoint serve pra sondar quais e-mails já têm cadastro (o 409 "já está em
// uso" confirma existência) — o limite também reduz o valor dessa sondagem.
export const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Registro bem-sucedido (201) não conta; um 409 repetido (sondagem de e-mail já
  // cadastrado) conta — é exatamente o abuso que este limite existe para conter.
  skipSuccessfulRequests: true,
  handler: (_req, res) => {
    res.status(429).json({ error: "Muitas tentativas de registro. Tente novamente mais tarde." });
  },
});
