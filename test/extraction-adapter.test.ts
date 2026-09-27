import { describe, expect, it, vi } from "vitest";
import { createExtractionAdapterHandler, GeminiExtractionEngine, loadExtractionAdapterConfig, OpenAIInvoiceValidator, type ExtractionEngine, type InvoiceValidator } from "../src/services/extraction-adapter.js";
import { PDFDocument, StandardFonts } from "pdf-lib";

const result = { provider: "fixture", modelVersion: "v1", promptVersion: "v1", startedAt: "2026-09-24T08:00:00Z", observations: [] };
const token = "adapter-secret";
const accepted: InvoiceValidator = { validate: vi.fn().mockResolvedValue({ accepted: true, reason: "Invoice signals found" }) };

function request(file?: File, authorization = `Bearer ${token}`): Request {
  const form = new FormData();
  if (file) form.set("document", file);
  return new Request("http://localhost/extract", { method: "POST", headers: { authorization }, body: form });
}

async function validPdf(): Promise<File> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Invoice INV-42 total 100.00", { x: 30, y: 700, font });
  return new File([Buffer.from(await pdf.save())], "invoice.pdf", { type: "application/pdf" });
}

describe("extraction adapter", () => {
  it("exposes an unauthenticated health check", async () => {
    const handler = createExtractionAdapterHandler({ extract: vi.fn() }, accepted, token);
    expect((await handler(new Request("http://localhost/health"))).status).toBe(200);
  });

  it("rejects missing or invalid credentials", async () => {
    const handler = createExtractionAdapterHandler({ extract: vi.fn() }, accepted, token);
    expect((await handler(request(new File(["pdf"], "invoice.pdf", { type: "application/pdf" }), "Bearer wrong"))).status).toBe(401);
  });

  it("validates documents before calling the engine", async () => {
    const engine: ExtractionEngine = { extract: vi.fn() };
    const handler = createExtractionAdapterHandler(engine, accepted, token);
    expect((await handler(request())).status).toBe(400);
    expect((await handler(request(new File(["text"], "invoice.txt", { type: "text/plain" })))).status).toBe(415);
    expect(engine.extract).not.toHaveBeenCalled();
  });

  it("returns the normalized engine result", async () => {
    const invoiceResult = { ...result, observations: [{ fieldName: "documentType", value: "INVOICE", sourceLocation: { page: 1 }, confidence: 0.99 }] };
    const engine: ExtractionEngine = { extract: vi.fn().mockResolvedValue(invoiceResult) };
    const response = await createExtractionAdapterHandler(engine, accepted, token)(request(new File(["pdf"], "invoice.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(invoiceResult);
  });

  it("rejects a file when extraction cannot confirm it is an invoice", async () => {
    const engine: ExtractionEngine = { extract: vi.fn().mockResolvedValue(result) };
    const response = await createExtractionAdapterHandler(engine, accepted, token)(request(new File(["plan"], "action-plan.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "not_an_invoice", message: "This file is not an invoice. Upload the correct invoice." });
  });

  it("returns a safe provider error without leaking details", async () => {
    const engine: ExtractionEngine = { extract: vi.fn().mockRejectedValue(new Error("private provider detail")) };
    const response = await createExtractionAdapterHandler(engine, accepted, token)(request(new File(["pdf"], "invoice.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "extraction_unavailable", message: "Document extraction is temporarily unavailable." });
  });

  it("requires complete Railway configuration", () => {
    expect(() => loadExtractionAdapterConfig({})).toThrow("EXTRACTION_ADAPTER_TOKEN is required");
    expect(loadExtractionAdapterConfig({ EXTRACTION_ADAPTER_TOKEN: token, OPENAI_API_KEY: "openai-secret", GEMINI_API_KEY: "gemini-secret", PORT: "8788" }))
      .toMatchObject({ port: 8788, token, validationModel: "gpt-5.4-mini", primaryModel: "gemini-3.1-flash-lite", fallbackModel: "gemini-3.5-flash" });
  });

  it("rejects a non-invoice before extraction", async () => {
    const engine: ExtractionEngine = { extract: vi.fn() };
    const validator: InvoiceValidator = { validate: vi.fn().mockResolvedValue({ accepted: false, reason: "Unrelated photo" }) };
    const response = await createExtractionAdapterHandler(engine, validator, token)(request(new File(["photo"], "garden.png", { type: "image/png" })));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "not_an_invoice", message: "This file is not an invoice. Upload the correct invoice." });
    expect(engine.extract).not.toHaveBeenCalled();
  });

  it("uses the configured model for structured vision validation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ decision: "ACCEPT", reason: "Invoice number and total visible", evidenceSignals: ["issuer", "invoice number", "total"], invoiceCount: 1 }) }] }] }), { status: 200 }));
    const validation = await new OpenAIInvoiceValidator("openai-key", "test-validation-model").validate(new File(["image"], "invoice.png", { type: "image/png" }));
    expect(validation.accepted).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as { model: string; input: Array<{ content: Array<{ type: string }> }>; text: { format: { type: string } } };
    expect(body.model).toBe("test-validation-model");
    expect(body.input[0]?.content[0]?.type).toBe("input_image");
    expect(body.text.format.type).toBe("json_schema");
    fetchMock.mockRestore();
  });

  it("rejects multi-invoice files with a corrective action", async () => {
    const engine: ExtractionEngine = { extract: vi.fn() };
    const validator: InvoiceValidator = { validate: vi.fn().mockResolvedValue({ accepted: false, reason: "Two invoices found", invoiceCount: 2 }) };
    const response = await createExtractionAdapterHandler(engine, validator, token)(request(new File(["pdf"], "combined.pdf", { type: "application/pdf" })));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "multiple_invoices", message: "This file contains multiple invoices. Upload each invoice separately." });
    expect(engine.extract).not.toHaveBeenCalled();
  });

  it("uses Flash Lite first when required fields are reliable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ observations: [
      { fieldName: "documentType", value: "INVOICE", page: 1, confidence: 0.99 },
      { fieldName: "issuer", value: "Acme", page: 1, confidence: 0.91 },
      { fieldName: "invoiceNumber", value: "INV-42", page: 1, confidence: 0.98 },
      { fieldName: "lineItems", value: [{ description: "Inspection", quantity: "1", unitPrice: "100", amount: "100" }], page: 1, confidence: 0.96 },
      { fieldName: "total", value: "100.00", page: 1, confidence: 0.98 },
    ] }) }] } }] }), { status: 200 }));
    const extracted = await new GeminiExtractionEngine("key", "gemini-3.1-flash-lite", "gemini-3.5-flash", 1_000)
      .extract(await validPdf());
    expect(extracted.modelVersion).toBe("gemini-3.1-flash-lite");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(request.body as string) as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(body.generationConfig).not.toHaveProperty("responseSchema");
    expect(body.generationConfig).not.toHaveProperty("responseJsonSchema");
    expect(body.generationConfig).not.toHaveProperty("responseFormat");
    fetchMock.mockRestore();
  });

  it("falls back to Flash when required fields are weak", async () => {
    const weak = { observations: [
      { fieldName: "documentType", value: "INVOICE", page: 1, confidence: 0.99 },
      { fieldName: "issuer", value: "Alpha Office Supplies", page: 1, confidence: 0.99 },
      { fieldName: "lineItems", value: [{ description: "Printer Paper", quantity: "2", unitPrice: "500", amount: "1000" }], page: 1, confidence: 0.96 },
      { fieldName: "total", value: "1180.00", page: 1, confidence: 0.98 },
    ] };
    const strong = { observations: [
      { fieldName: "documentType", value: "INVOICE", page: 1, confidence: 0.99 },
      { fieldName: "issuer", value: "Acme", page: 1, confidence: 0.95 },
      { fieldName: "invoiceNumber", value: "INV-001", page: 1, confidence: 0.98 },
      { fieldName: "lineItems", value: [{ description: "Inspection", quantity: "1", unitPrice: "100", amount: "100" }], page: 1, confidence: 0.96 },
      { fieldName: "total", value: "100.00", page: 1, confidence: 0.98 },
    ] };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(weak) }] } }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(strong) }] } }] }), { status: 200 }));
    const extracted = await new GeminiExtractionEngine("key", "gemini-3.1-flash-lite", "gemini-3.5-flash", 1_000)
      .extract(await validPdf());
    expect(extracted.modelVersion).toBe("gemini-3.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });
});
