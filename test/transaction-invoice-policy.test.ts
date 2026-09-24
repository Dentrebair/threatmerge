import { describe, expect, it } from "vitest";
import { invoiceStateAfterTransactionDormancy, invoiceStateAfterTransactionReactivation } from "../src/domain/transaction-invoice-policy.js";

describe("transaction and invoice lifecycle integration", () => {
  it("suspends only linked incomplete invoices", () => {
    expect(invoiceStateAfterTransactionDormancy({ lifecycle: "INCOMPLETE_DRAFT", linkage: "LINKED" })).toBe("SUSPENDED");
    expect(invoiceStateAfterTransactionDormancy({ lifecycle: "INCOMPLETE_DRAFT", linkage: "UNLINKED" })).toBe("INCOMPLETE_DRAFT");
    expect(invoiceStateAfterTransactionDormancy({ lifecycle: "PENDING_REVIEW", linkage: "LINKED" })).toBe("PENDING_REVIEW");
  });

  it("reactivates non-dismissed linked invoices only", () => {
    expect(invoiceStateAfterTransactionReactivation({ lifecycle: "SUSPENDED", linkage: "LINKED", dismissedWhileSuspended: false })).toBe("INCOMPLETE_DRAFT");
    expect(invoiceStateAfterTransactionReactivation({ lifecycle: "SUSPENDED", linkage: "LINKED", dismissedWhileSuspended: true })).toBe("SUSPENDED");
  });
});
