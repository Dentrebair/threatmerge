# ThreadMerge Delivery Roadmap

This roadmap sequences the approved PRD v1.5, including Transaction File decisions Q1-Q40. Each sprint ends with database, domain, integration, UI, accessibility, tenant-isolation, concurrency, and negative-path tests. A later sprint may not bypass an unfinished owning-module contract.

## Completed Foundation: Sprints 1-3

- Sprint 1: tenant/RLS foundation, immutable evidence intake, captured invoice review, provenance, verification, audit, and outbox contracts.
- Sprint 2: generated-invoice assembly contracts, multi-evidence observations, extraction/assembly jobs, approval policy routing, manual intake, cancellation, and worker leases.
- Sprint 3: initial Transaction File persistence, standalone invoice support, explained linkage proposals, requirement tracking, lifecycle safeguards, and review workspace prototype.
- Legacy Transaction File states and requirement snapshots remain compatibility inputs only; Sprints 4-5 replace their customer-facing behavior.

## Sprint 4: Transaction Domain Migration

**Goal:** establish the durable relational model without breaking invoice linkage.

- Add configurable transaction types with Purchase, Sale, Lease, and Rental defaults.
- Add versioned transaction templates and snapshots for requirements, dates, gates, payment policy, and health weights.
- Add owner and participant assignments with role-based authorization.
- Add reusable parties and role associations; enforce one named primary party.
- Replace the legacy lifecycle with `DRAFT`, `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `READY_FOR_CLOSING`, `CLOSED`, and `CANCELLED`.
- Model ambiguity, inactivity, processing failures, and work assignment outside lifecycle.
- Migrate existing states with audit metadata; preserve stable IDs and invoice links.
- Add compatibility projections while old UI paths are retired.

**Acceptance:** all existing invoice/linkage tests pass; migration is reversible in staging; no file loses requirements, invoices, evidence, or history.

## Sprint 5: Lightweight Creation and Overview

**Goal:** create a valid deal quickly and immediately expose operational readiness.

- Require only address, transaction type, owner, and named primary party with allowed role.
- Keep reference, office, dates, documents, and information optional.
- Snapshot the active transaction-type template at creation.
- Build Overview with Deal Summary and persistent tab navigation.
- Build versioned, explainable health projection and header metrics.
- Add manual stage actions: Begin work and Submit for review.
- Add backward-stage invalidation after material edits.
- Add accessible empty, loading, stale-update, and permission-denied states.

**Acceptance:** creation is keyboard accessible; invalid owner/party/type combinations fail atomically; health can be reproduced from canonical records.

## Sprint 6: Parties, Dates, Financials, and Custom Fields

**Goal:** manage core deal facts with provenance and stage validation.

- Parties: multiple buyers, sellers, tenants, landlords, agents, lenders, attorneys, and title/escrow companies.
- Assign exactly one primary party; audit role and primary-party overrides.
- Important dates: agreement, inspection, financing, document deadline, closing, and handover.
- Support date-only and time-zone-qualified timestamps.
- Financials: base currency, deal value, deposit, commission, taxes, and fees.
- Add relational custom-field definitions with type, validation, gate, and template version; JSONB stores normalized values/provenance only.
- Implement Before Review gate and blocker explanations.

**Acceptance:** deal and invoice totals remain separate; mixed currencies are never combined; malformed dates, values, and cross-tenant references are rejected.

## Sprint 7: Documents and Structured Requirements

**Goal:** replace free-text requirement entry with auditable checklists and document control.

- Structured checklist rows sourced from templates and transaction-specific additions.
- Document states: `MISSING`, `RECEIVED`, `VERIFIED`, `REJECTED`, `EXPIRED`.
- Immutable versions, current-version designation, uploader/verifier attribution, expiry, issues, and Evidence Links.
- Required-information rows with typed values, completion, verifier, provenance, and stage gate.
- Admin-only override for weakening template blockers.
- Template upgrade preview and explicit application; never silently update active files.
- Before Approval validation with all conflicts and missing items resolved.

**Acceptance:** superseded files remain accessible; removing a checklist item never removes audit evidence; template upgrades show deterministic diffs.

## Sprint 8: Invoices, Payments, Issues, and Closing

**Goal:** make the Transaction File a complete closing-readiness workspace.

- Linked invoice table with vendor, amount, currency, due date, approval, and payment status.
- Audited unlink/relink; verified invoices require reason, review, and Effective Invoice Schema re-evaluation.
- Payment tracking only: `UNPAID`, `SCHEDULED`, `PARTIALLY_PAID`, `PAID`, `DISPUTED`, `VOIDED`.
- Separate currency totals; outstanding headline uses approved balances in base currency and excludes disputed/voided invoices.
- Manual and generated issues with severity, blocker flag, owner, due date, resolution, and evidence.
- Implement Mark ready for closing, Close, Cancel, and admin-only Reopen commands.
- Enforce final documents, closing date, invoices, payment policy, and blocker-free Before Closing gate.

**Acceptance:** closing never verifies or voids invoices; cancellation retains invoices; deferred payments require policy and documented reason.

## Sprint 9: Full Extraction and Entity Resolution

**Goal:** replace development fixtures with production processing.

- Production safety scanner and quarantined-file remediation, delivered independently on `feature/production-malware-scanner` once source control is initialized.
- PDF, scan, image, HEIC, DOCX, XLSX, CSV, printed-text, and handwriting preprocessing.
- Schema-constrained extraction with source locations and provider/model/prompt versions.
- Multi-invoice splitting and multi-artifact invoice assembly.
- Tenant-scoped hybrid linkage scoring, contradiction rules, near-tie review, and winning-margin enforcement.
- Populate Transaction File parties, dates, documents, financials, and issues through proposals, never direct canonical writes.
- Performance, retry, cancellation, lease-expiry, poison-input, and provider-failure tests.

## Sprint 10: Email Ingestion and Cross-Email Accumulation

**Goal:** process fragmented evidence arriving over time.

- Tenant forwarding-address/Postmark ingestion and signed-webhook verification.
- `.eml` upload including Gmail-originated messages and attachments.
- Microsoft 365 OAuth/Graph ingestion; native Gmail OAuth remains deferred unless reprioritized.
- Thread-independent entity resolution, deduplication, temporal precedence, and evidence graph updates.
- User-friendly connection, delay, retry, and failure states.
- Notifications for new blockers, deadlines, overdue documents, conflicts, failed processing, review completion, and reopened files.

## Sprint 11: Corrections, Publication, and Integrations

**Goal:** complete immutable post-verification workflows and output delivery.

- Invoice corrections, duplicate merge/distinct/dismiss decisions, and voiding UI.
- Generated invoice PDF compilation, captured/source exports, and Transaction File dossier compilation.
- Canonical persistence before signed, versioned, idempotent webhook delivery.
- Dead-letter handling, manual replay, and downstream synchronization status.
- No direct payment execution or unauthorized invoice-party delivery.

## Sprint 12: Operations, Search, Governance, and Launch

**Goal:** make the complete product operable and production-ready.

- Search property, reference, party, owner, and invoice number.
- Filter by stage, type, owner, office, health, closing date, and blockers.
- Full History tab and append-only audit projections.
- In-app queues and configurable email alerts.
- Retention, legal hold, export, controlled deletion, support access, and audit receipts.
- Observability, queue dashboards, backup/PITR, restore drill, rate limits, security review, accessibility, responsive browser E2E, and failure injection.
- Tenant activation checklist and production runbooks.

## Cross-Sprint Rules

- Core operational data is relational; JSONB is limited to snapshots, custom value payloads, calculations, provenance, and metadata.
- Invoice and Transaction File identities and lifecycles remain independent.
- One property may have many deals; one deal may have many invoices and parties.
- Forward stage changes are explicit and validated; material changes can move stages backward.
- Ordinary users cannot delete audit history or superseded evidence.
- Every sprint updates the PRD/architecture when behavior changes and includes negative, concurrency, authorization, and tenant-isolation tests.
- Deferred capacity, storage, and upload-reliability work is tracked in [SCALING.md](SCALING.md).

## Decision Traceability

| Decisions | Roadmap coverage |
| --- | --- |
| Q1-Q4 | Sprints 4-5: distinct deal identity, accountable owner, named primary party, lightweight creation and template-derived requirements |
| Q5-Q7 | Sprint 4: new lifecycle and audited legacy-state migration |
| Q8-Q10 | Sprints 4 and 7: configurable types, multi-party roles, immutable templates and explicit upgrades |
| Q11-Q12 | Sprints 6 and 8: base currency, separated currency totals, configurable payment gate |
| Q13-Q16 | Sprints 5-8: Draft creation, explicit transitions, Review/Approval/Closing gates |
| Q17-Q20 | Sprints 5 and 7: weighted health, document verification, manual/system issues, template-update preview |
| Q21-Q24 | Sprints 4 and 8: permissions, cancellation, reopening, audited invoice relinking |
| Q25-Q28 | Sprints 5, 6, and 8: separate financial sources, outstanding balance rules, protected blockers, tabbed workspace |
| Q29-Q32 | Sprints 4, 6, 7, and 8: role defaults, date semantics, immutable document versions, payment tracking only |
| Q33-Q36 | Sprints 5, 8, 10, and 12: explicit stage actions, notifications, search/filters, incremental delivery |
| Q37-Q40 | Sprints 4-12 and cross-sprint rules: hybrid schema, typed custom fields, reproducible health, append-only history |
