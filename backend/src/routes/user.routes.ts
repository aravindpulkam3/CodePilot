import { Router } from "express";
import { requireAuthentication } from "../middleware/auth.middleware.js";
import { getMe } from "../controllers/user.controller.js";

export const userRoutes = Router();

userRoutes.get("/me", requireAuthentication, getMe);
