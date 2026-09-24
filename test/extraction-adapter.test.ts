import { describe, expect, it, vi } from "vitest";
import { createExtractionAdapterHandler, loadExtractionAdapterConfig, type ExtractionEngine } from "../src/services/extraction-adapter.js";

const result = { provider: "fixture", modelVersion: "v1", promptVersion: "v1", startedAt: "2026-09-24T08:00:00Z", observations: [] };
const token = "adapter-secret";

function request(file?: File, authorization = `Bearer ${token}`): Request {
  const form = new FormData();
  if (file) form.set("document", file);
  return new Request("http://localhost/extract", { method: "POST", headers: { authorization }, body: form });
}

describe("extraction adapter", () => {
  it("exposes an unauthenticated health check", async () => {
    const handler = createExtractionAdapterHandler({ extract: vi.fn() }, token);
    expect((await handler(new Request("http://localhost/health"))).status).toBe(200);
  });

  it("rejects missing or invalid credentials", async () => {
    const handler = createExtractionAdapterHandler({ extract: vi.fn() }, token);
    expect((await handler(request(new File(["pdf"], "invoice.pdf", { type: "application/pdf" }), "Bearer wrong"))).status).toBe(401);
  });

  it("validates documents before calling the engine", async () => {
    const engine: ExtractionEngine = { extract: vi.fn() };
    const handler = createExtractionAdapterHandler(engine, token);
    expect((await handler(request())).status).toBe(400);
    expect((await handler(request(new File(["text"], "invoice.txt", { type: "text/plain" })))).status).toBe(415);
    expect(engine.extract).not.toHaveBeenCalled();
  });

  it("returns the normalized engine result", async () => {
    const engine: ExtractionEngine = { extract: vi.fn().mockResolvedValue(result) };
    const response = await createExtractionAdapterHandler(engine, token)(request(new File(["pdf"], "invoice.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });

  it("returns a safe provider error without leaking details", async () => {
    const engine: ExtractionEngine = { extract: vi.fn().mockRejectedValue(new Error("private provider detail")) };
    const response = await createExtractionAdapterHandler(engine, token)(request(new File(["pdf"], "invoice.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "extraction_unavailable", message: "Document extraction is temporarily unavailable." });
  });

  it("requires complete Railway configuration", () => {
    expect(() => loadExtractionAdapterConfig({})).toThrow("EXTRACTION_ENGINE_URL is required");
    expect(loadExtractionAdapterConfig({ EXTRACTION_ADAPTER_TOKEN: token, EXTRACTION_ENGINE_URL: "https://engine.example/extract", EXTRACTION_ENGINE_TOKEN: "engine-secret", PORT: "8788" })).toMatchObject({ port: 8788, token });
  });
});
