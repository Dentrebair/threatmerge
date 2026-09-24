import { describe, expect, it, vi } from "vitest";
import { processExtractionBatch, validateExtractionResult, type DocumentExtractor, type ExtractionBackend, type ExtractionJob } from "../src/workers/extraction-worker.js";

const job: ExtractionJob = { id: "job-1", aggregateId: "artifact-1", lockToken: "lease-1" };
const validResult = {
  provider: "fixture",
  modelVersion: "model-v1",
  promptVersion: "prompt-v1",
  startedAt: "2026-09-22T12:00:00.000Z",
  observations: [{ fieldName: "invoiceNumber", value: "INV-42", sourceLocation: { page: 1 }, confidence: 0.97 }],
};

function backend(jobs: ExtractionJob[]): ExtractionBackend & { complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn().mockResolvedValue(jobs), download: vi.fn().mockResolvedValue(new Blob(["invoice"])), complete: vi.fn().mockResolvedValue(undefined), fail: vi.fn().mockResolvedValue(undefined) };
}

describe("extraction worker", () => {
  it("persists schema-valid observations with run metadata", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockResolvedValue(validResult) };
    expect(await processExtractionBatch(store, extractor, "worker-1")).toBe(1);
    expect(store.complete).toHaveBeenCalledWith(job, validResult);
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("rejects out-of-range confidence before persistence", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockResolvedValue({ ...validResult, observations: [{ ...validResult.observations[0], confidence: 1.1 }] }) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "INVALID_EXTRACTION_RESPONSE");
    expect(store.complete).not.toHaveBeenCalled();
  });

  it("rejects more than 200 observations", () => {
    expect(() => validateExtractionResult({ ...validResult, observations: Array.from({ length: 201 }, () => validResult.observations[0]) })).toThrow("observation count");
  });

  it("records provider outages as retryable failures", async () => {
    const store = backend([job]);
    const extractor: DocumentExtractor = { extract: vi.fn().mockRejectedValue(new Error("extractor unavailable (503)")) };
    await processExtractionBatch(store, extractor, "worker-1");
    expect(store.fail).toHaveBeenCalledWith(job, "EXTRACTOR_UNAVAILABLE");
  });
});
