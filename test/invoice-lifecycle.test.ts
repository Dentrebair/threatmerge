import { describe, expect, it } from "vitest";
import { DomainRuleViolation } from "../src/domain/domain-rule-violation.js";
import { transitionInvoice } from "../src/domain/invoice-lifecycle.js";

describe("invoice lifecycle", () => {
  it("routes a valid invoice through mandatory review", () => {
    const ready = transitionInvoice("INCOMPLETE_DRAFT", {
      type: "VALIDATION_PASSED",
    });
    const pending = transitionInvoice(ready, {
      type: "ROUTE_TO_REVIEW",
      reason: "Tenant requires review",
    });
    expect(transitionInvoice(pending, { type: "APPROVE" })).toBe("VERIFIED");
  });

  it("supports automatic verification only from ready", () => {
    expect(
      transitionInvoice("READY_FOR_VERIFICATION", { type: "AUTO_VERIFY" }),
    ).toBe("VERIFIED");
    expect(() =>
      transitionInvoice("INCOMPLETE_DRAFT", { type: "AUTO_VERIFY" }),
    ).toThrow(DomainRuleViolation);
  });

  it("requires a correction to void a verified invoice", () => {
    expect(() =>
      transitionInvoice("VERIFIED", {
        type: "VOID_WITH_CORRECTION",
        correctionId: "",
      }),
    ).toThrowError(/requires an Invoice Correction/);
    expect(
      transitionInvoice("VERIFIED", {
        type: "VOID_WITH_CORRECTION",
        correctionId: "correction-1",
      }),
    ).toBe("VOIDED");
  });

  it("suspends only incomplete drafts when a transaction becomes dormant", () => {
    expect(
      transitionInvoice("INCOMPLETE_DRAFT", {
        type: "TRANSACTION_BECAME_DORMANT",
      }),
    ).toBe("SUSPENDED");
    expect(() =>
      transitionInvoice("PENDING_REVIEW", {
        type: "TRANSACTION_BECAME_DORMANT",
      }),
    ).toThrowError(/Cannot apply/);
  });
});
