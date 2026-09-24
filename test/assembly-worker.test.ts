import { describe, expect, it, vi } from "vitest";
import { processAssemblyBatch, type AssemblyBackend, type AssemblyJob } from "../src/workers/assembly-worker.js";

const job: AssemblyJob = { id: "job-1", lockToken: "lease-1" };

function backend(jobs: AssemblyJob[]): AssemblyBackend & { complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn().mockResolvedValue(jobs), complete: vi.fn().mockResolvedValue("invoice-1"), fail: vi.fn().mockResolvedValue(undefined) };
}

describe("assembly worker", () => {
  it("completes claimed assembly jobs", async () => {
    const store = backend([job]);
    expect(await processAssemblyBatch(store, "worker-1")).toBe(1);
    expect(store.complete).toHaveBeenCalledWith(job);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("treats an unrecognized null result as a completed business decision", async () => {
    const store = backend([job]);
    store.complete.mockResolvedValue(null);
    await processAssemblyBatch(store, "worker-1");
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("routes transactional failures through retry handling", async () => {
    const store = backend([job]);
    store.complete.mockRejectedValue(new Error("database unavailable"));
    await processAssemblyBatch(store, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "INVOICE_ASSEMBLY_FAILED");
  });
});
