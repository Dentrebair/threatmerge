import { describe, expect, it, vi } from "vitest";
import { createExtractionAdapterHandler, GeminiExtractionEngine, loadExtractionAdapterConfig, type ExtractionEngine } from "../src/services/extraction-adapter.js";

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
    expect(() => loadExtractionAdapterConfig({})).toThrow("EXTRACTION_ADAPTER_TOKEN is required");
    expect(loadExtractionAdapterConfig({ EXTRACTION_ADAPTER_TOKEN: token, GEMINI_API_KEY: "gemini-secret", PORT: "8788" }))
      .toMatchObject({ port: 8788, token, primaryModel: "gemini-3.1-flash-lite", fallbackModel: "gemini-3.5-flash" });
  });

  it("uses Flash Lite first when required fields are reliable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ observations: [
      { fieldName: "documentType", value: "INVOICE", page: 1, confidence: 0.99 },
      { fieldName: "issuer", value: "Acme", page: 1, confidence: 0.91 },
    ] }) }] } }] }), { status: 200 }));
    const extracted = await new GeminiExtractionEngine("key", "gemini-3.1-flash-lite", "gemini-3.5-flash", 1_000)
      .extract(new File(["pdf"], "invoice.pdf", { type: "application/pdf" }));
    expect(extracted.modelVersion).toBe("gemini-3.1-flash-lite");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(request.body as string) as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(body.generationConfig).toHaveProperty("responseJsonSchema");
    expect(body.generationConfig).not.toHaveProperty("responseFormat");
    fetchMock.mockRestore();
  });

  it("falls back to Flash when required fields are weak", async () => {
    const weak = { observations: [{ fieldName: "documentType", value: "INVOICE", page: 1, confidence: 0.6 }] };
    const strong = { observations: [
      { fieldName: "documentType", value: "INVOICE", page: 1, confidence: 0.99 },
      { fieldName: "issuer", value: "Acme", page: 1, confidence: 0.95 },
    ] };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(weak) }] } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(strong) }] } }] }), { status: 200 }));
    const extracted = await new GeminiExtractionEngine("key", "gemini-3.1-flash-lite", "gemini-3.5-flash", 1_000)
      .extract(new File(["pdf"], "invoice.pdf", { type: "application/pdf" }));
    expect(extracted.modelVersion).toBe("gemini-3.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});
