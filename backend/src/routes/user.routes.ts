import { Router } from "express";
import { getMe } from "../controllers/user.controller.js";
import { requireAuth } from "@clerk/express";

export const userRoutes = Router();

userRoutes.get("/me", requireAuth, getMe);
