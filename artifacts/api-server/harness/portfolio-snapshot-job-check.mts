import { db, assetsTable, portfolioSnapshotsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { recordDailySnapshots } from "../src/lib/portfolio-snapshot-job";
import { todayInAppTimezone } from "../src/lib/local-date";

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  console.log(`${condition ? "OK  " : "FALHA"} ${label}`);
  if (!condition) {
    console.log(`      ${detail}`);
    failures++;
  }
}

// Integração de propósito: o job é todo E/S (banco + cotação), não há parte pura pra
// isolar. É seguro rodar — grava exatamente o que gravaria na janela diária, e a chave
// (usuário, dia) faz de cada execução um upsert.
const hoje = todayInAppTimezone();

const assets = await db.select().from(assetsTable);
const comPosicao = new Set(assets.map((a) => a.userId));
console.log(`base: ${assets.length} posições, ${comPosicao.size} usuário(s) com carteira`);

const primeira = await recordDailySnapshots();
console.log(`1ª execução: ${primeira.summary}`);

const linhasDeHoje = async () =>
  db.select().from(portfolioSnapshotsTable).where(eq(portfolioSnapshotsTable.date, hoje));

const depois1 = await linhasDeHoje();
check("todo usuário com carteira tem snapshot de hoje",
  [...comPosicao].every((id) => depois1.some((r) => r.userId === id)),
  `com carteira: ${[...comPosicao].join(",")} | com snapshot: ${depois1.map((r) => r.userId).join(",")}`);

// Usuário sem posição não vira linha: um snapshot de patrimônio zero quebraria a cadeia
// de TWR (custo não-positivo é fronteira) e encheria a tabela de gente que nunca
// cadastrou nada.
check("usuário sem carteira não ganha snapshot",
  depois1.every((r) => comPosicao.has(r.userId)),
  `linhas de hoje: ${depois1.map((r) => r.userId).join(",")}`);

check("patrimônio gravado é positivo onde há posição",
  depois1.every((r) => parseFloat(r.totalValue) > 0),
  JSON.stringify(depois1.map((r) => ({ u: r.userId, v: r.totalValue }))));

// ── Idempotência ────────────────────────────────────────────────────────────
// O scheduler roda uma vez ao dia, mas o gatilho manual ignora o intervalo, e
// /portfolio/summary grava no mesmo dia quando a pessoa abre o app. As três escritas
// precisam convergir para UMA linha por dia, senão a série diária ganha pontos duplicados
// e o TWR encadeia o mesmo dia duas vezes.
const segunda = await recordDailySnapshots();
console.log(`2ª execução: ${segunda.summary}`);
const depois2 = await linhasDeHoje();
check("rodar duas vezes no mesmo dia não duplica linha",
  depois2.length === depois1.length,
  `antes ${depois1.length}, depois ${depois2.length}`);

// ── Uma linha por usuário por dia ───────────────────────────────────────────
// A restrição unique (userId, date) deveria garantir isso, mas o teste protege contra
// alguém trocar o onConflictDoUpdate por um insert simples no futuro.
const duplicados: string[] = [];
for (const userId of comPosicao) {
  const doDia = await db.select().from(portfolioSnapshotsTable)
    .where(and(eq(portfolioSnapshotsTable.userId, userId), eq(portfolioSnapshotsTable.date, hoje)));
  if (doDia.length !== 1) duplicados.push(`usuário ${userId}: ${doDia.length} linhas`);
}
check("cada usuário com carteira tem exatamente 1 snapshot hoje",
  duplicados.length === 0, duplicados.join(" | "));

if (failures > 0) {
  console.log(`\n${failures} caso(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os casos passaram.");
process.exit(0);
