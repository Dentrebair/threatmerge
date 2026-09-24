import { describe, expect, it } from "vitest";
import { assertGeneratedInvoiceReady, finalizeGeneratedInvoice } from "../src/domain/generated-invoice.js";

const ready = { missingFields: [], conflictingFields: [], belowConfidenceFields: [], probableDuplicate: false };

describe("generated invoice finalization", () => {
  it("does not require a source invoice number but creates a compilation job", () => {
    expect(finalizeGeneratedInvoice({ invoiceId: "inv-1", reservedNumber: "CLI-2026-0001", readiness: ready })).toEqual({
      invoiceId: "inv-1",
      officialInvoiceNumber: "CLI-2026-0001",
      lifecycle: "VERIFIED",
      compilationStatus: "PENDING",
      outboxJob: { type: "COMPILE_GENERATED_INVOICE_PDF", idempotencyKey: "generated-invoice:inv-1:pdf:v1" },
    });
  });

  it("rejects missing or conflicting required fields", () => {
    expect(() => assertGeneratedInvoiceReady({ ...ready, conflictingFields: ["total"] })).toThrow(/total/);
  });

  it("rejects finalization without a reserved official number", () => {
    expect(() => finalizeGeneratedInvoice({ invoiceId: "inv-1", reservedNumber: "", readiness: ready })).toThrow(/Official Invoice Number/);
  });
});
