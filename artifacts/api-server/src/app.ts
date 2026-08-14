import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler } from "./middlewares/error-handler";

const app: Express = express();

// Railway (and the Vercel rewrite in front of it) terminate TLS before the request
// reaches this process — without trusting the proxy, req.secure is always false, so
// express-session silently refuses to set the "secure" cookie at all (not just the
// attribute), and login never persists. This tells Express to honor X-Forwarded-Proto.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

/**
 * Origens permitidas para requisição COM credenciais, via CORS_ORIGINS (separadas
 * por vírgula). Vazio por padrão, e isso é deliberado: o frontend nunca faz uma
 * chamada cross-origin. Em produção o Vercel reescreve /api/* para o Railway do lado
 * do servidor (ver vercel.json), e em desenvolvimento o Vite faz proxy de /api para
 * localhost:8080 — nos dois casos o navegador enxerga tudo como mesma origem.
 *
 * Antes era `origin: true`, que reflete de volta QUALQUER Origin recebida e, somado a
 * `credentials: true`, autoriza qualquer site a fazer chamadas autenticadas contra
 * esta API usando o cookie da vítima. Não havia caso de uso legítimo para isso — o
 * que impedia o abuso era o SameSite padrão do navegador, proteção acidental e não
 * uma decisão nossa. O backend do Railway é acessível diretamente.
 */
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set");
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

// Sessões no Postgres que já existe, não no MemoryStore padrão do express-session.
// O MemoryStore guarda tudo no processo: cada restart do Railway (ou seja, cada
// deploy) derrubava todas as sessões e deslogava quem estava usando, e as sessões
// expiradas nunca eram coletadas — o próprio express-session avisa que ele não serve
// para produção. A tabela `session` é declarada no schema do drizzle como qualquer
// outra — ver lib/db/src/schema/session.ts.
const PgSession = connectPgSimple(session);

app.use(
  session({
    store: new PgSession({
      conString: DATABASE_URL,
      // false de propósito: a tabela é declarada em lib/db/src/schema/session.ts e
      // criada pela migração, porque a criação automática depende de um table.sql
      // que não sobrevive ao bundle do esbuild — ver o comentário naquele arquivo.
      createTableIfMissing: false,
      // Limpeza de sessões expiradas, que o MemoryStore nunca fazia.
      pruneSessionInterval: 60 * 60, // segundos
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      // Explícito em vez de depender do padrão do navegador, que já variou entre
      // versões. Lax basta porque o frontend é sempre same-origin.
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  }),
);

app.use("/api", router);

// Depois das rotas, sempre: o Express só reconhece um handler de erro se ele for
// registrado por último, e com os quatro parâmetros.
app.use(errorHandler);

export default app;
