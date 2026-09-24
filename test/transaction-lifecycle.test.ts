import { describe, expect, it } from "vitest";
import { evaluateConvergence, transitionTransaction } from "../src/domain/transaction-lifecycle.js";

describe("transaction lifecycle", () => {
  it("converges only after all requirements pass", () => {
    const blocked = evaluateConvergence({ requiredArtifacts: ["purchase-agreement", "title-report"], presentArtifacts: ["purchase-agreement"], requiredFields: ["property", "buyer"], resolvedFields: ["property"], conflictingFields: [], belowConfidenceFields: [] });
    expect(blocked).toMatchObject({ converged: false, missingArtifacts: ["title-report"], missingFields: ["buyer"] });
    expect(evaluateConvergence({ requiredArtifacts: ["purchase-agreement"], presentArtifacts: ["purchase-agreement"], requiredFields: ["property"], resolvedFields: ["property"], conflictingFields: [], belowConfidenceFields: [] }).converged).toBe(true);
  });

  it("treats convergence as ready for review, not approval", () => {
    expect(transitionTransaction("ACCUMULATING", { type: "CONVERGENCE_PASSED" })).toBe("CONVERGED");
    expect(transitionTransaction("CONVERGED", { type: "APPROVE", actorId: "reviewer-2", lastMaterialResolverId: "reviewer-1", separationOfDuties: true })).toBe("APPROVED");
  });

  it("enforces separation of duties", () => {
    expect(() => transitionTransaction("CONVERGED", { type: "APPROVE", actorId: "reviewer-1", lastMaterialResolverId: "reviewer-1", separationOfDuties: true })).toThrow(/cannot approve/);
  });

  it("revokes convergence or approval when material evidence arrives", () => {
    expect(transitionTransaction("CONVERGED", { type: "MATERIAL_EVIDENCE_ADDED", createsConflict: false })).toBe("ACCUMULATING");
    expect(transitionTransaction("APPROVED", { type: "MATERIAL_EVIDENCE_ADDED", createsConflict: true })).toBe("AMBIGUOUS");
  });
});
