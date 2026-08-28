import { Router } from "express";
import { getMe } from "../controllers/user.controller.js";
import { requireAuth } from "@clerk/express";
import { Request, Response, NextFunction } from "express";

const userRouter = Router();

userRouter.get("/me",getMe);

export default userRouter;

