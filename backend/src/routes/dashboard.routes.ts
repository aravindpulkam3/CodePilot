import { Router } from "express";
import { 
  getRecentWork, 
  getPendingPRs, 
  getRecentActivity 
} from "../controllers/dashboard.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/recent-work", getRecentWork);
router.get("/pending-prs", getPendingPRs);
router.get("/activity", getRecentActivity);

export default router;