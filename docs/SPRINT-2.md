# Sprint 2: Multi-Evidence Generated Invoice Slice

## Goal

A Reviewer can receive or upload email evidence whose facts are split across messages and attachments, inspect how those facts were grouped, resolve any conflicts, and verify a Generated Invoice. No invoice document or Official Invoice Number exists before verification.

Sprint 2 extends the Sprint 1 foundation; it does not replace the Captured Invoice path.

## User Journey

1. Evidence arrives through a signed Postmark Inbound fixture or an uploaded `.eml` file.
2. Evidence Intake stores the immutable raw message, body, and attachment relationships and acknowledges the receipt idempotently.
3. Document Understanding produces source-located observations from the body and supported attachments.
4. Entity Resolution proposes an existing Invoice Candidate or a new unlinked candidate, with score factors and contradictions visible to review.
5. Invoice Processing classifies the candidate as `GENERATED` because no complete issued invoice exists and resolves fields across its Evidence Artifacts.
6. Missing or tied values remain blockers. A Reviewer selects or enters a value without deleting superseded observations.
7. A valid candidate follows the configured mandatory-review route.
8. Verification atomically reserves an Official Invoice Number and enqueues generated-PDF compilation. Publication status remains independent from invoice lifecycle.

## In Scope

- Signed Postmark inbound adapter contract and deterministic webhook fixtures.
- Uploaded `.eml` messages, body/attachment decomposition, and receipt idempotency.
- Multiple Evidence Artifacts supporting one Invoice Candidate across unrelated thread identifiers.
- Explained entity-resolution outcomes: auto-link, ambiguous, or no match.
- Generated-versus-Captured origin classification and pre-verification reclassification with a reason.
- Field-level conflict presentation and reviewer resolution while preserving all observations.
- Generated Invoice readiness rules: no source invoice number requirement and no preallocated Official Invoice Number.
- Atomic Official Invoice Number reservation at verification and a PDF-compilation outbox record.
- UI evidence stack, provenance inspection, blockers, and Generated Invoice verification state.

## Out Of Scope

- Live customer Postmark provisioning, Microsoft 365 OAuth, or Gmail OAuth.
- Production embeddings, tuning, or `pgvector` infrastructure; Sprint 2 proves the resolution contract with deterministic scoring fixtures.
- Transaction File creation, convergence, dormancy, approval, dossiers, or amendments.
- Conditional and automatic Approval Policy configuration.
- Generated-PDF visual templates and external webhook delivery; only compilation job creation is included.
- Handwritten OCR and spreadsheet parsing beyond fixture-backed observations.
- Corrections to verified invoices.

## Invariants

- Evidence may be grouped without being copied or mutated.
- Thread identifiers are hints, never identity boundaries.
- A model observation cannot directly become a Verified Invoice Record.
- A hard contradiction prevents auto-linking regardless of score.
- A Generated Invoice displays its internal ID before verification, never a provisional Official Invoice Number.
- Official Invoice Number reservation and PDF outbox creation occur in the same finalization transaction.
- Failed PDF compilation does not undo verification or release a number.
- Unresolved Transaction File linkage does not discard or block an invoice unless its Effective Invoice Schema explicitly requires linkage.

## Acceptance Scenarios

1. Two unrelated email threads with compatible property, party, and amount observations can support one candidate.
2. A hard property or party contradiction prevents auto-linking even when semantic similarity is high.
3. A near tie produces an ambiguous resolution task and does not force the top candidate.
4. Conflicting values at equal precedence remain unresolved until a Reviewer chooses one with a reason.
5. The evidence view identifies message body, attachment, source location, confidence, and extraction run for every proposed value.
6. A Generated Invoice with a missing required field cannot be verified and has no generated document preview.
7. A ready Generated Invoice has no Official Invoice Number before verification.
8. Concurrent finalization attempts cannot reserve the same Official Invoice Number or verify the same candidate twice.
9. Successful verification persists the number and creates exactly one idempotent PDF-compilation job.
10. A compilation failure leaves the invoice verified and its number permanently reserved.
11. Repeated delivery of one Postmark message identity does not create duplicate evidence or processing work.
12. A deliberate second receipt with identical content remains visible but does not automatically duplicate the candidate.

## Definition Of Done

- Domain tests cover resolution thresholds, contradiction vetoes, conflict handling, origin rules, and generated finalization.
- Adapter contract tests cover Postmark authentication, tenant-address resolution, receipt retries, malformed payload quarantine, and fast acknowledgement boundaries.
- Integration tests cover number-sequence locking, unique constraints, atomic outbox creation, and tenant isolation.
- End-to-end tests cover multi-email assembly, conflict resolution, mandatory review, verification, and compilation retry.
- The UI never represents an unrecognized artifact or incomplete evidence group as an invoice document.
- Audit events retain grouping proposals, reviewer decisions, origin changes, number reservation, and publication-job creation.

## Suggested Delivery Order

1. Generated Invoice and evidence-resolution domain contracts.
2. Postmark/`.eml` receipt contracts and fixtures.
3. Multi-artifact observation grouping and explained resolution proposals.
4. Conflict resolution and Effective Invoice Schema validation.
5. Generated Invoice evidence workspace and review actions.
6. Atomic numbering and PDF-compilation outbox integration.
7. Concurrency, isolation, failure-injection, and accessibility hardening.
