import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodeGraphService, PreservedCodeGraphError } from "./code-graph-service.js";
import { createCodeGraphRoutes } from "../routes/code-graph.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { CodeGraphRow, IKnowledgeStore } from "./types.js";

const cleanupProbe = vi.hoisted(() => ({ failPreviousRemoval: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (cleanupProbe.failPreviousRemoval && String(args[0]).endsWith(".previous")) {
        throw new Error("previous directory is busy");
      }
      return actual.rm(...args);
    },
  };
});
afterEach(() => { cleanupProbe.failPreviousRemoval = false; vi.unstubAllGlobals(); });

function fixture(lastSyncAt: string | null) {
  const row: CodeGraphRow = {
    code_graph_id: "cg-1", service_id: "svc-1", team_id: "team-1",
    repo_name: "repo", repo_url: "https://example.com/repo.git", branch: "main",
    commit_hash: lastSyncAt ? "old-commit" : null,
    owner_user_id: null, user_id: null, agent_id: null, task_id: null,
    visibility: "private", status: lastSyncAt ? "ready" : "pending",
    internal_status: null, sync_error: null,
    stats_json: lastSyncAt ? '{"files":2,"nodes":3,"edges":4}' : null,
    service_url: null, summary: "Existing summary", version: 1,
    has_last_good: lastSyncAt !== null,
    last_sync_at: lastSyncAt, created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", deleted_at: null,
  };
  const audits: Array<{ action: string; version: number }> = [];
  const store = {
    createCodeGraph: () => ({ row, existed: false }),
    getCodeGraph: () => row,
    getCodeGraphById: () => row,
    updateCodeGraphStatus: (_serviceId: string, _id: string, patch: Partial<CodeGraphRow>) => { Object.assign(row, patch); },
    tryAdmitCodeGraphSync: (_serviceId: string, _teamId: string, _id: string, version: number) => {
      if ((row.status !== "ready" && row.status !== "failed") || row.version !== version) return false;
      Object.assign(row, { status: "pending", internal_status: null, sync_error: null, version: version + 1 });
      return true;
    },
    appendCodeGraphAudit: (entry: { action: string; version: number }) => { audits.push(entry); },
    listSyncedCodeGraphs: () => row.status === "ready" ? [{
      code_graph_id: row.code_graph_id, service_id: row.service_id, team_id: row.team_id,
    }] : [],
  } as unknown as IKnowledgeStore;
  return { row, store, audits };
}

describe("CodeGraphService refresh failure", () => {
  it("keeps a preserved last-good build ready and eligible for auto-sync", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });

    expect((await service.sync("svc-1", "team-1", "cg-1")).kind).toBe("ok");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(row.sync_error).toBe("Git unavailable");
    expect(row.commit_hash).toBe("old-commit");
    expect(row.stats_json).toBe('{"files":2,"nodes":3,"edges":4}');
    expect(row.last_sync_at).toBe("2026-01-01T00:00:00Z");
    expect(store.listSyncedCodeGraphs()).toHaveLength(1);

    const previousInstance = {
      projectRoot: "/unused/svc-1/team-1/cg-1", cg: {},
      handler: { execute: async () => ({ content: [{ text: "old index still answers" }], isError: false }) },
    };
    const pool = {
      get: () => previousInstance, set: () => {}, delete: () => {},
    } as CodeGraphInstancePool;
    const routes = createCodeGraphRoutes({ cgService: service, instancePool: pool, publicBaseUrl: "" });
    const response = await routes.request("/status", {
      method: "POST", headers: { "content-type": "application/json", "x-tdai-service-id": "svc-1" },
      body: JSON.stringify({ code_graph_id: "cg-1" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).data.text).toBe("old index still answers");
  });

  it("clears a retired snapshot after admission but before starting the worker", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-service-"));
    const previousDir = join(root, "svc-1", "team-1", "cg-1.previous");
    mkdirSync(previousDir, { recursive: true });
    try {
      const service = new CodeGraphService({
        store, dataRoot: root,
        worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
      });

      await service.sync("svc-1", "team-1", "cg-1");
      expect(existsSync(previousDir)).toBe(false);
      await service.onIdle("cg-1");
      expect(row.status).toBe("ready");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues an admitted refresh when retired snapshot cleanup fails", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const warnings: string[] = [];
    let called = 0;
    const service = new CodeGraphService({
      store, dataRoot: "/unused", logger: { warn: (msg) => warnings.push(msg) },
      worker: async () => { called++; throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });
    cleanupProbe.failPreviousRemoval = true;

    expect((await service.sync("svc-1", "team-1", "cg-1")).kind).toBe("ok");
    await service.onIdle("cg-1");

    expect(called).toBe(1);
    expect(row.status).toBe("ready");
    expect(warnings.some((msg) => msg.includes("previous directory is busy"))).toBe(true);
  });

  it("reports preserved refresh failure distinctly to audit and Panel", async () => {
    const { row, store, audits } = fixture("2026-01-01T00:00:00Z");
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", send);
    const service = new CodeGraphService({
      store, dataRoot: "/unused", callbackConfig: { tmcCallbackUrl: "https://example.com" },
      worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(audits.map((entry) => entry.action)).toEqual(["ingest", "refresh_failed"]);
    expect(send).toHaveBeenCalledOnce();
    const payload = JSON.parse((send.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(payload).toMatchObject({ status: "ready", event: "refresh_failed", sync_error: "Git unavailable" });
  });

  it("keeps an initial build failure unavailable", async () => {
    const { row, store } = fixture(null);
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new Error("Git unavailable"); },
    });

    service.create({ service_id: "svc-1", team_id: "team-1", repo_url: row.repo_url, branch: "main" });
    await service.onIdle("cg-1");

    expect(row.status).toBe("failed");
    expect(row.sync_error).toBe("Git unavailable");
    expect(store.listSyncedCodeGraphs()).toHaveLength(0);
  });

  it("does not infer a last-good index from a first-build preservation error", async () => {
    const { row, store } = fixture(null);
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new PreservedCodeGraphError(new Error("No committed build")); },
    });

    service.create({ service_id: "svc-1", team_id: "team-1", repo_url: row.repo_url, branch: "main" });
    await service.onIdle("cg-1");

    expect(row.status).toBe("failed");
  });

  it("uses the admitted ready state even when legacy metadata has no last-sync timestamp", async () => {
    const { row, store } = fixture(null);
    row.status = "ready";
    row.commit_hash = "old-commit";
    row.has_last_good = true;
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new PreservedCodeGraphError(new Error("Git unavailable")); },
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("old-commit");
  });

  it("does not claim readiness when a refresh cannot preserve the previous index", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const service = new CodeGraphService({
      store, dataRoot: "/unused", worker: async () => { throw new Error("rollback failed"); },
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("failed");
    expect(row.sync_error).toBe("rollback failed");
  });

  it("removes the retired snapshot only after the new metadata is committed", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const observedStatuses: string[] = [];
    const service = new CodeGraphService({
      store, dataRoot: "/unused",
      worker: async () => ({
        commitHash: "new-commit", stats: { files: 4, nodes: 5, edges: 6 },
        finalize: () => { observedStatuses.push(row.status); },
      }),
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(observedStatuses).toEqual(["ready"]);
    expect(row.commit_hash).toBe("new-commit");
  });

  it("rolls back a promoted index if the metadata commit fails", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const update = store.updateCodeGraphStatus.bind(store);
    let commitFailed = false;
    store.updateCodeGraphStatus = (serviceId, id, patch) => {
      if (patch.commit_hash === "new-commit" && !commitFailed) {
        commitFailed = true;
        throw new Error("SQLite write failed");
      }
      update(serviceId, id, patch);
    };
    let rolledBack = false;
    const service = new CodeGraphService({
      store, dataRoot: "/unused",
      worker: async () => ({
        commitHash: "new-commit", stats: { files: 4, nodes: 5, edges: 6 },
        rollback: async () => { rolledBack = true; },
      }),
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(rolledBack).toBe(true);
    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("old-commit");
    expect(row.sync_error).toBe("SQLite write failed");
  });

  it("keeps the committed index ready when a post-build summary hook fails", async () => {
    const { row, store } = fixture("2026-01-01T00:00:00Z");
    const update = store.updateCodeGraphStatus.bind(store);
    store.updateCodeGraphStatus = (serviceId, id, patch) => {
      if (patch.summary !== undefined) throw new Error("summary write failed");
      update(serviceId, id, patch);
    };
    const service = new CodeGraphService({
      store, dataRoot: "/unused",
      callbackConfig: { tmcCallbackUrl: "http://example.invalid" },
      worker: async () => ({ commitHash: "new-commit", stats: { files: 4, nodes: 5, edges: 6 } }),
    });

    await service.sync("svc-1", "team-1", "cg-1");
    await service.onIdle("cg-1");

    expect(row.status).toBe("ready");
    expect(row.commit_hash).toBe("new-commit");
  });

  it("removes orphaned candidate directories when an asset is deleted", () => {
    const { store } = fixture("2026-01-01T00:00:00Z");
    const root = mkdtempSync(join(tmpdir(), "knowledge-candidate-delete-"));
    const candidate = join(root, "svc-1", "team-1", ".cg-1.candidate-1234");
    mkdirSync(candidate, { recursive: true });
    try {
      const service = new CodeGraphService({ store, dataRoot: root, worker: async () => ({}) });
      expect(service.delete("svc-1", "team-1", "cg-1")).toBe(true);
      expect(existsSync(candidate)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
