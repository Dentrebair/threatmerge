import { DomainRuleViolation } from "./domain-rule-violation.js";

export const invoiceLifecycleStates = [
  "INCOMPLETE_DRAFT",
  "SUSPENDED",
  "READY_FOR_VERIFICATION",
  "PENDING_REVIEW",
  "VERIFIED",
  "DISMISSED",
  "VOIDED",
] as const;

export type InvoiceLifecycleState = (typeof invoiceLifecycleStates)[number];

export type InvoiceLifecycleEvent =
  | { type: "VALIDATION_PASSED" }
  | { type: "ROUTE_TO_REVIEW"; reason: string }
  | { type: "AUTO_VERIFY" }
  | { type: "APPROVE" }
  | { type: "TRANSACTION_BECAME_DORMANT" }
  | { type: "TRANSACTION_REACTIVATED" }
  | { type: "DISMISS"; reason: string }
  | { type: "RESTORE" }
  | { type: "VOID_WITH_CORRECTION"; correctionId: string };

const allowedTransitions: Record<
  InvoiceLifecycleState,
  Partial<Record<InvoiceLifecycleEvent["type"], InvoiceLifecycleState>>
> = {
  INCOMPLETE_DRAFT: {
    VALIDATION_PASSED: "READY_FOR_VERIFICATION",
    TRANSACTION_BECAME_DORMANT: "SUSPENDED",
  },
  SUSPENDED: {
    TRANSACTION_REACTIVATED: "INCOMPLETE_DRAFT",
    DISMISS: "DISMISSED",
  },
  READY_FOR_VERIFICATION: {
    ROUTE_TO_REVIEW: "PENDING_REVIEW",
    AUTO_VERIFY: "VERIFIED",
  },
  PENDING_REVIEW: {
    APPROVE: "VERIFIED",
  },
  VERIFIED: {
    VOID_WITH_CORRECTION: "VOIDED",
  },
  DISMISSED: {
    RESTORE: "INCOMPLETE_DRAFT",
  },
  VOIDED: {},
};

export function transitionInvoice(
  current: InvoiceLifecycleState,
  event: InvoiceLifecycleEvent,
): InvoiceLifecycleState {
  const next = allowedTransitions[current][event.type];

  if (next === undefined) {
    throw new DomainRuleViolation(
      "INVALID_INVOICE_TRANSITION",
      `Cannot apply ${event.type} while invoice is ${current}`,
    );
  }

  assertRequiredEventData(event);
  return next;
}

function assertRequiredEventData(event: InvoiceLifecycleEvent): void {
  if (event.type === "ROUTE_TO_REVIEW" || event.type === "DISMISS") {
    if (event.reason.trim().length === 0) {
      throw new DomainRuleViolation(
        "REASON_REQUIRED",
        `${event.type} requires a reason`,
      );
    }
  }

  if (
    event.type === "VOID_WITH_CORRECTION" &&
    event.correctionId.trim().length === 0
  ) {
    throw new DomainRuleViolation(
      "CORRECTION_REQUIRED",
      "Voiding requires an Invoice Correction",
    );
  }
}
