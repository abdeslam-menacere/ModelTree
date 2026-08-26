import refreshRuns from './refresh-runs.json';
import { validateRefreshLog } from './refresh-log-schema';

/**
 * The data-check log, validated at build time like every other document here.
 *
 * Kept out of `raw.ts` on purpose: these are facts about refresh runs, not about
 * models, and `gate-scope.mjs` bounds an auto-merging refresh to exactly the
 * documents `raw.ts` composes.
 */
export const refreshLog = validateRefreshLog(refreshRuns);

export const runById = new Map(refreshLog.map((run) => [run.id, run]));
