import { DomainRuleViolation } from "./domain-rule-violation.js";

export interface LinkScore {
  candidateId: string;
  attribute: number;
  semantic: number;
  temporal: number;
  graph: number;
  hardContradiction: boolean;
}

export interface ResolutionProfile {
  weights: { attribute: number; semantic: number; temporal: number; graph: number };
  autoLinkThreshold: number;
  reviewThreshold: number;
  winningMargin: number;
}

export type ResolutionProposal =
  | { outcome: "AUTO_LINK"; candidateId: string; score: number }
  | { outcome: "AMBIGUOUS"; candidates: Array<{ candidateId: string; score: number }>; reason: string }
  | { outcome: "NO_MATCH"; reason: string };

export function proposeEvidenceLink(
  candidates: LinkScore[],
  profile: ResolutionProfile,
): ResolutionProposal {
  validateProfile(profile);
  const ranked = candidates
    .filter((candidate) => !candidate.hardContradiction)
    .map((candidate) => ({
      candidateId: candidate.candidateId,
      score: candidate.attribute * profile.weights.attribute
        + candidate.semantic * profile.weights.semantic
        + candidate.temporal * profile.weights.temporal
        + candidate.graph * profile.weights.graph,
    }))
    .sort((left, right) => right.score - left.score);

  const winner = ranked[0];
  if (!winner || winner.score < profile.reviewThreshold) {
    return { outcome: "NO_MATCH", reason: "No eligible candidate cleared the review threshold" };
  }

  const runnerUp = ranked[1];
  if (
    winner.score >= profile.autoLinkThreshold
    && (!runnerUp || winner.score - runnerUp.score >= profile.winningMargin)
  ) {
    return { outcome: "AUTO_LINK", candidateId: winner.candidateId, score: winner.score };
  }

  return {
    outcome: "AMBIGUOUS",
    candidates: ranked.filter(({ score }) => score >= profile.reviewThreshold),
    reason: winner.score < profile.autoLinkThreshold ? "Top candidate is below auto-link threshold" : "Candidate scores are too close",
  };
}

function validateProfile(profile: ResolutionProfile): void {
  const weightTotal = Object.values(profile.weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(weightTotal - 1) > 0.000001) {
    throw new DomainRuleViolation("INVALID_RESOLUTION_PROFILE", "Resolution weights must total 1");
  }
  if (profile.reviewThreshold > profile.autoLinkThreshold) {
    throw new DomainRuleViolation("INVALID_RESOLUTION_PROFILE", "Review threshold cannot exceed auto-link threshold");
  }
}
