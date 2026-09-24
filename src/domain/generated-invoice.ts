import { DomainRuleViolation } from "./domain-rule-violation.js";

export interface GeneratedInvoiceReadiness {
  missingFields: string[];
  conflictingFields: string[];
  belowConfidenceFields: string[];
  probableDuplicate: boolean;
}

export interface GeneratedFinalization {
  invoiceId: string;
  officialInvoiceNumber: string;
  lifecycle: "VERIFIED";
  compilationStatus: "PENDING";
  outboxJob: { type: "COMPILE_GENERATED_INVOICE_PDF"; idempotencyKey: string };
}

export function assertGeneratedInvoiceReady(readiness: GeneratedInvoiceReadiness): void {
  const blockers = [
    ...readiness.missingFields,
    ...readiness.conflictingFields,
    ...readiness.belowConfidenceFields,
  ];
  if (blockers.length > 0) {
    throw new DomainRuleViolation("GENERATED_INVOICE_INCOMPLETE", `Generated invoice has blockers: ${blockers.join(", ")}`);
  }
  if (readiness.probableDuplicate) {
    throw new DomainRuleViolation("DUPLICATE_REVIEW_REQUIRED", "A probable duplicate requires an explicit review decision");
  }
}

export function finalizeGeneratedInvoice(input: {
  invoiceId: string;
  reservedNumber: string;
  readiness: GeneratedInvoiceReadiness;
}): GeneratedFinalization {
  assertGeneratedInvoiceReady(input.readiness);
  if (!input.reservedNumber.trim()) {
    throw new DomainRuleViolation("OFFICIAL_NUMBER_REQUIRED", "Finalization requires an atomically reserved Official Invoice Number");
  }
  return {
    invoiceId: input.invoiceId,
    officialInvoiceNumber: input.reservedNumber,
    lifecycle: "VERIFIED",
    compilationStatus: "PENDING",
    outboxJob: {
      type: "COMPILE_GENERATED_INVOICE_PDF",
      idempotencyKey: `generated-invoice:${input.invoiceId}:pdf:v1`,
    },
  };
}
