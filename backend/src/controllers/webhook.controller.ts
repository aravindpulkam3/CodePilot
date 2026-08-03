// src/controllers/webhook.controller.ts
import { Request, Response } from 'express';
import { repositorySyncService } from '../services/repositorySync.service.js';

export class WebhookController {
    /**
     * Listens for GitHub 'push' events to keep the vector database in sync.
     */
    public async handleGithubWebhook(req: Request, res: Response) {
        const event = req.headers['x-github-event'];
        const payload = req.body;

        // Immediately respond to GitHub so the webhook doesn't timeout
        res.status(200).send('Received');

        // We only care about pushes to the default branch (e.g., main or master)
        if (event === 'push') {
            // Check if the push was to the default branch
            const defaultBranch = payload.repository.default_branch;
            if (payload.ref === `refs/heads/${defaultBranch}`) {
                
                const repositoryId = payload.repository.id.toString();
                // Note: You must look up the clerkUserId associated with this repo in your DB
                const clerkUserId = "SYSTEM_OR_OWNER_ID"; 
                
                console.log(`[Webhook] Push detected on ${payload.repository.full_name}. Triggering background sync...`);

                try {
                    // Run the heavy sync process asynchronously in the background
                    await repositorySyncService.syncRepository(clerkUserId, repositoryId);
                    console.log(`[Webhook] Background sync completed for ${payload.repository.full_name}.`);
                } catch (error) {
                    console.error(`[Webhook] Background sync failed:`, error);
                    // In a production app, you might trigger an alert or retry queue here
                }
            }
        }
    }
}

export const webhookController = new WebhookController();