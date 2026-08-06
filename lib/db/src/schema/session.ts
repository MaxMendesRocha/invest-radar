import { pgTable, varchar, json, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Tabela de sessões do connect-pg-simple (artifacts/api-server/src/app.ts).
 *
 * O formato é ditado por aquele pacote, não por nós — os nomes das colunas e os
 * tipos precisam bater exatamente com o que ele espera.
 *
 * Declarada aqui em vez de usar `createTableIfMissing: true` porque a opção
 * automática lê um `table.sql` empacotado junto do módulo, resolvido relativamente
 * ao arquivo em execução — e o api-server é bundleado pelo esbuild num único
 * dist/index.mjs, onde esse arquivo não existe. O resultado era silencioso na
 * superfície: o login respondia 200, mas a sessão nunca era gravada e a requisição
 * seguinte voltava 401.
 */
export const sessionTable = pgTable(
  "session",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
  },
  (table) => [index("IDX_session_expire").on(table.expire)],
);
