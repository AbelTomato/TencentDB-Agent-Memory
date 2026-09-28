import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { rename } from "node:fs/promises";

import { createCodeGraphWorker } from "./code-graph-worker.js";
import { PreservedCodeGraphError } from "./store/code-graph-service.js";
import type { CodeGraphInstancePool } from "./module.js";
import type { CodeGraphInstance } from "./engines/code/index.js";
import type { ISourceFetcher } from "./source-fetcher/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "knowledge-codegraph-"));
  roots.push(root);
  const dir = join(root, "graph");
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".codegraph"), { recursive: true });
  writeFileSync(join(dir, ".git", "HEAD"), "old-commit");
  writeFileSync(join(dir, ".codegraph", "index.db"), "old-index");

  const oldInstance = { projectRoot: dir, cg: {}, handler: {} } as CodeGraphInstance;
  const instances = new Map([["cg-1", oldInstance]]);
  const pause = vi.fn(async () => {});
  const resume = vi.fn();
  const instancePool: CodeGraphInstancePool = {
    get: (id) => instances.get(id),
    set: (id, instance) => { instances.set(id, instance); },
    delete: (id) => { instances.delete(id); },
    pause,
    resume,
  };

  const fetcher = {
    supportedType: "git" as const,
    validate: vi.fn(),
    sync: vi.fn<ISourceFetcher["sync"]>(),
    fetch: vi.fn<ISourceFetcher["fetch"]>(),
  };
  const openIndex = vi.fn(async (path: string) => ({ projectRoot: path, cg: {}, handler: {} }) as CodeGraphInstance);
  const indexProject = vi.fn(async (path: string) => ({ projectRoot: path, cg: {}, handler: {} }) as CodeGraphInstance);
  const syncIndex = vi.fn(async () => ({ changed: 1 }));
  const closeIndex = vi.fn();
  const getStats = vi.fn(() => ({ fileCount: 2, nodeCount: 3, edgeCount: 4 }));
  const worker = createCodeGraphWorker({
    instancePool,
    resolveFetcher: () => fetcher,
    indexOps: { openIndex, indexProject, syncIndex, closeIndex, getStats },
  });
  const ctx = {
    dir,
    repoUrl: "https://example.com/repo.git",
    branch: "main",
    codeGraphId: "cg-1",
    serviceId: "svc-1",
    teamId: "team-1",
    hadReadyIndex: true,
    setInternalStatus: vi.fn(),
  };
  return { root, dir, oldInstance, instancePool, pause, resume, fetcher, openIndex, indexProject, syncIndex, getStats, closeIndex, worker, ctx };
}

describe("existing CodeGraph refresh", () => {
  it("preserves the old checkout, index, and pool entry when both Git operations fail", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "partially-updated");
      throw new Error("temporary Git outage");
    });
    f.fetcher.fetch.mockRejectedValue(new Error("temporary Git outage"));

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("preserves the old index when incremental indexing and fresh clone both fail", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    f.syncIndex.mockRejectedValue(new Error("indexing failed halfway"));
    f.fetcher.fetch.mockRejectedValue(new Error("clone failed"));

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);

    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("promotes a completed incremental index and reopens it at the canonical path", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);

    expect(result).toMatchObject({ commitHash: "new-commit", stats: { files: 2, nodes: 3, edges: 4 } });
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("new-commit");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(f.openIndex).toHaveBeenCalledWith(f.dir);
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(existsSync(`${f.dir}.previous`)).toBe(true);
    await result.finalize?.();
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("rebuilds in isolation after an incremental error and promotes only on success", async () => {
    const f = fixture();
    f.fetcher.sync.mockRejectedValue(new Error("incremental index unavailable"));
    f.fetcher.fetch.mockImplementation(async (_url, _branch, path) => {
      mkdirSync(join(path, ".git"), { recursive: true });
      mkdirSync(join(path, ".codegraph"), { recursive: true });
      writeFileSync(join(path, ".git", "HEAD"), "fresh-commit");
      return { localPath: path, version: "fresh-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);

    expect(result.commitHash).toBe("fresh-commit");
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("fresh-commit");
    expect(existsSync(join(f.dir, ".codegraph"))).toBe(true);
    expect(f.indexProject).toHaveBeenCalledOnce();
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    await result.finalize?.();
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("can roll back a promoted candidate when metadata commit fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);
    await result.rollback?.();

    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("rolls back after promotion even when the metadata store stays unavailable", async () => {
    const f = fixture();
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      writeFileSync(join(path, ".git", "HEAD"), "new-commit");
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);
    f.ctx.setInternalStatus.mockImplementation(() => { throw new Error("metadata store unavailable"); });

    await expect(result.rollback?.()).resolves.toBeUndefined();
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("rolls back the previous index when reopening a promoted candidate fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    let finalOpens = 0;
    f.openIndex.mockImplementation(async (path) => {
      // First canonical open rehydrates the old index after copying. The next
      // one opens the promoted candidate and should exercise rollback.
      if (path === f.dir && finalOpens++ === 1) throw new Error("cannot open promoted index");
      return { projectRoot: path, cg: {}, handler: {} } as CodeGraphInstance;
    });

    await expect(f.worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(f.instancePool.get("cg-1")?.projectRoot).toBe(f.dir);
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
  });

  it("restores the original directory if the second promotion rename fails", async () => {
    const f = fixture();
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });
    let renames = 0;
    const renameDir = vi.fn(async (source: string, destination: string) => {
      if (++renames === 2) throw new Error("candidate rename failed");
      await rename(source, destination);
    });
    const worker = createCodeGraphWorker({
      instancePool: f.instancePool,
      resolveFetcher: () => f.fetcher,
      indexOps: {
        openIndex: f.openIndex,
        indexProject: f.indexProject,
        syncIndex: f.syncIndex,
        getStats: f.getStats,
        closeIndex: f.closeIndex,
      },
      renameDir,
    });

    await expect(worker(f.ctx)).rejects.toBeInstanceOf(PreservedCodeGraphError);
    expect(renameDir).toHaveBeenCalledTimes(3);
    expect(readFileSync(join(f.dir, ".git", "HEAD"), "utf8")).toBe("old-commit");
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("old-index");
    expect(existsSync(`${f.dir}.previous`)).toBe(false);
    expect(readdirSync(f.root)).toEqual(["graph"]);
  });

  it("copies only after closing the old SQLite handle and omits transient lock files", async () => {
    const f = fixture();
    writeFileSync(join(f.dir, ".codegraph", "codegraph.lock"), "stale lock");
    writeFileSync(join(f.dir, ".codegraph", "daemon.pid"), "123");
    writeFileSync(join(f.dir, ".codegraph", "index.log"), "old log");
    f.closeIndex.mockImplementation((instance) => {
      if (instance === f.oldInstance) {
        // Simulate a WAL checkpoint performed by CodeGraph.close().
        writeFileSync(join(f.dir, ".codegraph", "index.db"), "checkpointed");
      }
    });
    f.fetcher.sync.mockImplementation(async (_url, _branch, path) => {
      expect(readFileSync(join(path, ".codegraph", "index.db"), "utf8")).toBe("checkpointed");
      expect(existsSync(join(path, ".codegraph", "codegraph.lock"))).toBe(false);
      expect(existsSync(join(path, ".codegraph", "daemon.pid"))).toBe(false);
      expect(existsSync(join(path, ".codegraph", "index.log"))).toBe(false);
      return { localPath: path, version: "new-commit", sourceType: "git" };
    });

    const result = await f.worker(f.ctx);

    expect(f.ctx.setInternalStatus).toHaveBeenCalledWith("copying");
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    expect(f.pause).toHaveBeenCalledTimes(2);
    expect(f.resume).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(f.dir, ".codegraph", "index.db"), "utf8")).toBe("checkpointed");
    await result.finalize?.();
  });

  it("waits for query leases to drain before closing the old index", async () => {
    const f = fixture();
    let drain!: () => void;
    f.pause.mockImplementationOnce(() => new Promise<void>((resolve) => { drain = resolve; }));
    f.fetcher.sync.mockResolvedValue({ localPath: f.dir, version: "new-commit", sourceType: "git" });

    const pending = f.worker(f.ctx);
    await vi.waitFor(() => expect(f.pause).toHaveBeenCalledOnce());
    expect(f.ctx.setInternalStatus).toHaveBeenCalledWith("copying");
    expect(f.closeIndex).not.toHaveBeenCalledWith(f.oldInstance);
    drain();

    const result = await pending;
    expect(f.closeIndex).toHaveBeenCalledWith(f.oldInstance);
    await result.finalize?.();
  });
});
