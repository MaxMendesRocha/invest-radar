import { extractText, getDocumentProxy } from "unpdf";

/**
 * Texto de um PDF, página a página, e a classificação de qual documento é qual.
 *
 * Fica separado dos parsers de propósito: extrair texto é I/O e depende de biblioteca;
 * ler nota de corretagem é regra de negócio e roda em cima de string. Misturar os dois
 * faria o harness dos parsers precisar de PDF de verdade para rodar, e aí ele deixaria
 * de rodar.
 *
 * ## Quem diz o que o arquivo é são os arquivos, não a tela
 *
 * A alternativa seria dois campos de upload rotulados. Ela erra num caso que acontece
 * toda hora — trocar os dois de lugar — e erra caro: os dois documentos vêm da mesma
 * corretora, no mesmo dia, com nome de arquivo parecido. Como cada um se identifica no
 * próprio cabeçalho, perguntar é desnecessário.
 *
 * A classificação é por marca literal do cabeçalho, não por heurística de conteúdo. Um
 * arquivo que não traz nenhuma das duas marcas volta como `desconhecido` em vez de ser
 * empurrado para o palpite mais provável: mandar um extrato de dividendos para o parser
 * de nota não daria erro, daria zero operações — e zero operações se parece com sucesso.
 */

export type DocumentKind = "nota_de_corretagem" | "extrato_de_custodia" | "desconhecido";

export interface ReadDocument {
  fileName: string;
  kind: DocumentKind;
  pages: string[];
}

/** Marcas do cabeçalho de cada documento. Literais porque é assim que eles se nomeiam. */
const MARCAS: { kind: Exclude<DocumentKind, "desconhecido">; pattern: RegExp }[] = [
  { kind: "nota_de_corretagem", pattern: /NOTA DE CORRETAGEM/i },
  { kind: "extrato_de_custodia", pattern: /Extrato de Cust[óo]dia/i },
];

/**
 * A marca é procurada em TODAS as páginas, não só na primeira: o extrato do Nubank
 * repete o cabeçalho em cada página, mas nada garante que o próximo formato não comece
 * por uma capa. E se as duas marcas aparecerem no mesmo arquivo, a resposta é
 * `desconhecido` — dois documentos colados num PDF só precisam de separação humana, e
 * escolher um dos dois faria o outro sumir sem aviso.
 */
export function classify(pages: string[]): DocumentKind {
  const inteiro = pages.join("\n");
  const achadas = MARCAS.filter((m) => m.pattern.test(inteiro));
  return achadas.length === 1 ? achadas[0].kind : "desconhecido";
}

/**
 * O PDF pode ser grande e o parser só lê texto — nada de imagem, fonte ou anexo.
 *
 * Não há OCR aqui: PDF de corretora é gerado, não escaneado. Um escaneado devolve zero
 * página com texto e cai em `desconhecido`, que é a resposta honesta — tentar adivinhar
 * caractere por caractere numa nota de corretagem trocaria 8 por 3 em quantidade.
 */
export async function readPdf(fileName: string, data: Uint8Array): Promise<ReadDocument> {
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];

  return { fileName, kind: classify(pages), pages };
}
