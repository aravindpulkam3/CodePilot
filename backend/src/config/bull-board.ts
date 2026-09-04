import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { syncQueue, indexQueue, summarizeQueue } from './queues.js';

// Setup Express adapter for Bull Board
export const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

// Initialize Bull Board
createBullBoard({
  queues: [
    new BullMQAdapter(syncQueue),
    new BullMQAdapter(indexQueue),
    new BullMQAdapter(summarizeQueue)
  ],
  serverAdapter,
});
