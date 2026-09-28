import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDb } from "../db/client.js";
import { BuildQueue } from "./build-queue.js";
import { CodeGraphService } from "./code-graph-service.js";
import { SqliteKnowledgeStore } from "./sqlite-store.js";
import { recoverInterruptedCodeGraphs } from "../code-graph-recovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CodeGraph refresh admission", () => {
  it("admits one of two services sharing a SQLite database and separate queues", async () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-admission-"));
    roots.push(root);
    const path = join(root, "knowledge.sqlite");
    const firstDb = createDb({ path });
    const secondDb = createDb({ path });
    let releaseWorker: (() => void) | undefined;
    const holdWorker = new Promise<void>((resolve) => { releaseWorker = resolve; });
    try {
      const firstStore = new SqliteKnowledgeStore(firstDb.db);
      const secondStore = new SqliteKnowledgeStore(secondDb.db);
      const created = firstStore.createCodeGraph({
        service_id: "svc-1", team_id: "team-1", repo_url: "https://example.com/repo.git", branch: "main",
      }).row;
      firstStore.updateCodeGraphStatus("svc-1", created.code_graph_id, {
        status: "ready", commit_hash: "old-commit", has_last_good: true, last_sync_at: "2026-01-01T00:00:00Z",
      });
      expect(secondStore.tryAdmitCodeGraphSync("another-service", "team-1", created.code_graph_id, created.version)).toBe(false);
      expect(secondStore.tryAdmitCodeGraphSync("svc-1", "another-team", created.code_graph_id, created.version)).toBe(false);
      expect(secondStore.tryAdmitCodeGraphSync("svc-1", "team-1", created.code_graph_id, created.version + 1)).toBe(false);

      const worker = vi.fn(async () => {
        await holdWorker;
        return { commitHash: "new-commit" };
      });
      const first = new CodeGraphService({ store: firstStore, dataRoot: root, queue: new BuildQueue(), worker });
      const second = new CodeGraphService({ store: secondStore, dataRoot: root, queue: new BuildQueue(), worker });

      const [a, b] = await Promise.all([
        first.sync("svc-1", "team-1", created.code_graph_id),
        second.sync("svc-1", "team-1", created.code_graph_id),
      ]);
      expect([a.kind, b.kind].sort()).toEqual(["busy", "ok"]);
      const admitted = firstStore.getCodeGraph("svc-1", "team-1", created.code_graph_id)!;
      expect(admitted.version).toBe(created.version + 1);
      expect(["pending", "processing"]).toContain(admitted.status);
      expect(firstStore.listCodeGraphAudit("svc-1", created.code_graph_id).filter((entry) => entry.action === "ingest")).toHaveLength(1);
      expect(worker).toHaveBeenCalledTimes(1);

      releaseWorker?.();
      await Promise.all([first.onIdle(), second.onIdle()]);
      expect(firstStore.getCodeGraph("svc-1", "team-1", created.code_graph_id)?.status).toBe("ready");
      expect(firstStore.getCodeGraph("svc-1", "team-1", created.code_graph_id)?.has_last_good).toBe(true);
    } finally {
      releaseWorker?.();
      firstDb.raw.close();
      secondDb.raw.close();
    }
  });

  it("backfills the persisted last-good flag only for legacy ready rows", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-migration-"));
    roots.push(root);
    const path = join(root, "knowledge.sqlite");
    const legacy = createDb({ path });
    try {
      // Model a database created before has_last_good was introduced.
      legacy.raw.exec("ALTER TABLE knowledge_code_graph DROP COLUMN has_last_good");
      const insert = legacy.raw.prepare(`
        INSERT INTO knowledge_code_graph
          (code_graph_id, service_id, team_id, repo_url, branch, status, version, created_at, updated_at)
        VALUES (?, 'svc-1', 'team-1', ?, 'main', ?, 0, '2026-01-01', '2026-01-01')
      `);
      insert.run("cg-legacyready", "https://example.com/legacy.git", "ready");
      insert.run("cg-firstbuild", "https://example.com/first.git", "pending");
    } finally {
      legacy.raw.close();
    }

    const migrated = createDb({ path });
    try {
      const store = new SqliteKnowledgeStore(migrated.db);
      expect(store.getCodeGraphById("svc-1", "cg-legacyready")?.last_sync_at).toBeNull();
      expect(store.getCodeGraphById("svc-1", "cg-legacyready")?.has_last_good).toBe(true);
      expect(store.getCodeGraphById("svc-1", "cg-firstbuild")?.has_last_good).toBe(false);
    } finally {
      migrated.raw.close();
    }
  });

  it("recovers an interrupted refresh with no last-sync timestamp but not an initial build", () => {
    const root = mkdtempSync(join(tmpdir(), "knowledge-persisted-recovery-"));
    roots.push(root);
    const connection = createDb({ path: join(root, "knowledge.sqlite") });
    try {
      const store = new SqliteKnowledgeStore(connection.db);
      const makeAsset = (name: string) => store.createCodeGraph({
        service_id: "svc-1", team_id: "team-1", repo_url: `https://example.com/${name}.git`, branch: "main",
      }).row;
      const firstBuild = makeAsset("initial");
      const refreshed = makeAsset("refresh");
      store.updateCodeGraphStatus("svc-1", refreshed.code_graph_id, {
        status: "ready", has_last_good: true, last_sync_at: null,
      });
      expect(store.tryAdmitCodeGraphSync("svc-1", "team-1", refreshed.code_graph_id, refreshed.version)).toBe(true);
      for (const row of [firstBuild, refreshed]) {
        const gitDir = join(root, "svc-1", "team-1", row.code_graph_id, ".git");
        mkdirSync(gitDir, { recursive: true });
        writeFileSync(join(gitDir, "HEAD"), "old-commit");
      }

      expect(store.listRecoverableCodeGraphs().map((row) => row.code_graph_id)).toEqual([refreshed.code_graph_id]);
      expect(recoverInterruptedCodeGraphs(store, root)).toBe(1);
      expect(store.getCodeGraphById("svc-1", refreshed.code_graph_id)?.status).toBe("ready");
      expect(store.getCodeGraphById("svc-1", firstBuild.code_graph_id)?.status).toBe("pending");
      store.markInterruptedAsFailed();
      expect(store.getCodeGraphById("svc-1", firstBuild.code_graph_id)?.status).toBe("failed");
    } finally {
      connection.raw.close();
    }
  });
});
