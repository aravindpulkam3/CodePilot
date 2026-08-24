import { Router } from "express";
import { 
  getRecentWork, 
  getPendingPRs, 
  getRecentActivity 
} from "../controllers/dashboard.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const dashboardRouter = Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get("/recent-work", getRecentWork);
dashboardRouter.get("/pending-prs", getPendingPRs);
dashboardRouter.get("/activity", getRecentActivity);

export default dashboardRouter;