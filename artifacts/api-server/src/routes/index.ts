import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import assetsRouter from "./assets";
import profileRouter from "./profile";
import portfolioRouter from "./portfolio";
import alertsRouter from "./alerts";
import opportunitiesRouter from "./opportunities";
import transactionsRouter from "./transactions";
import analysisRouter from "./analysis";
import macroRouter from "./macro";
import priceTargetsRouter from "./price-targets";
import importRouter from "./import";
import internalRouter from "./internal";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(assetsRouter);
router.use(profileRouter);
router.use(portfolioRouter);
router.use(alertsRouter);
router.use(opportunitiesRouter);
router.use(transactionsRouter);
router.use(analysisRouter);
router.use(macroRouter);
router.use(priceTargetsRouter);
router.use(importRouter);
router.use(internalRouter);

export default router;
