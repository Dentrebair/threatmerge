import { describe, expect, it } from "vitest";
import { proposeEvidenceLink, type ResolutionProfile } from "../src/domain/evidence-resolution.js";

const profile: ResolutionProfile = {
  weights: { attribute: 0.4, semantic: 0.3, temporal: 0.2, graph: 0.1 },
  autoLinkThreshold: 0.82,
  reviewThreshold: 0.62,
  winningMargin: 0.08,
};

describe("evidence resolution", () => {
  it("auto-links a clear winner", () => {
    expect(proposeEvidenceLink([{ candidateId: "a", attribute: 1, semantic: .9, temporal: .9, graph: .8, hardContradiction: false }], profile)).toMatchObject({ outcome: "AUTO_LINK", candidateId: "a" });
  });

  it("returns ambiguity for a near tie", () => {
    const result = proposeEvidenceLink([
      { candidateId: "a", attribute: .9, semantic: .9, temporal: .8, graph: .8, hardContradiction: false },
      { candidateId: "b", attribute: .9, semantic: .85, temporal: .8, graph: .8, hardContradiction: false },
    ], profile);
    expect(result.outcome).toBe("AMBIGUOUS");
  });

  it("vetoes candidates with a hard contradiction", () => {
    expect(proposeEvidenceLink([{ candidateId: "a", attribute: 1, semantic: 1, temporal: 1, graph: 1, hardContradiction: true }], profile).outcome).toBe("NO_MATCH");
  });
});
