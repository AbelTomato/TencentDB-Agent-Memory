/** Restore the previous index when a process stopped during a refresh. */

import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { IKnowledgeStore } from "./store/types.js";

type RecoveryStore = Pick<IKnowledgeStore,
  "listRecoverableCodeGraphs" | "listSyncedCodeGraphs" | "updateCodeGraphStatus"
>;

export function recoverInterruptedCodeGraphs(
  store: RecoveryStore,
  dataDir: string,
  logger?: { warn: (message: string) => void },
): number {
  let recovered = 0;
  for (const row of store.listRecoverableCodeGraphs()) {
    // The persisted bit survives a crash and does not depend on a timestamp
    // that older ready rows may lack.
    if (!row.has_last_good) continue;
    const dir = join(dataDir, row.service_id, row.team_id, row.code_graph_id);
    const previousDir = `${dir}.previous`;
    try {
      // An ordinary failed build has no trustworthy prior snapshot. Only a
      // retained backup proves that an interrupted promotion can be rolled back.
      if (row.status === "failed" && !existsSync(previousDir)) continue;
      // Only an interrupted promotion makes .previous the authoritative
      // last-good snapshot. A stale backup from an already committed build
      // must not replace the canonical directory on a later pending retry.
      if (existsSync(previousDir)) {
        if (row.status === "failed" || row.internal_status === "promoting" || !existsSync(dir)) {
          if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
          renameSync(previousDir, dir);
        } else {
          try { rmSync(previousDir, { recursive: true, force: true }); }
          catch (err) { logger?.warn(`[code-graph] could not remove retired index ${row.code_graph_id}: ${String(err)}`); }
        }
      }
      if (!existsSync(join(dir, ".git"))) continue;

      store.updateCodeGraphStatus(row.service_id, row.code_graph_id, {
        status: "ready",
        internal_status: null,
        sync_error: "refresh interrupted by restart; previous index retained",
      });
      recovered++;

    } catch (err) {
      logger?.warn(`[code-graph] could not restore interrupted refresh ${row.code_graph_id}: ${String(err)}`);
      // Leave the row unchanged; the regular sweep handles pending/processing.
    }
  }

  // If metadata was committed before a crash, the new directory is live and
  // only the retired snapshot remains to be removed.
  for (const ref of store.listSyncedCodeGraphs()) {
    const dir = join(dataDir, ref.service_id, ref.team_id, ref.code_graph_id);
    const previousDir = `${dir}.previous`;
    if (!existsSync(dir) || !existsSync(previousDir)) continue;
    try { rmSync(previousDir, { recursive: true, force: true }); }
    catch (err) { logger?.warn(`[code-graph] could not remove retired index ${ref.code_graph_id}: ${String(err)}`); }
  }
  // A delete can remove the metadata row before a crash, so a row-based sweep
  // alone misses its candidate. Recovery runs before this process starts jobs.
  cleanupOrphanCandidates(dataDir, logger);
  return recovered;
}

function cleanupOrphanCandidates(dataDir: string, logger?: { warn: (message: string) => void }): void {
  if (!existsSync(dataDir)) return;
  try {
    for (const service of readdirSync(dataDir, { withFileTypes: true })) {
      if (!service.isDirectory()) continue;
      const serviceDir = join(dataDir, service.name);
      for (const team of readdirSync(serviceDir, { withFileTypes: true })) {
        if (!team.isDirectory()) continue;
        const teamDir = join(serviceDir, team.name);
        try {
          for (const entry of readdirSync(teamDir, { withFileTypes: true })) {
            if (!/^\.cg-[0-9a-z]+\.candidate-[0-9a-f-]{36}$/.test(entry.name)) continue;
            try { rmSync(join(teamDir, entry.name), { recursive: true, force: true }); }
            catch (err) { logger?.warn(`[code-graph] could not remove orphan candidate ${entry.name}: ${String(err)}`); }
          }
        } catch (err) {
          logger?.warn(`[code-graph] could not scan candidates in ${teamDir}: ${String(err)}`);
        }
      }
    }
  } catch (err) {
    logger?.warn(`[code-graph] could not scan candidates in ${dataDir}: ${String(err)}`);
  }
}
