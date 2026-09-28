/** Build a replacement CodeGraph without mutating the last successfully indexed checkout. */

import { randomUUID } from "node:crypto";
import { constants, existsSync, mkdirSync } from "node:fs";
import { cp, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { closeIndex, getStats, indexProject, openIndex, syncIndex, type CodeGraphInstance } from "./engines/code/index.js";
import { PreservedCodeGraphError, type CodeGraphWorker } from "./store/code-graph-service.js";
import type { CodeGraphInstancePool } from "./module.js";
import type { ISourceFetcher } from "./source-fetcher/index.js";

export interface CodeGraphIndexOps {
  openIndex: (dir: string) => Promise<CodeGraphInstance>;
  indexProject: (dir: string) => Promise<CodeGraphInstance>;
  syncIndex: (instance: CodeGraphInstance) => Promise<{ changed: number }>;
  getStats: (instance: CodeGraphInstance) => {
    fileCount?: number;
    nodeCount?: number;
    edgeCount?: number;
    files?: number;
    nodes?: number;
    edges?: number;
  };
  closeIndex: (instance: CodeGraphInstance) => void;
}

export interface CodeGraphWorkerOptions {
  instancePool: CodeGraphInstancePool;
  resolveFetcher: (repoUrl: string) => ISourceFetcher;
  indexOps?: CodeGraphIndexOps;
  renameDir?: typeof rename;
  logger?: { warn: (message: string) => void };
}

const defaultIndexOps: CodeGraphIndexOps = { openIndex, indexProject, syncIndex, getStats, closeIndex };

function statsFor(instance: CodeGraphInstance, indexOps: CodeGraphIndexOps) {
  const stats = indexOps.getStats(instance);
  return {
    files: stats.fileCount ?? stats.files ?? 0,
    nodes: stats.nodeCount ?? stats.nodes ?? 0,
    edges: stats.edgeCount ?? stats.edges ?? 0,
  };
}

export function createCodeGraphWorker(options: CodeGraphWorkerOptions): CodeGraphWorker {
  const { instancePool, resolveFetcher, logger } = options;
  const indexOps = options.indexOps ?? defaultIndexOps;
  const renameDir = options.renameDir ?? rename;

  return async ({ dir, repoUrl, branch, codeGraphId, hadReadyIndex, setInternalStatus }) => {
    const fetcher = resolveFetcher(repoUrl);

    // There is no last-good version to preserve on the first build.
    if (!hadReadyIndex) {
      // A failed initial build may have left a partial checkout behind.
      await rm(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      setInternalStatus("cloning");
      const result = await fetcher.fetch(repoUrl, branch, dir);
      setInternalStatus("indexing");
      const instance = await indexOps.indexProject(dir);
      instancePool.set(codeGraphId, instance);
      return { commitHash: result.version ?? undefined, stats: statsFor(instance, indexOps) };
    }

    const suffix = randomUUID();
    const parent = dirname(dir);
    const name = basename(dir);
    const candidateDir = join(parent, `.${name}.candidate-${suffix}`);
    // Stable name lets startup roll back a promotion interrupted by a process crash.
    const backupDir = `${dir}.previous`;
    let candidateInstance: CodeGraphInstance | undefined;
    let oldIntact = true;

    // Stop new reads and wait for in-flight reads before closing SQLite. The
    // CodeGraph engine checkpoints WAL on close; only then is a file copy of
    // codegraph.db and its sidecars a consistent source for the candidate.
    const withPausedIndex = async <T>(phase: string | undefined, action: () => Promise<T>): Promise<T> => {
      // Rollback must work even when the metadata store is the failed component.
      if (phase) setInternalStatus(phase);
      try {
        await instancePool.pause?.(codeGraphId);
        return await action();
      }
      finally { instancePool.resume?.(codeGraphId); }
    };

    try {
      if (existsSync(backupDir)) {
        // Admission came from ready, so this is a retired snapshot whose
        // previous finalize failed. If removal fails, leave canonical intact.
        await rm(backupDir, { recursive: true, force: true });
      }
      await withPausedIndex("copying", async () => {
        // If the pool was not hydrated, open and close once to checkpoint WAL.
        const oldInstance = instancePool.get(codeGraphId) ?? await indexOps.openIndex(dir);
        try { indexOps.closeIndex(oldInstance); }
        finally { instancePool.delete(codeGraphId); }
        // Git reset/clean and CodeGraph sync both write in place. Copy-on-write
        // where supported keeps those writes away from the serving checkout.
        await cp(dir, candidateDir, {
          recursive: true,
          mode: constants.COPYFILE_FICLONE,
          verbatimSymlinks: true,
          filter: (source) => {
            const parts = relative(dir, source).split(sep);
            if (parts[0] !== ".codegraph" || parts.length < 2) return true;
            const name = parts.at(-1) ?? "";
            return name !== "codegraph.lock" && name !== "daemon.pid" && name !== "daemon.sock" && !name.endsWith(".log");
          },
        });
        // Reopen promptly: network fetch and candidate indexing can take a long
        // time, while queries can keep using the unchanged canonical index.
        instancePool.set(codeGraphId, await indexOps.openIndex(dir));
      });
      setInternalStatus("fetching");

      let version: string | null;
      try {
        const result = await fetcher.sync(repoUrl, branch, candidateDir);
        version = result.version;
        setInternalStatus("indexing");
        candidateInstance = await indexOps.openIndex(candidateDir);
        await indexOps.syncIndex(candidateInstance);
      } catch (incrementalError) {
        logger?.warn(
          `[code-graph] incremental sync failed for ${codeGraphId}, trying a fresh candidate: ${incrementalError instanceof Error ? incrementalError.message : String(incrementalError)}`,
        );
        if (candidateInstance) indexOps.closeIndex(candidateInstance);
        candidateInstance = undefined;
        await rm(candidateDir, { recursive: true, force: true });
        mkdirSync(candidateDir, { recursive: true });
        setInternalStatus("cloning");
        const result = await fetcher.fetch(repoUrl, branch, candidateDir);
        version = result.version;
        setInternalStatus("indexing");
        candidateInstance = await indexOps.indexProject(candidateDir);
      }

      const stats = statsFor(candidateInstance, indexOps);
      indexOps.closeIndex(candidateInstance);
      candidateInstance = undefined;

      await withPausedIndex("promoting", async () => {
        // Release SQLite handles before renaming directories (required on Windows).
        const oldInstance = instancePool.get(codeGraphId);
        try { if (oldInstance) indexOps.closeIndex(oldInstance); }
        finally { instancePool.delete(codeGraphId); }

        try {
          await renameDir(dir, backupDir);
          oldIntact = false;
          await renameDir(candidateDir, dir);
          const activeInstance = await indexOps.openIndex(dir);
          instancePool.set(codeGraphId, activeInstance);
        } catch (promotionError) {
          try {
            if (existsSync(backupDir)) {
              if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
              await renameDir(backupDir, dir);
              oldIntact = true;
            }
            if (oldIntact) instancePool.set(codeGraphId, await indexOps.openIndex(dir));
          } catch (restoreError) {
            oldIntact = false;
            throw new AggregateError([promotionError, restoreError], "CodeGraph promotion and rollback both failed");
          }
          throw promotionError;
        }
      });

      return {
        commitHash: version ?? undefined,
        stats,
        // Keep the old snapshot until CodeGraphService commits the new status.
        finalize: () => rm(backupDir, { recursive: true, force: true }),
        rollback: async () => {
          await withPausedIndex(undefined, async () => {
            const activeInstance = instancePool.get(codeGraphId);
            try { if (activeInstance) indexOps.closeIndex(activeInstance); }
            finally { instancePool.delete(codeGraphId); }
            if (existsSync(dir)) await rm(dir, { recursive: true, force: true });
            await renameDir(backupDir, dir);
            instancePool.set(codeGraphId, await indexOps.openIndex(dir));
          });
        },
      };
    } catch (err) {
      if (!oldIntact) throw err;
      // The original directory was never modified, or promotion rolled it back.
      // Restore a lazy pool entry only if the on-disk index can actually be opened.
      if (!instancePool.get(codeGraphId)) {
        try { instancePool.set(codeGraphId, await indexOps.openIndex(dir)); }
        catch (openError) {
          throw new AggregateError([err, openError], "CodeGraph refresh failed and the previous index could not be opened");
        }
      }
      throw new PreservedCodeGraphError(err);
    } finally {
      if (candidateInstance) {
        try { indexOps.closeIndex(candidateInstance); }
        catch (err) { logger?.warn(`[code-graph] could not close candidate for ${codeGraphId}: ${String(err)}`); }
      }
      try { await rm(candidateDir, { recursive: true, force: true }); }
      catch (err) { logger?.warn(`[code-graph] could not remove candidate for ${codeGraphId}: ${String(err)}`); }
    }
  };
}
