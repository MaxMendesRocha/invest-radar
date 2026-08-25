import { Router, type IRouter } from "express";
import multer from "multer";
import { CommitBrokerImportBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { importRateLimiter } from "../middlewares/rate-limit";
import { readPdf, type ReadDocument } from "../lib/pdf-text";
import { parseBrokerNotes, parseCustodyStatement, type BrokerNote, type CustodyStatement } from "../lib/broker-note-parser";
import { buildImportPreview } from "../lib/broker-import-engine";
import { commitImport, importedNoteNumbers, ImportValidationError, type ConfirmedPosition } from "../lib/broker-import-commit";
import { isoDate, invalidTradeDate } from "../lib/local-date";

/**
 * Importação de nota de corretagem em PDF, em dois passos separados.
 *
 * **`/preview` lê e não escreve.** Recebe os arquivos e devolve o que entendeu; a única
 * consulta ao banco é de leitura, para dizer quais notas já entraram. **`/commit` é o
 * único que grava**, e só o que a pessoa confirmou.
 *
 * A separação é o recurso, não uma etapa dele. Um importador que grava direto obriga a
 * pessoa a descobrir o erro depois, dentro da carteira, misturado com o que estava certo —
 * e desfazer lançamento errado é bem mais difícil do que não criá-lo.
 *
 * ## Sem estado entre os dois passos
 *
 * O preview não é guardado em sessão nem em tabela temporária. Quem confirma manda de
 * volta o que foi conferido, e o `/commit` valida aquilo como validaria um cadastro
 * digitado — inclusive relendo quais notas já estão na carteira, porque entre ver a tela
 * e confirmar a pessoa pode ter importado em outra aba.
 *
 * Guardar o preview no servidor criaria um terceiro estado — nem rascunho nem carteira —
 * que precisa expirar, migrar de esquema e ser limpo, e cuja única função seria evitar um
 * POST de alguns quilobytes.
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

/**
 * Grava o que foi conferido. É o único ponto desta funcionalidade que escreve.
 *
 * O corpo vem da tela, não de um preview guardado no servidor — e por isso ele é validado
 * aqui como qualquer cadastro digitado seria: ticker dentro da convenção da B3, categoria
 * que não contradiz o sufixo, quantidade e preço positivos. Confiar no corpo porque "veio
 * do nosso próprio preview" transformaria a importação num caminho lateral para criar o
 * estado que a validação de cadastro existe para impedir.
 */
router.post("/portfolio/import/commit", requireAuth, async (req, res): Promise<void> => {
  const parsed = CommitBrokerImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // O zod coage `format: date` para Date, e String(Date) produz "Tue Aug 17 2026 00:00:00
  // GMT+0000", que o Postgres recusa numa coluna date — é o mesmo tropeço que já fez todo
  // registro de provento devolver 500. `isoDate` é quem converte, aqui como lá.
  //
  // A trava de data implausível é a mesma do cadastro manual, e vale igual: data no ano
  // 0001 ou no futuro entra pela importação com a mesma facilidade com que entrava
  // digitada, e a origem do dado não a torna mais confiável — um PDF de outra corretora
  // pode ter layout que desloca a coluna da data sem que nada mais quebre.
  const positions: ConfirmedPosition[] = [];
  for (const [i, pos] of parsed.data.positions.entries()) {
    for (const [j, t] of pos.trades.entries()) {
      // O valor CRU, antes da coerção do zod: "2026-02-31" vira 03/03 sem reclamar, e só
      // comparando com o texto original dá para ver que o dia não existia. Depois do
      // parse essa informação já foi embora.
      const cru = req.body?.positions?.[i]?.trades?.[j]?.tradeDate;
      const ruim = invalidTradeDate(cru, isoDate(t.tradeDate));
      if (ruim) {
        res.status(400).json({ error: `Nota ${t.noteNumber}: ${ruim}` });
        return;
      }
    }
    positions.push({
      ...pos,
      trades: pos.trades.map((t) => ({ ...t, tradeDate: isoDate(t.tradeDate) })),
    });
  }

  try {
    const result = await commitImport(req.session.userId!, positions);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ImportValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
