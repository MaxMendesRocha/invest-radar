export interface UniverseEntry {
  ticker: string;
  category: "acoes" | "fiis" | "etfs" | "bdrs";
  fallbackName: string; // só usado se getFundamentals() não trouxer o nome real
}

// Lista curada manualmente (brapi.dev não expõe "listar todos os tickers" em
// nenhum plano) — base são os 18 tickers de scripts/src/seed-opportunities.ts,
// mais ~30 tickers líquidos da B3 cobrindo setores que faltavam (bancos, varejo,
// saúde, papel&celulose, siderurgia, telecom, saneamento, seguros, energia
// elétrica, agro, construção, tecnologia). Cada ticker foi confirmado batendo
// direto na brapi.dev antes de entrar aqui — alguns tinham código diferente do
// esperado por mudança societária recente (ELET3→AXIA3 "AXIA Energia",
// EMBR3→EMBJ3, JBSS3→JBSS32 "JBS N.V." após redomiciliação), e dois candidatos
// (BCFF11, MRFG3) não existem mais na API e foram descartados em vez de
// adivinhados. Se um ticker aqui ficar inválido no futuro, regenerateOpportunities()
// simplesmente não encontra fundamentos pra ele e pula — nunca fabrica dado.
export const TICKER_UNIVERSE: UniverseEntry[] = [
  // Ações — já em seed-opportunities.ts
  { ticker: "EGIE3", category: "acoes", fallbackName: "Engie Brasil Energia" },
  { ticker: "WEGE3", category: "acoes", fallbackName: "WEG" },
  { ticker: "ABEV3", category: "acoes", fallbackName: "Ambev" },
  { ticker: "ITUB4", category: "acoes", fallbackName: "Itaú Unibanco" },
  { ticker: "BBDC4", category: "acoes", fallbackName: "Bradesco" },
  { ticker: "VALE3", category: "acoes", fallbackName: "Vale" },
  { ticker: "PETR4", category: "acoes", fallbackName: "Petrobras" },
  { ticker: "RENT3", category: "acoes", fallbackName: "Localiza" },
  { ticker: "MGLU3", category: "acoes", fallbackName: "Magazine Luiza" },
  // Ações — novas, confirmadas direto na brapi.dev
  { ticker: "BBAS3", category: "acoes", fallbackName: "Banco do Brasil" },
  { ticker: "SANB11", category: "acoes", fallbackName: "Santander Brasil" },
  { ticker: "LREN3", category: "acoes", fallbackName: "Renner" },
  { ticker: "HAPV3", category: "acoes", fallbackName: "Hapvida" },
  { ticker: "FLRY3", category: "acoes", fallbackName: "Fleury" },
  { ticker: "SUZB3", category: "acoes", fallbackName: "Suzano" },
  { ticker: "KLBN11", category: "acoes", fallbackName: "Klabin" },
  { ticker: "GGBR4", category: "acoes", fallbackName: "Gerdau" },
  { ticker: "CSNA3", category: "acoes", fallbackName: "CSN" },
  { ticker: "VIVT3", category: "acoes", fallbackName: "Telefônica Brasil" },
  { ticker: "TIMS3", category: "acoes", fallbackName: "TIM" },
  { ticker: "SBSP3", category: "acoes", fallbackName: "Sabesp" },
  { ticker: "BBSE3", category: "acoes", fallbackName: "BB Seguridade" },
  { ticker: "AXIA3", category: "acoes", fallbackName: "AXIA Energia (ex-Eletrobras)" },
  { ticker: "CMIG4", category: "acoes", fallbackName: "Cemig" },
  { ticker: "TAEE11", category: "acoes", fallbackName: "Taesa" },
  { ticker: "JBSS32", category: "acoes", fallbackName: "JBS N.V." },
  { ticker: "CYRE3", category: "acoes", fallbackName: "Cyrela" },
  { ticker: "MRVE3", category: "acoes", fallbackName: "MRV" },
  { ticker: "TOTS3", category: "acoes", fallbackName: "Totvs" },
  { ticker: "EMBJ3", category: "acoes", fallbackName: "Embraer" },
  { ticker: "B3SA3", category: "acoes", fallbackName: "B3" },
  // FIIs
  { ticker: "HGLG11", category: "fiis", fallbackName: "CSHG Logística" },
  { ticker: "KNRI11", category: "fiis", fallbackName: "Kinea Renda Imobiliária" },
  { ticker: "MXRF11", category: "fiis", fallbackName: "Maxi Renda" },
  { ticker: "XPML11", category: "fiis", fallbackName: "XP Malls" },
  { ticker: "BTLG11", category: "fiis", fallbackName: "BTG Pactual Logística" },
  { ticker: "VISC11", category: "fiis", fallbackName: "Vinci Shopping Centers" },
  { ticker: "KNCR11", category: "fiis", fallbackName: "Kinea Rendimentos Imobiliários" },
  { ticker: "HGRE11", category: "fiis", fallbackName: "CSHG Real Estate" },
  // ETFs
  { ticker: "BOVA11", category: "etfs", fallbackName: "iShares Ibovespa" },
  { ticker: "IVVB11", category: "etfs", fallbackName: "iShares S&P 500" },
  { ticker: "SMAL11", category: "etfs", fallbackName: "iShares Small Cap" },
  { ticker: "DIVO11", category: "etfs", fallbackName: "It Now IDIV" },
  // BDRs
  { ticker: "AAPL34", category: "bdrs", fallbackName: "Apple" },
  { ticker: "MSFT34", category: "bdrs", fallbackName: "Microsoft" },
  { ticker: "AMZO34", category: "bdrs", fallbackName: "Amazon" },
  { ticker: "GOGL34", category: "bdrs", fallbackName: "Alphabet (Google)" },
  { ticker: "NVDC34", category: "bdrs", fallbackName: "Nvidia" },
];
