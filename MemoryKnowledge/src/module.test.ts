import { describe, expect, it, vi } from "vitest";

import { createCodeGraphInstancePool } from "./module.js";
import type { CodeGraphInstance } from "./engines/code/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function instance(name: string): CodeGraphInstance {
  return { projectRoot: name, cg: {}, handler: {} };
}

describe("CodeGraph instance pool lifecycle gate", () => {
  it("blocks new queries and lazy loads while pause waits for a query lease", async () => {
    const openIndex = vi.fn(async () => instance("unexpected"));
    const pool = createCodeGraphInstancePool({ openIndex, closeIndex: vi.fn() });
    const old = instance("old");
    pool.set("graph", old);

    const lease = pool.acquire("graph");
    expect(lease?.instance).toBe(old);
    const paused = pool.pause("graph");
    let drained = false;
    void paused.then(() => { drained = true; });

    expect(pool.acquire("graph")).toBeUndefined();
    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();
    expect(openIndex).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(drained).toBe(false);

    lease?.release();
    lease?.release(); // Releasing twice must not let another active query through.
    await paused;
    expect(drained).toBe(true);
    pool.set("graph", instance("new"));
    expect(pool.acquire("graph")).toBeUndefined();
    pool.resume("graph");
    const newLease = pool.acquire("graph");
    expect(newLease?.instance.projectRoot).toBe("new");
    newLease?.release();
  });

  it("waits for an in-flight lazy open and closes its handle when pause wins", async () => {
    const opening = deferred<CodeGraphInstance>();
    const fresh = instance("fresh");
    const openIndex = vi.fn()
      .mockImplementationOnce(() => opening.promise)
      .mockResolvedValue(fresh);
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({ openIndex, closeIndex });

    const first = pool.loadIfMissing("graph", "/old");
    const second = pool.loadIfMissing("graph", "/old");
    expect(openIndex).toHaveBeenCalledTimes(1);
    const paused = pool.pause("graph");
    let drained = false;
    void paused.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(await pool.loadIfMissing("graph", "/old")).toBeUndefined();

    const obsolete = instance("obsolete");
    opening.resolve(obsolete);
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    await paused;
    expect(closeIndex).toHaveBeenCalledExactlyOnceWith(obsolete);
    expect(pool.get("graph")).toBeUndefined();

    pool.resume("graph");
    expect(await pool.loadIfMissing("graph", "/fresh")).toBe(fresh);
    expect(pool.get("graph")).toBe(fresh);
    expect(openIndex).toHaveBeenCalledTimes(2);
  });

  it("does not replace a handle installed while lazy open is pending", async () => {
    const opening = deferred<CodeGraphInstance>();
    const closeIndex = vi.fn();
    const pool = createCodeGraphInstancePool({ openIndex: vi.fn(() => opening.promise), closeIndex });
    const pending = pool.loadIfMissing("graph", "/old");
    const promoted = instance("promoted");
    pool.set("graph", promoted);

    const obsolete = instance("obsolete");
    opening.resolve(obsolete);
    expect(await pending).toBe(promoted);
    expect(pool.get("graph")).toBe(promoted);
    expect(closeIndex).toHaveBeenCalledExactlyOnceWith(obsolete);
  });

  it("rejects pause if a discarded lazy handle cannot be closed", async () => {
    const opening = deferred<CodeGraphInstance>();
    const closeError = new Error("SQLite handle is still open");
    const pool = createCodeGraphInstancePool({
      openIndex: vi.fn(() => opening.promise),
      closeIndex: vi.fn(() => { throw closeError; }),
    });
    const loading = pool.loadIfMissing("graph", "/old");
    const paused = pool.pause("graph");
    opening.resolve(instance("obsolete"));

    const outcomes = await Promise.allSettled([loading, paused]);
    expect(outcomes).toEqual([
      { status: "rejected", reason: closeError },
      { status: "rejected", reason: closeError },
    ]);
    expect(pool.get("graph")).toBeUndefined();
  });
});
