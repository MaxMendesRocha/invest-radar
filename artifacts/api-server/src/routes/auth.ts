import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { RegisterBody, LoginBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";
import { loginRateLimiter, registerRateLimiter } from "../middlewares/rate-limit";
import { regenerateSession } from "../lib/session";

const router: IRouter = Router();

router.post("/auth/register", registerRateLimiter, async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, email, password } = parsed.data;

  const existing = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing.length > 0) {
    res.status(409).json({ error: "Email já está em uso" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(usersTable).values({ name, email, passwordHash }).returning();

  // ID de sessão novo antes de autenticar — ver o comentário em lib/session.ts.
  await regenerateSession(req);
  req.session.userId = user.id;
  res.status(201).json({
    user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt },
  });
});

router.post("/auth/login", loginRateLimiter, async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { email, password } = parsed.data;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  // ID de sessão novo antes de autenticar: sem isto, um ID de sessão fixado por um
  // atacante ANTES do login (ex. vítima abre um link com sessão pré-definida)
  // continuava o mesmo depois — e viraria uma sessão autenticada que o atacante já
  // conhecia. `regenerate()` reatribui `req.session`; por isso o `userId` é setado
  // DEPOIS do await, na referência nova, nunca antes.
  await regenerateSession(req);
  req.session.userId = user.id;
  res.json({
    user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt },
  });
});

router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({ id: user.id, name: user.name, email: user.email, createdAt: user.createdAt });
});

router.post("/auth/logout", (req, res): void => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

export default router;
