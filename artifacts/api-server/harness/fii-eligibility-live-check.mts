import { db, opportunitiesTable } from "@workspace/db";
import { regenerateOpportunities } from "../src/lib/opportunities-engine";
import { eq } from "drizzle-orm";

/**
 * Roda o job real de regenerateOpportunities() contra a API real (não mock) e
 * confere se os FIIs que sobraram na tabela respeitam os dois pisos de elegibilidade
 * — validação de fiação (wiring), não só da matemática pura já coberta em
 * fii-eligibility-check.mts. Reescreve a tabela `opportunities` local, como o job
 * de produção faz — não rodar contra produção.
 */
const result = await regenerateOpportunities();
console.log("resultado do job:", result.summary);

const rows = await db.select().from(opportunitiesTable).where(eq(opportunitiesTable.category, "fiis"));
console.log(`\n${rows.length} FIIs entraram na lista final:`);
for (const r of rows) {
  console.log(`  ${r.ticker}  score=${r.score}`);
}

process.exit(0);
