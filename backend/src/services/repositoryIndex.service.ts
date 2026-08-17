import {pool} from '../config/db.js';
import { astChunker } from './astChunking.service.js';
import { embedder } from './embedding.service.js';
import { updateSummariesIncrementally } from './summaryPipeline.service.js';
import { PgSummaryStore } from '../utils/pgSummaryStore.js';
import { llmService } from './llm.service.js';

export interface FileChange {
    path: string;
    content: string | null;
    status: 'added' | 'modified' | 'removed' | 'renamed';
}

export class RepositoryIndexingService {
    /**
     * Processes a repository update by selectively syncing only changed files.
     * Uses AST hashing to skip redundant API calls and performs Orphan Cleanup.
     */
    public async processRepositoryUpdate(repositoryId: string, commitSha: string, changedFiles: FileChange[]) {
        // 1. Ensure WASM parsers are booted
        await astChunker.init();

        console.log("came to index the repo")
        
        // 2. Initialize a dedicated database client for a transaction
        const client = await pool.connect();
        
        try {
            // Lock indexing status
            await client.query(
                `UPDATE repositories SET indexing_status = 'INDEXING' WHERE id = $1`,
                [repositoryId]
            );

            await client.query('BEGIN');
            
            for (const file of changedFiles) {
                
                // Scenario A: File was deleted
                if (file.status === 'removed') {
                    await client.query(
                        `DELETE FROM repository_embeddings 
                         WHERE repository_id = $1 AND file_path = $2`,
                        [repositoryId, file.path]
                    );
                    continue;
                }

                if (!file.content) continue; // Safety check

                // Scenario B: File was added or modified
                // 1. Generate new AST chunks
                const newChunks = await astChunker.chunkFile(file.path, file.content);
                const newHashes = new Set(newChunks.map(c => c.content_hash));

                console.log(newChunks.length);
                console.log(newHashes.size);

                // 2. Fetch existing hashes from DB for this specific file
                const { rows } = await client.query(
                    `SELECT content_hash FROM repository_embeddings 
                     WHERE repository_id = $1 AND file_path = $2`,
                    [repositoryId, file.path]
                );
                const existingHashes = new Set(rows.map(r => r.content_hash));

                // 3. ORPHAN CLEANUP: Delete chunks that exist in DB but not in new AST
                const hashesToDelete = [...existingHashes].filter(h => !newHashes.has(h));
                
                if (hashesToDelete.length > 0) {
                    await client.query(
                        `DELETE FROM repository_embeddings 
                         WHERE repository_id = $1 AND file_path = $2 AND content_hash = ANY($3)`,
                        [repositoryId, file.path, hashesToDelete]
                    );
                }

                // 4. DELTA UPDATE: Find brand new or modified chunks to embed
                const chunksToEmbed = newChunks.filter(c => !existingHashes.has(c.content_hash));
                console.log("chunks to embed",chunksToEmbed.length);

                if (chunksToEmbed.length > 0) {
                    // Call Gemini API ONLY for the specific functions that changed
                    console.log("going to generate embeddings");
                    const embeddedChunks = await embedder.generateEmbeddings(chunksToEmbed);

                    console.log("embedded chunks" ,embeddedChunks.length)

                    // Insert the new chunks
                    for (const chunk of embeddedChunks) {
                        const embeddingVectorStr = `[${chunk.embedding.join(',')}]`;

                        await client.query(
                            `INSERT INTO repository_embeddings 
                            (repository_id, commit_sha, file_path, language, symbol_type, symbol_name, start_line, end_line, content_hash, content, embedding)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                            [
                                repositoryId,
                                commitSha,
                                chunk.file_path,
                                chunk.language,
                                chunk.symbol_type,
                                chunk.symbol_name,
                                chunk.start_line,
                                chunk.end_line,
                                chunk.content_hash,
                                chunk.content,
                                embeddingVectorStr
                            ]
                        );
                    }
                }
                
                // 5. UPDATE EXISTING: Bump the commit_sha for chunks that didn't change
                // This ensures we know these chunks are valid for the current commit.
                const hashesToKeep = [...existingHashes].filter(h => newHashes.has(h));
                if (hashesToKeep.length > 0) {
                    await client.query(
                        `UPDATE repository_embeddings 
                         SET commit_sha = $1, updated_at = CURRENT_TIMESTAMP 
                         WHERE repository_id = $2 AND file_path = $3 AND content_hash = ANY($4)`,
                        [commitSha, repositoryId, file.path, hashesToKeep]
                    );
                }
            }

            // Finalize indexing status and advance the pointer
            await client.query(
                `UPDATE repositories 
                 SET last_indexed_sha = $1, indexing_status = 'INDEXED' 
                 WHERE id = $2`,
                [commitSha, repositoryId]
            );

            console.log("Triggering incremental summarization...");
            const store = new PgSummaryStore(pool);
            await updateSummariesIncrementally({
                repositoryId,
                changedFiles,
                readme: null,
                packageMetadata: null
            }, {
                llm: llmService,
                embeddings: embedder,
                store
            });
            console.log("Incremental summarization completed.");

            await client.query('COMMIT');
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error during repository indexing:', error);
            
            // Mark as failed in DB so the UI can alert the user
            try {
                await pool.query(
                    `UPDATE repositories SET indexing_status = 'FAILED' WHERE id = $1`,
                    [repositoryId]
                );
            } catch (e) {
                console.error('Failed to update error status:', e);
            }
            
            throw error; // Re-throw to handle it in the controller if needed
        } finally {
            client.release();
        }
    }
}
export const repositoryIndexer = new RepositoryIndexingService();