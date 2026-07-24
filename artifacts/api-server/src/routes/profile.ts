import { Router, type IRouter } from "express";
import { db, investorProfilesTable, type InvestorProfile } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateInvestorProfileBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

const HORIZON_POINTS: Record<string, number> = { curto: 0, medio: 10, longo: 20 };
const LOSS_TOLERANCE_POINTS: Record<string, number> = { baixa: 0, media: 10, alta: 20 };
const OBJECTIVE_POINTS: Record<string, number> = { preservar: 0, renda: 10, crescimento: 20 };
const EXPERIENCE_POINTS: Record<string, number> = { iniciante: 0, intermediario: 10, avancado: 20 };
const LIQUIDITY_NEED_POINTS: Record<string, number> = { sim: 0, nao: 20 };

function computeScore(input: {
  horizon: string;
  lossTolerance: string;
  objective: string;
  experience: string;
  liquidityNeed: string;
}): number {
  return (
    (HORIZON_POINTS[input.horizon] ?? 0) +
    (LOSS_TOLERANCE_POINTS[input.lossTolerance] ?? 0) +
    (OBJECTIVE_POINTS[input.objective] ?? 0) +
    (EXPERIENCE_POINTS[input.experience] ?? 0) +
    (LIQUIDITY_NEED_POINTS[input.liquidityNeed] ?? 0)
  );
}

function classify(score: number): "Conservador" | "Moderado" | "Arrojado" {
  if (score >= 67) return "Arrojado";
  if (score >= 34) return "Moderado";
  return "Conservador";
}

function serialize(profile: InvestorProfile) {
  return {
    id: profile.id,
    userId: profile.userId,
    horizon: profile.horizon,
    lossTolerance: profile.lossTolerance,
    objective: profile.objective,
    experience: profile.experience,
    liquidityNeed: profile.liquidityNeed,
    score: parseFloat(profile.score),
    classification: profile.classification,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

router.get("/profile", requireAuth, async (req, res): Promise<void> => {
  const [profile] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!));
  if (!profile) {
    res.status(404).json({ error: "Perfil de investidor ainda não definido" });
    return;
  }
  res.json(serialize(profile));
});

router.put("/profile", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateInvestorProfileBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { horizon, lossTolerance, objective, experience, liquidityNeed } = parsed.data;
  const score = computeScore({ horizon, lossTolerance, objective, experience, liquidityNeed });
  const classification = classify(score);

  const values = {
    userId: req.session.userId!,
    horizon,
    lossTolerance,
    objective,
    experience,
    liquidityNeed,
    score: String(score),
    classification,
  };

  const [existing] = await db.select().from(investorProfilesTable).where(eq(investorProfilesTable.userId, req.session.userId!));

  const [profile] = existing
    ? await db.update(investorProfilesTable).set(values).where(eq(investorProfilesTable.userId, req.session.userId!)).returning()
    : await db.insert(investorProfilesTable).values(values).returning();

  res.json(serialize(profile));
});

export default router;
