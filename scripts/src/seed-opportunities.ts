import { db, pool, opportunitiesTable, type InsertOpportunity } from "@workspace/db";

// Curated shortlist — not live-fetched fundamentals, numbers are illustrative.
// Superseded in production by lib/opportunities-engine.ts's regenerateOpportunities()
// (real fundamentals, runs every week via lib/scheduler.ts). This script is now
// just a manual bootstrap — useful for a fresh DB or local dev without
// BRAPI_TOKEN/ANTHROPIC_API_KEY configured, so the Oportunidades screen has
// something to show before the real job ever runs.
const OPPORTUNITIES: InsertOpportunity[] = [
  {
    ticker: "EGIE3", name: "Engie Brasil Energia", category: "acoes",
    score: "88.00", potentialReturn: "12.00", dividendYield: "7.50", riskLevel: "Baixo",
    reason: "Geradora de energia com contratos de longo prazo e histórico consistente de dividendos.",
    positives: JSON.stringify(["Receita contratada e previsível", "Baixa alavancagem"]),
    risks: JSON.stringify(["Regulação do setor elétrico", "Exposição a hidrologia"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "WEGE3", name: "WEG", category: "acoes",
    score: "90.00", potentialReturn: "15.00", dividendYield: "1.80", riskLevel: "Baixo",
    reason: "Líder em motores elétricos e automação, crescimento consistente e margens elevadas.",
    positives: JSON.stringify(["Execução operacional consistente", "Diversificação geográfica"]),
    risks: JSON.stringify(["Valuation historicamente esticado"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "ABEV3", name: "Ambev", category: "acoes",
    score: "78.00", potentialReturn: "10.00", dividendYield: "5.00", riskLevel: "Baixo",
    reason: "Consumo defensivo, geração de caixa robusta e marca dominante na América Latina.",
    positives: JSON.stringify(["Geração de caixa estável", "Marca consolidada"]),
    risks: JSON.stringify(["Concorrência em cervejas premium", "Custo de commodities agrícolas"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "ITUB4", name: "Itaú Unibanco", category: "acoes",
    score: "82.00", potentialReturn: "14.00", dividendYield: "6.00", riskLevel: "Medio",
    reason: "Maior banco privado do país, rentabilidade elevada e histórico de dividendos.",
    positives: JSON.stringify(["ROE consistentemente alto", "Diversificação de receitas"]),
    risks: JSON.stringify(["Sensível à Selic e inadimplência", "Concorrência de fintechs"]),
    horizon: "Médio prazo",
  },
  {
    ticker: "BBDC4", name: "Bradesco", category: "acoes",
    score: "70.00", potentialReturn: "16.00", dividendYield: "6.50", riskLevel: "Medio",
    reason: "Valuation descontado frente aos pares, potencial de recuperação de rentabilidade.",
    positives: JSON.stringify(["Valuation descontado", "Base de clientes ampla"]),
    risks: JSON.stringify(["Rentabilidade ainda em recuperação", "Custo de crédito elevado"]),
    horizon: "Médio prazo",
  },
  {
    ticker: "VALE3", name: "Vale", category: "acoes",
    score: "75.00", potentialReturn: "18.00", dividendYield: "8.00", riskLevel: "Medio",
    reason: "Maior produtora de minério de ferro do mundo, forte geração de caixa.",
    positives: JSON.stringify(["Baixo custo de produção", "Dividendos elevados"]),
    risks: JSON.stringify(["Preço do minério de ferro", "Demanda da China"]),
    horizon: "Médio prazo",
  },
  {
    ticker: "PETR4", name: "Petrobras", category: "acoes",
    score: "72.00", potentialReturn: "20.00", dividendYield: "12.00", riskLevel: "Alto",
    reason: "Dividendos elevados, mas com forte exposição a preço do petróleo e risco político.",
    positives: JSON.stringify(["Dividend yield elevado", "Baixo custo de extração"]),
    risks: JSON.stringify(["Interferência política em preços", "Volatilidade do petróleo"]),
    horizon: "Curto prazo",
  },
  {
    ticker: "RENT3", name: "Localiza", category: "acoes",
    score: "76.00", potentialReturn: "17.00", dividendYield: "2.00", riskLevel: "Medio",
    reason: "Líder em locação de veículos, crescimento consistente de frota.",
    positives: JSON.stringify(["Escala de frota líder", "Histórico de crescimento"]),
    risks: JSON.stringify(["Sensível a juros e preço de veículos"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "MGLU3", name: "Magazine Luiza", category: "acoes",
    score: "55.00", potentialReturn: "35.00", dividendYield: "0.00", riskLevel: "Alto",
    reason: "Varejista em processo de recuperação de margens, alta volatilidade.",
    positives: JSON.stringify(["Potencial de recuperação de margem", "Base logística consolidada"]),
    risks: JSON.stringify(["Endividamento elevado", "Concorrência acirrada no e-commerce"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "HGLG11", name: "CSHG Logística", category: "fiis",
    score: "85.00", potentialReturn: "8.00", dividendYield: "9.00", riskLevel: "Baixo",
    reason: "Portfólio de galpões logísticos bem localizados, baixa vacância.",
    positives: JSON.stringify(["Baixa vacância histórica", "Contratos longos"]),
    risks: JSON.stringify(["Concentração em poucos locatários"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "KNRI11", name: "Kinea Renda Imobiliária", category: "fiis",
    score: "83.00", potentialReturn: "7.00", dividendYield: "8.50", riskLevel: "Baixo",
    reason: "Fundo diversificado entre lajes corporativas e galpões, gestão consolidada.",
    positives: JSON.stringify(["Diversificação de imóveis", "Gestão consolidada"]),
    risks: JSON.stringify(["Exposição a vacância de lajes corporativas"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "MXRF11", name: "Maxi Renda", category: "fiis",
    score: "80.00", potentialReturn: "6.00", dividendYield: "10.50", riskLevel: "Baixo",
    reason: "FII de papel (CRIs), distribuição mensal consistente, boa liquidez.",
    positives: JSON.stringify(["Alta liquidez", "Distribuição mensal consistente"]),
    risks: JSON.stringify(["Sensível à inadimplência dos CRIs", "Risco de crédito"]),
    horizon: "Médio prazo",
  },
  {
    ticker: "XPML11", name: "XP Malls", category: "fiis",
    score: "74.00", potentialReturn: "10.00", dividendYield: "8.00", riskLevel: "Medio",
    reason: "Portfólio de shoppings com boa localização, sensível ao consumo.",
    positives: JSON.stringify(["Shoppings bem localizados", "Recuperação pós-pandemia"]),
    risks: JSON.stringify(["Sensível ao varejo físico e consumo"]),
    horizon: "Médio prazo",
  },
  {
    ticker: "BOVA11", name: "iShares Ibovespa", category: "etfs",
    score: "70.00", potentialReturn: "15.00", dividendYield: "3.00", riskLevel: "Medio",
    reason: "Exposição diversificada ao principal índice da bolsa brasileira.",
    positives: JSON.stringify(["Diversificação instantânea", "Baixo custo de gestão"]),
    risks: JSON.stringify(["Concentração em bancos e commodities"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "IVVB11", name: "iShares S&P 500", category: "etfs",
    score: "79.00", potentialReturn: "13.00", dividendYield: "1.20", riskLevel: "Medio",
    reason: "Exposição ao mercado americano, diversificação cambial.",
    positives: JSON.stringify(["Diversificação cambial", "Exposição a empresas globais"]),
    risks: JSON.stringify(["Risco cambial (dólar)"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "SMAL11", name: "iShares Small Cap", category: "etfs",
    score: "60.00", potentialReturn: "25.00", dividendYield: "2.50", riskLevel: "Alto",
    reason: "Exposição a empresas de menor porte, maior potencial e maior volatilidade.",
    positives: JSON.stringify(["Maior potencial de valorização", "Diversificação em small caps"]),
    risks: JSON.stringify(["Maior volatilidade", "Menor liquidez média"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "AAPL34", name: "Apple", category: "bdrs",
    score: "81.00", potentialReturn: "14.00", dividendYield: "0.50", riskLevel: "Medio",
    reason: "Empresa de tecnologia global com ecossistema consolidado e forte geração de caixa.",
    positives: JSON.stringify(["Ecossistema fidelizado", "Forte geração de caixa"]),
    risks: JSON.stringify(["Risco cambial", "Dependência do ciclo de produtos"]),
    horizon: "Longo prazo",
  },
  {
    ticker: "MSFT34", name: "Microsoft", category: "bdrs",
    score: "84.00", potentialReturn: "15.00", dividendYield: "0.80", riskLevel: "Medio",
    reason: "Líder em software corporativo e nuvem, crescimento consistente.",
    positives: JSON.stringify(["Liderança em nuvem corporativa", "Receita recorrente"]),
    risks: JSON.stringify(["Risco cambial", "Valuation elevado"]),
    horizon: "Longo prazo",
  },
];

async function main() {
  console.log(`Seeding ${OPPORTUNITIES.length} opportunities...`);
  await db.delete(opportunitiesTable);
  await db.insert(opportunitiesTable).values(OPPORTUNITIES);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
