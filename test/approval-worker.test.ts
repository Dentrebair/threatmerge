import { describe, expect, it, vi } from "vitest";
import { processApprovalBatch, runApprovalWorker, type ApprovalBackend } from "../src/workers/approval-worker.js";

const job = { id: "job-1", lockToken: "lease-1" };
function backend(): ApprovalBackend & { route: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn().mockResolvedValue([job]), route: vi.fn().mockResolvedValue("PENDING_REVIEW"), fail: vi.fn().mockResolvedValue(undefined) };
}

describe("approval worker", () => {
  it("routes a claimed invoice", async () => {
    const store = backend();
    expect(await processApprovalBatch(store, "worker-1")).toBe(1);
    expect(store.route).toHaveBeenCalledWith(job);
    expect(store.fail).not.toHaveBeenCalled();
  });
  it("records routing failures for retry", async () => {
    const store = backend();
    store.route.mockRejectedValue(new Error("policy unavailable"));
    await processApprovalBatch(store, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "APPROVAL_ROUTING_FAILED");
  });
  it("keeps polling after an idle batch", async () => {
    const store = backend(); vi.mocked(store.claim).mockResolvedValue([]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runApprovalWorker(store, "worker-1", { maxCycles: 2, sleep });
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000, undefined);
  });
});
