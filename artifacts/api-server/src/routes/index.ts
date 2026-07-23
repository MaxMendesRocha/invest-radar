import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import assetsRouter from "./assets";
import portfolioRouter from "./portfolio";
import alertsRouter from "./alerts";
import opportunitiesRouter from "./opportunities";
import transactionsRouter from "./transactions";
import analysisRouter from "./analysis";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(assetsRouter);
router.use(portfolioRouter);
router.use(alertsRouter);
router.use(opportunitiesRouter);
router.use(transactionsRouter);
router.use(analysisRouter);

export default router;
