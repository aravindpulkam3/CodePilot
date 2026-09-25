import { safeErrorDetails } from "../../shared/utils/safeErrorDetails.js";
import { isUuid } from "../../shared/utils/inputValidation.js";
// src/controllers/repositoryController.ts
import { Request, Response } from 'express';
import * as repositoryService from './repository.service.js';
import { pool } from '../../config/db.js';

export const getRepositoryById = async (req: Request, res: Response) => {
  try {
    const repoId = req.params.repositoryId as string;
    if (!isUuid(repoId)) return res.status(400).json({ error: "repositoryId must be a UUID" });
    const repo = await repositoryService.findOwnedRepositoryById(repoId, req.dbUser!.id);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found.' });
    }

    return res.status(200).json(repo);
  } catch (error) {
    console.error("Error fetching repository details:", { repositoryId: req.params.repositoryId, ...safeErrorDetails(error) });
    return res.status(500).json({ error: 'Failed to retrieve repository details.' });
  }
};

export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const repositoryId = req.params.repositoryId as string;
    if (!isUuid(repositoryId)) return res.status(400).json({ error: "repositoryId must be a UUID" });

    const { rows } = await pool.query(
      `SELECT indexing_status, last_indexed_sha, index_chunks_total,
              cardinality(completed_index_chunks) AS chunks_done
       FROM repositories WHERE id = $1 AND user_id = $2`,
      [repositoryId, req.dbUser!.id],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Repository not found.' });
    }
    const repo = rows[0];

    return res.status(200).json({
      status: repo.indexing_status,
      // A previous index stays searchable while a later run is in flight.
      searchable: repo.last_indexed_sha != null,
      indexProgress: repo.index_chunks_total != null
        ? { chunksDone: repo.chunks_done, chunksTotal: repo.index_chunks_total }
        : null,
    });
  } catch (error) {
    console.error("Error fetching sync status:", error);
    return res.status(500).json({ error: 'Failed to retrieve sync status.' });
  }
};

export const startWorking = async (req: Request, res: Response) => {
  try {
    const repositoryId = req.params.repositoryId as string;
    if (!isUuid(repositoryId)) return res.status(400).json({ error: "repositoryId must be a UUID" });
    const appUserId = req.dbUser!.id;
    const clerkUserId = req.dbUser!.clerkId;

    const repo = await repositoryService.findRepositoryById(repositoryId);
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found.' });
    }
    if (repo.user_id !== appUserId) {
      return res.status(403).json({ error: 'You do not have access to this repository.' });
    }

    console.log(`[Workspace] User ${appUserId} starting work on repo ${repositoryId} (${repo.name}).`);

    await pool.query(
      `UPDATE repositories SET workspace_started_at = COALESCE(workspace_started_at, NOW()) WHERE id = $1`,
      [repositoryId],
    );

    // Only trigger indexing here — never proactively for repos that are
    // merely listed. This is the one explicit "start working" action.
    const { repositorySyncService } = await import('./repositorySync.service.js');
    const enqueueResult = await repositorySyncService.enqueueSync(clerkUserId, repositoryId);
    console.log(`[Workspace] enqueueSync for ${repositoryId} -> ${enqueueResult.status} (job ${enqueueResult.jobId}).`);

    return res.status(200).json({ status: 'started' });
  } catch (error) {
    console.error("Error starting work on repository:", error);
    return res.status(500).json({ error: 'Failed to start working on repository.' });
  }
};

export const stopWorking = async (req: Request, res: Response) => {
  try {
    const repositoryId = req.params.repositoryId as string;
    if (!isUuid(repositoryId)) return res.status(400).json({ error: "repositoryId must be a UUID" });
    const appUserId = req.dbUser!.id;

    const repo = await repositoryService.findRepositoryById(repositoryId);
    if (!repo) {
      return res.status(404).json({ error: 'Repository not found.' });
    }
    if (repo.user_id !== appUserId) {
      return res.status(403).json({ error: 'You do not have access to this repository.' });
    }

    console.log(`[Workspace] User ${appUserId} stopping work on repo ${repositoryId} (${repo.name}).`);

    // Only clears workspace membership — never touches the GitHub repo or
    // any indexed data, so re-starting later is instant.
    await pool.query(
      `UPDATE repositories SET workspace_started_at = NULL WHERE id = $1`,
      [repositoryId],
    );

    return res.status(200).json({ status: 'stopped' });
  } catch (error) {
    console.error("Error stopping work on repository:", error);
    return res.status(500).json({ error: 'Failed to stop working on repository.' });
  }
};
