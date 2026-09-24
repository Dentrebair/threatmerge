import { DomainRuleViolation } from "./domain-rule-violation.js";

export const transactionLifecycleStates = [
  "INGESTED",
  "ACCUMULATING",
  "AMBIGUOUS",
  "CONVERGED",
  "APPROVED",
  "DORMANT",
  "ARCHIVED",
] as const;

export type TransactionLifecycleState = (typeof transactionLifecycleStates)[number];

export type TransactionLifecycleEvent =
  | { type: "BEGIN_ACCUMULATION" }
  | { type: "LINKAGE_BECAME_AMBIGUOUS" }
  | { type: "AMBIGUITY_RESOLVED" }
  | { type: "CONVERGENCE_PASSED" }
  | { type: "APPROVE"; actorId: string; lastMaterialResolverId?: string; separationOfDuties: boolean }
  | { type: "MATERIAL_EVIDENCE_ADDED"; createsConflict: boolean }
  | { type: "INACTIVITY_PERIOD_ELAPSED" }
  | { type: "REACTIVATE" }
  | { type: "ARCHIVE" };

export function transitionTransaction(
  current: TransactionLifecycleState,
  event: TransactionLifecycleEvent,
): TransactionLifecycleState {
  if (event.type === "APPROVE") {
    if (current !== "CONVERGED") return invalid(current, event.type);
    if (event.separationOfDuties && event.actorId === event.lastMaterialResolverId) {
      throw new DomainRuleViolation("SEPARATION_OF_DUTIES", "The material resolver cannot approve this Transaction File version");
    }
    return "APPROVED";
  }

  if (event.type === "MATERIAL_EVIDENCE_ADDED") {
    if (current === "CONVERGED" || current === "APPROVED") {
      return event.createsConflict ? "AMBIGUOUS" : "ACCUMULATING";
    }
    if (current === "ARCHIVED") return "ARCHIVED";
    return invalid(current, event.type);
  }

  const transitions: Partial<Record<TransactionLifecycleState, Partial<Record<TransactionLifecycleEvent["type"], TransactionLifecycleState>>>> = {
    INGESTED: { BEGIN_ACCUMULATION: "ACCUMULATING" },
    ACCUMULATING: { LINKAGE_BECAME_AMBIGUOUS: "AMBIGUOUS", CONVERGENCE_PASSED: "CONVERGED", INACTIVITY_PERIOD_ELAPSED: "DORMANT" },
    AMBIGUOUS: { AMBIGUITY_RESOLVED: "ACCUMULATING" },
    DORMANT: { REACTIVATE: "ACCUMULATING" },
    APPROVED: { ARCHIVE: "ARCHIVED" },
  };
  const next = transitions[current]?.[event.type];
  return next ?? invalid(current, event.type);
}

function invalid(current: TransactionLifecycleState, event: string): never {
  throw new DomainRuleViolation("INVALID_TRANSACTION_TRANSITION", `Cannot apply ${event} while Transaction File is ${current}`);
}

export interface ConvergenceInput {
  requiredArtifacts: readonly string[];
  presentArtifacts: readonly string[];
  requiredFields: readonly string[];
  resolvedFields: readonly string[];
  conflictingFields: readonly string[];
  belowConfidenceFields: readonly string[];
}

export interface ConvergenceResult {
  converged: boolean;
  missingArtifacts: string[];
  missingFields: string[];
  conflictingFields: string[];
  belowConfidenceFields: string[];
}

export function evaluateConvergence(input: ConvergenceInput): ConvergenceResult {
  const present = new Set(input.presentArtifacts);
  const resolved = new Set(input.resolvedFields);
  const result = {
    missingArtifacts: input.requiredArtifacts.filter((artifact) => !present.has(artifact)),
    missingFields: input.requiredFields.filter((field) => !resolved.has(field)),
    conflictingFields: [...input.conflictingFields],
    belowConfidenceFields: [...input.belowConfidenceFields],
  };
  return { ...result, converged: Object.values(result).every((items) => items.length === 0) };
}
