import { getNewsFor } from "../src/lib/news";

const headlines = await getNewsFor("MXRF11", 3);
console.log(`${headlines.length} manchetes reais encontradas\n`);
for (const h of headlines) {
  console.log("TITLE:", h.title);
  console.log("LINK:", h.link);
  console.log("SUMMARY:", h.summary);
  console.log("IMPACT:", h.impact);
  console.log("---");
}

let failures = 0;
for (const h of headlines) {
  if (!h.link.startsWith("https://www.infomoney.com.br/")) {
    console.log("FALHA: link não é do InfoMoney:", h.link);
    failures++;
  }
  if (h.summary != null && h.summary.toLowerCase().includes("appeared first on")) {
    console.log("FALHA: rodapé do WordPress não foi limpo:", h.summary);
    failures++;
  }
  if (h.summary != null && /<[^>]+>/.test(h.summary)) {
    console.log("FALHA: HTML não foi removido do resumo:", h.summary);
    failures++;
  }
}
console.log(failures === 0 ? "\nTodos os casos passaram." : `\n${failures} caso(s) falharam.`);
process.exit(failures === 0 ? 0 : 1);
