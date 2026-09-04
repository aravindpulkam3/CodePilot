// src/controllers/repositoryController.ts
import { Request, Response } from 'express';
import * as repositoryService from '../services/repository.service.js';
import { pool } from '../config/db.js';

export const getRepositoryById = async (req: Request, res: Response) => {
  try {
    const repoId = req.params.repositoryId as string;
    const repo = await repositoryService.findRepositoryById(repoId);

    if (!repo) {
      return res.status(404).json({ error: 'Repository not found.' });
    }

    return res.status(200).json(repo);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to retrieve repository details.' });
  }
};

export const getSyncStatus = async (req: Request, res: Response) => {
  try {
    const repositoryId = req.params.repositoryId as string;

    const { rows } = await pool.query(
      `SELECT indexing_status, searchable_at, last_summary_error,
              index_files_done, index_files_total,
              index_chunks_done, index_chunks_total,
              summary_tasks_done, summary_tasks_total
       FROM repositories WHERE id = $1`,
      [repositoryId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Repository not found.' });
    }
    const repo = rows[0];
    const status = repo.indexing_status || 'NOT_STARTED';

    return res.status(200).json({
      status,
      searchableAt: repo.searchable_at,
      indexProgress: repo.index_files_total != null || repo.index_chunks_total != null
        ? {
            filesDone: repo.index_files_done,
            filesTotal: repo.index_files_total,
            chunksDone: repo.index_chunks_done,
            chunksTotal: repo.index_chunks_total,
          }
        : null,
      summaryProgress: repo.summary_tasks_total != null
        ? { tasksDone: repo.summary_tasks_done, tasksTotal: repo.summary_tasks_total }
        : null,
      lastSummaryError: repo.last_summary_error,
    });
  } catch (error) {
    console.error("Error fetching sync status:", error);
    return res.status(500).json({ error: 'Failed to retrieve sync status.' });
  }
};

export const startWorking = async (req: Request, res: Response) => {
  try {
    const repositoryId = req.params.repositoryId as string;
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
    const { repositorySyncService } = await import('../services/repositorySync.service.js');
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
    // any cached index/summary data, so re-starting later is instant.
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
