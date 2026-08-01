import { Router } from "express";
import express from "express";
import { Webhook } from "svix";
import { env } from "../config/env.js";
import { userService } from "../services/user.service.js";

export const webhookRoutes = Router();

interface ClerkUserPayload {
  id: string;
  email_addresses: Array<{ id: string; email_address: string }>;
  primary_email_address_id: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  external_accounts?: Array<{ provider: string; username?: string | null }>;
}

/**
 * POST /api/webhooks/clerk — keeps `app_users` in sync with Clerk.
 * Configure this URL in Clerk Dashboard → Webhooks, subscribed to
 * user.created / user.updated / user.deleted, and paste the signing
 * secret into CLERK_WEBHOOK_SIGNING_SECRET.
 *
 * Uses `express.raw` (not the app-wide json() parser) because svix needs
 * the exact raw request body to verify the signature.
 */
webhookRoutes.post(
  "/clerk",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!env.clerkWebhookSigningSecret) {
      res.status(503).json({ error: "Webhook signing secret not configured" });
      return;
    }

    const svixId = req.header("svix-id");
    const svixTimestamp = req.header("svix-timestamp");
    const svixSignature = req.header("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      res.status(400).json({ error: "Missing svix headers" });
      return;
    }

    const wh = new Webhook(env.clerkWebhookSigningSecret);
    let event: { type: string; data: ClerkUserPayload };

    try {
      event = wh.verify(req.body, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as typeof event;
    } catch {
      res.status(400).json({ error: "Invalid webhook signature" });
      return;
    }

    if (event.type === "user.created" || event.type === "user.updated") {
      const data = event.data;
      const primaryEmail =
        data.email_addresses.find((e) => e.id === data.primary_email_address_id)
          ?.email_address ?? data.email_addresses[0]?.email_address ?? "";
      const github = data.external_accounts?.find((a) => a.provider === "github");

      await userService.upsertFromClerk({
        clerkId: data.id,
        email: primaryEmail,
        name: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
        avatarUrl: data.image_url,
        githubConnected: Boolean(github),
        githubUsername: github?.username ?? null,
      });
    }

    if (event.type === "user.deleted") {
      await userService.deleteByClerkId(event.data.id);
    }

    res.status(200).json({ received: true });
  }
);
