import { Router, type IRouter } from "express";
import { db, investorProfilesTable, assetsTable, type InvestorProfile } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateInvestorProfileBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { assessInvestorProfile, horizonBucketFromYears, type ProfileClassification } from "../lib/investor-profile-engine";
import { computeRevealedProfile, compareProfiles } from "../lib/revealed-profile-engine";
import { getPricesFor, getFundamentals } from "../lib/market-data";

const router: IRouter = Router();

/**
 * Monta o perfil revelado a partir das posições reais. Beta vem dos fundamentos já
 * usados pela análise; quando o provider não traz beta para um ativo, aquela
 * posição simplesmente não entra nesse fator (ver computeRevealedProfile).
 */
async function buildRevealedProfile(userId: number) {
  const assets = await db.select().from(assetsTable).where(eq(assetsTable.userId, userId));
  if (assets.length === 0) return null;

  const [prices, fundamentals] = await Promise.all([
    getPricesFor(assets),
    getFundamentals(assets.map((a) => a.ticker)),
  ]);

  return computeRevealedProfile(
    assets.map((asset) => {
      const ticker = asset.ticker.toUpperCase();
      const price = prices.get(ticker)?.price ?? parseFloat(asset.averagePrice);
      return {
        ticker,
        category: asset.category,
        value: parseFloat(asset.quantity) * price,
        beta: fundamentals.get(ticker)?.beta ?? null,
      };
    }),
  );
}

async function serialize(profile: InvestorProfile) {
  const revealed = await buildRevealedProfile(profile.userId);
  const divergence = revealed
    ? compareProfiles(profile.classification as ProfileClassification, revealed)
    : null;

  // Reavaliado na leitura, não lido das colunas: as travas e a explicação de qual
  // eixo limitou o perfil dependem da lógica atual do motor, então perfis gravados
  // por uma versão anterior ganham a leitura nova sem precisar ser reenviados.
  const assessment = assessInvestorProfile({
    lossTolerance: profile.lossTolerance,
    objective: profile.objective,
    experience: profile.experience,
    liquidityNeed: profile.liquidityNeed,
    horizonYears: profile.horizonYears,
    emergencyFund: profile.emergencyFund,
    portfolioShare: profile.portfolioShare,
    incomeStability: profile.incomeStability,
  });

  return {
    id: profile.id,
    userId: profile.userId,
    horizon: profile.horizon,
    lossTolerance: profile.lossTolerance,
    objective: profile.objective,
    experience: profile.experience,
    liquidityNeed: profile.liquidityNeed,
    horizonYears: profile.horizonYears,
    emergencyFund: profile.emergencyFund,
    portfolioShare: profile.portfolioShare,
    incomeStability: profile.incomeStability,
    score: parseFloat(profile.score),
    capacityScore: assessment.capacityScore,
    toleranceScore: assessment.toleranceScore,
    classification: profile.classification,
    limitedBy: assessment.limitedBy,
    capacityComplete: assessment.capacityComplete,
    constraints: assessment.constraints,
    revealedClassification: revealed?.classification ?? null,
    revealedVariableIncomePercent: revealed?.variableIncomePercent ?? null,
    revealedLargestPositionPercent: revealed?.largestPositionPercent ?? null,
    revealedLargestPositionTicker: revealed?.largestPositionTicker ?? null,
    revealedWeightedBeta: revealed?.weightedBeta ?? null,
    revealedBetaCoveragePercent: revealed?.betaCoveragePercent ?? null,
    divergenceMessage: divergence?.message ?? null,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

router.get("/profile", requireAuth, async (req, res): Promise<void> => {
  const [profile] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!));
  if (!profile) {
    res.status(404).json({ error: "Perfil de investidor ainda não definido" });
    return;
  }
  res.json(await serialize(profile));
});

router.put("/profile", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateInvestorProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { lossTolerance, objective, experience, liquidityNeed, horizonYears, emergencyFund, portfolioShare, incomeStability } = parsed.data;
  const assessment = assessInvestorProfile({
    lossTolerance,
    objective,
    experience,
    liquidityNeed,
    horizonYears,
    emergencyFund,
    portfolioShare,
    incomeStability,
  });

  const values = {
    userId: req.session.userId!,
    horizon: horizonBucketFromYears(horizonYears), // derivado, mantém a coluna legada coerente
    lossTolerance,
    objective,
    experience,
    liquidityNeed,
    horizonYears,
    emergencyFund,
    portfolioShare,
    incomeStability,
    score: String(assessment.score),
    capacityScore: String(assessment.capacityScore),
    toleranceScore: String(assessment.toleranceScore),
    classification: assessment.classification,
  };

  const [existing] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!));

  const [profile] = existing
    ? await db.update(investorProfilesTable).set(values).where(eq(investorProfilesTable.userId, req.session.userId!)).returning()
    : await db.insert(investorProfilesTable).values(values).returning();

  res.json(await serialize(profile));
});

export default router;
