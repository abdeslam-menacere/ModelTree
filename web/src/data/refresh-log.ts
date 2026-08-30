import refreshRuns from './refresh-runs.json';
import { validateRefreshLog } from './refresh-log-schema';

/**
 * The data refresh log, validated at build time like every other document here.
 *
 * Kept out of `raw.ts` on purpose: these are facts about refresh runs, not about
 * models. It is nonetheless inside the ADR 0003 qualifying class, which ADR 0006
 * widened by this one file so that a run records itself in the pull request it
 * publishes rather than waiting for somebody to notice the page had gone stale.
 * `gate-ledger.mjs` cross-checks each new entry's record counts against the diff.
 */
export const refreshLog = validateRefreshLog(refreshRuns);

export const runById = new Map(refreshLog.map((run) => [run.id, run]));
