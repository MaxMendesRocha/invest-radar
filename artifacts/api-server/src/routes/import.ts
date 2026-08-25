import { Router, type IRouter } from "express";
import multer from "multer";
import { db, assetPurchasesTable, assetsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { importRateLimiter } from "../middlewares/rate-limit";
import { readPdf, type ReadDocument } from "../lib/pdf-text";
import { parseBrokerNotes, parseCustodyStatement, type BrokerNote, type CustodyStatement } from "../lib/broker-note-parser";
import { buildImportPreview } from "../lib/broker-import-engine";

/**
 * Importação de nota de corretagem em PDF — a leitura, nunca a gravação.
 *
 * Este endpoint é PURO: recebe arquivos, devolve o que entendeu e não escreve nada. A
 * separação é o recurso, não uma etapa dele. Um importador que grava direto obriga a
 * pessoa a descobrir o erro depois, dentro da carteira, misturado com o que estava certo
 * — e desfazer lançamento errado é bem mais difícil do que não criá-lo.
 *
 * A única consulta ao banco é de leitura, e serve para dizer quais notas já entraram.
 *
 * ## Sem estado entre a conferência e a gravação
 *
 * O preview não é guardado em sessão nem em tabela temporária. Quem confirma manda de
 * volta o que foi conferido, e a gravação valida aquilo como validaria um cadastro
 * digitado. Guardar o preview no servidor criaria um terceiro estado — nem rascunho nem
 * carteira — que precisa expirar, migrar de esquema e ser limpo, e cuja única função
 * seria evitar um POST de alguns quilobytes.
 */

const router: IRouter = Router();

/**
 * Arquivos em memória, não em disco.
 *
 * O container do Railway é efêmero e o texto do PDF já vai inteiro para a memória de
 * qualquer jeito na extração. Gravar em disco só acrescentaria arquivo temporário com
 * dado pessoal (CPF, endereço, conta) para limpar depois — e limpeza de arquivo temporário
 * é a coisa que falha quando o processo morre no meio.
 */
const MAX_ARQUIVO_BYTES = 8 * 1024 * 1024;
const MAX_ARQUIVOS = 12;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARQUIVO_BYTES, files: MAX_ARQUIVOS },
});

/** PDF de verdade começa com %PDF-. O nome e o content-type quem escolhe é o cliente. */
function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

export interface ImportDocumentSummary {
  fileName: string;
  kind: ReadDocument["kind"];
  /** O que foi extraído dele — operações, no caso da nota; posições, no do extrato. */
  itemCount: number;
}

/**
 * Lê os PDFs e devolve a conciliação para conferência. Não grava.
 *
 * Aceita os dois documentos de uma vez e descobre sozinho qual é qual — dois campos
 * rotulados só criariam a chance de trocá-los de lugar.
 */
router.post(
  "/portfolio/import/preview",
  requireAuth,
  importRateLimiter,
  upload.array("files", MAX_ARQUIVOS),
  async (req, res): Promise<void> => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "Envie ao menos um PDF de nota de corretagem." });
      return;
    }

    const documents: ImportDocumentSummary[] = [];
    const problems: string[] = [];
    const notes: BrokerNote[] = [];
    let custody: CustodyStatement | null = null;
    let custodyFile: string | null = null;

    for (const file of files) {
      if (!isPdf(file.buffer)) {
        problems.push(`"${file.originalname}" não é um PDF.`);
        continue;
      }

      let doc: ReadDocument;
      try {
        doc = await readPdf(file.originalname, new Uint8Array(file.buffer));
      } catch {
        // PDF protegido por senha ou corrompido. A mensagem não repete o motivo técnico
        // porque ele não ajuda quem está na tela — o que resolve é reexportar.
        problems.push(`Não foi possível ler "${file.originalname}". O arquivo pode estar protegido por senha.`);
        continue;
      }

      if (doc.kind === "nota_de_corretagem") {
        const lidas = parseBrokerNotes(doc.pages);
        notes.push(...lidas);
        documents.push({ fileName: doc.fileName, kind: doc.kind, itemCount: lidas.reduce((s, n) => s + n.trades.length, 0) });
        if (lidas.length === 0) {
          problems.push(`"${doc.fileName}" é uma nota de corretagem, mas nenhuma operação foi reconhecida nela.`);
        }
        continue;
      }

      if (doc.kind === "extrato_de_custodia") {
        const lido = parseCustodyStatement(doc.pages);
        documents.push({ fileName: doc.fileName, kind: doc.kind, itemCount: lido.positions.length });
        // Duas fotos de datas diferentes não se somam: a conferência por quantidade
        // compara o líquido das notas com UM saldo, e misturar dois saldos faria a
        // diferença não significar mais nada.
        if (custody) {
          problems.push(
            `Dois extratos de custódia enviados ("${custodyFile}" e "${doc.fileName}"). Envie apenas o mais recente — a conferência compara as notas com uma única foto do saldo.`,
          );
          continue;
        }
        custody = lido;
        custodyFile = doc.fileName;
        continue;
      }

      documents.push({ fileName: doc.fileName, kind: doc.kind, itemCount: 0 });
      problems.push(`"${doc.fileName}" não parece ser nota de corretagem nem extrato de custódia.`);
    }

    if (notes.length === 0) {
      // Quem mandou só o extrato fez metade do caminho, e dizer isso vale mais do que
      // repetir que faltou nota: o extrato não tem preço nem data, então ele sozinho não
      // vira lançamento nenhum por mais completo que pareça.
      res.status(422).json({
        error: custody
          ? "O extrato de custódia foi lido, mas falta a nota de corretagem — é ela que traz data, quantidade e preço de cada operação."
          : "Nenhuma nota de corretagem foi reconhecida nos arquivos enviados.",
        documents,
        problems,
      });
      return;
    }

    // Sem extrato não existe ticker em lugar nenhum, e o preview sai inteiro sem
    // correspondência. Dizer isso é melhor do que recusar: quem só tem a nota à mão
    // enxerga as operações lidas e entende exatamente o que falta.
    if (!custody) {
      problems.push(
        "Sem o extrato de custódia não dá para saber a qual ticker cada operação corresponde — a nota identifica o papel pelo nome, não pelo código.",
      );
    }

    const preview = buildImportPreview(notes, custody ?? { referenceDate: null, positions: [] });
    const alreadyImported = await importedNoteNumbers(req.session.userId!, preview.noteNumbers);

    res.json({
      ...preview,
      documents,
      problems,
      /**
       * Notas que já estão na carteira. A tela usa isto para vir com elas desmarcadas —
       * o arquivo da corretora traz o período inteiro, então reenviar o que já entrou é
       * o caminho normal, não engano.
       */
      alreadyImported,
    });
  },
);

/** Quais destes números de nota o usuário já importou. Só leitura. */
async function importedNoteNumbers(userId: number, noteNumbers: string[]): Promise<string[]> {
  if (noteNumbers.length === 0) return [];
  const rows = await db
    .selectDistinct({ noteNumber: assetPurchasesTable.brokerNoteNumber })
    .from(assetPurchasesTable)
    .innerJoin(assetsTable, eq(assetPurchasesTable.assetId, assetsTable.id))
    .where(
      and(
        eq(assetsTable.userId, userId),
        isNotNull(assetPurchasesTable.brokerNoteNumber),
        inArray(assetPurchasesTable.brokerNoteNumber, noteNumbers),
      ),
    );
  return rows.map((r) => r.noteNumber!).sort();
}

export default router;
