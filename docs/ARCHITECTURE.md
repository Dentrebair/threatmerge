# ThreadMerge Architecture

## Architectural Rule

Each domain record has one owning module. Other modules request changes through that module's interface or react to committed events; they do not update its tables directly. PostgreSQL transactions and an outbox connect synchronous domain changes to asynchronous work.

## Module Map

| Module | Owns | Interface responsibility |
| --- | --- | --- |
| Workspace Administration | Tenant activation, memberships, Issuers, policy and schema versions | Validate and publish tenant configuration; answer whether a workspace may process production data |
| Evidence Intake | Receipt history, Evidence Artifacts, ingestion events | Accept a channel receipt idempotently, preserve immutable evidence, and schedule safe processing |
| Document Understanding | Extracted Observations and extraction-run metadata | Turn safe evidence into schema-constrained observations with source locations; never choose canonical values |
| Entity Resolution | Candidate-link proposals and scoring explanations | Propose invoice and Transaction File relationships using versioned thresholds; never force an ambiguous match |
| Invoice Processing | Invoice Candidates, Resolved Field Values, invoice lifecycle, corrections | Compose the Effective Invoice Schema, resolve fields, validate, route approval, and verify or void invoices |
| Transaction Processing | Transaction Files, deal stages, templates, parties, dates, financials, documents, requirements, payments, issues, health projections, amendments | Own the deal workspace and stage gates independently from invoice lifecycle |
| Work Management | Work Items, assignments, follow-up dates, queue projections | Present and assign human work without changing business lifecycle state |
| Publication | PDF and dossier compilation status, webhook delivery attempts | Render and deliver already committed canonical records; never approve or mutate them |
| Governance | Retention schedules, legal holds, exports, deletion runs and receipts | Apply tenant governance policy across owned records without becoming their business owner |

## Deep Interfaces

The interfaces below describe responsibilities, invariants, and error modes. Concrete method signatures may evolve during implementation, but ownership may not drift.

### Workspace Administration

Accepts versioned configuration commands and returns either a published version or structured validation failures. Publishing is atomic. Activation succeeds only when every required configuration category is present and mutually consistent.

### Evidence Intake

Accepts a `Receipt` containing tenant context, channel identity, channel-specific idempotency identity, metadata, and content. It returns the existing result for a transport retry and a new receipt event for a deliberate repeated submission. It owns raw persistence, safety status, checksums, and processing-outbox creation.

Content equality is not request identity. Identical bytes may represent multiple legitimate receipts, while one retried request must produce one processing run.

### Document Understanding

Accepts a safe Evidence Artifact reference and extraction profile. It returns Extracted Observations plus run metadata. It cannot write invoice values, link a Transaction File, approve a record, invoke tools from document instructions, or fetch embedded remote resources.

### Entity Resolution

Accepts observations, tenant scope, and a versioned resolution profile. It returns an explained proposal: auto-link, ambiguous candidates, or no match. The caller applies the proposal through the owning Invoice or Transaction module.

### Invoice Processing

Accepts a discriminated invoice command such as applying observations, recording a review decision, evaluating readiness, verifying, creating a correction, or voiding. It loads and locks one invoice aggregate, enforces transitions and versioned rules, and returns committed domain events plus the updated public representation.

Verification atomically persists the Verified Invoice Record, reserves an Official Invoice Number for Generated Invoices, appends audit metadata, and writes publication jobs to the outbox. Publication failure cannot roll back verification.

### Transaction Processing

Accepts creation, assignment, party, date, financial, document, requirement, invoice-link, payment-status, issue, stage-transition, cancellation, closing, reopening, template-upgrade, and amendment commands for one Transaction File. It alone evaluates versioned stage gates and health projections. Material changes invalidate readiness and return the file to the earliest affected active stage. Invoice verification remains owned by Invoice Processing.

Transaction Processing uses constrained relational tables for operational records. JSONB is reserved for immutable template snapshots, normalized custom values, calculations, provenance, and metadata. Customer-facing stages are `DRAFT`, `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `READY_FOR_CLOSING`, `CLOSED`, and `CANCELLED`; ambiguity, inactivity, processing, assignment, and notifications are orthogonal projections.

### Work Management

Consumes committed domain and operational events to maintain queue projections. Assignment and `WAITING_FOR_EVIDENCE` are work states only; this module cannot make invoice or Transaction File transitions.

### Publication

Consumes outbox jobs containing immutable canonical record references. It renders or delivers idempotently and records independent compilation or delivery status. Retries reuse the logical event idempotency key.

## Adapters At Real Seams

Only dependencies with production and test implementations receive adapters initially:

| Seam | Production adapter | Test adapter |
| --- | --- | --- |
| Evidence storage | Supabase Storage | In-memory or temporary-filesystem adapter |
| Threat scanning | Selected malware scanner | Deterministic safe, unsafe, and failure adapter |
| Model extraction | Configured model provider | Fixture-based deterministic extractor |
| Inbound email | Postmark Inbound | Signed webhook fixture adapter |
| Microsoft mailbox | Microsoft Graph | Recorded-contract adapter |
| Downstream delivery | Signed webhook | In-memory receiver adapter |

PostgreSQL is a local-substitutable dependency inside the owning modules. Use a real disposable PostgreSQL database or compatible local test environment for transaction, RLS, locking, and outbox tests; do not expose repositories through every module interface solely for mocking.

## Committed Event Flow

1. An input adapter calls Evidence Intake.
2. Evidence Intake commits the receipt, artifact reference, audit metadata, and processing outbox job.
3. A worker asks Document Understanding for observations and commits the run result.
4. Entity Resolution proposes existing candidates or no match.
5. Invoice Processing applies observations to one or more Invoice Candidates and emits lifecycle or blocker events.
6. Work Management projects review and remediation tasks.
7. A review command returns through Invoice Processing or Transaction Processing, never through the queue projection.
8. Invoice verification or a Transaction File stage transition commits canonical state and any publication jobs.
9. Publication updates only compilation and delivery status.

Events are committed facts, not commands disguised as events. Consumers must be idempotent, and per-record events carry aggregate version and sequence so stale or out-of-order processing can be rejected or replayed safely.

## Non-Negotiable Invariants

- Every operation has explicit tenant context.
- Only an owning module writes its aggregate.
- Extracted Observations are never canonical values by themselves.
- Model confidence never overrides a hard contradiction or unresolved precedence tie.
- A transport retry and repeated business evidence are different events.
- Business lifecycle does not encode processing, compilation, delivery, or work-queue status.
- Verified and archived records change only through correction or amendment.
- Side effects begin from committed outbox jobs and are safe to retry.

## Sprint 1 Module Cut

Sprint 1A implements the minimum interfaces for Workspace Administration, Evidence Intake, Document Understanding, Invoice Processing, Work Management, and the audit/outbox foundation. Entity Resolution uses a deliberately narrow exact-duplicate adapter, Transaction Processing is represented only by stable IDs and contracts, and Publication is limited to proving outbox creation.

Sprint 1B builds the Captured Invoice journey through those interfaces. No UI route or worker may bypass the owning module to write domain tables directly.

## Transaction Integration Rule

Transaction linkage is a coordinated command, not a mutable invoice flag. Entity Resolution returns an explained proposal; Invoice Processing records the association only after Transaction Processing confirms the target exists and accepts it. Relinking a verified invoice requires an audited reason and schema re-evaluation. Closing or cancelling a Transaction File never verifies, voids, dismisses, or deletes an invoice. Consumers record source aggregate versions and event sequences so retries remain idempotent and stale events cannot reverse newer decisions.
