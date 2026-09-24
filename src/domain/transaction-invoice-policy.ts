import type { InvoiceLifecycleState } from "./invoice-lifecycle.js";
import { transitionInvoice } from "./invoice-lifecycle.js";

export type InvoiceLinkageStatus = "UNLINKED" | "AMBIGUOUS" | "LINKED";

export function invoiceStateAfterTransactionDormancy(input: {
  lifecycle: InvoiceLifecycleState;
  linkage: InvoiceLinkageStatus;
}): InvoiceLifecycleState {
  if (input.linkage !== "LINKED" || input.lifecycle !== "INCOMPLETE_DRAFT") {
    return input.lifecycle;
  }
  return transitionInvoice(input.lifecycle, { type: "TRANSACTION_BECAME_DORMANT" });
}

export function invoiceStateAfterTransactionReactivation(input: {
  lifecycle: InvoiceLifecycleState;
  linkage: InvoiceLinkageStatus;
  dismissedWhileSuspended: boolean;
}): InvoiceLifecycleState {
  if (input.linkage !== "LINKED" || input.lifecycle !== "SUSPENDED" || input.dismissedWhileSuspended) {
    return input.lifecycle;
  }
  return transitionInvoice(input.lifecycle, { type: "TRANSACTION_REACTIVATED" });
}
