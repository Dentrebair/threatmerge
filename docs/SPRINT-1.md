# Sprint 1: Captured Invoice Vertical Slice

## Goal

A tenant-scoped Reviewer can upload one supported invoice file, inspect an extracted Captured Invoice with field provenance, correct it safely, and verify it into the canonical database. The result must be auditable, idempotent, and isolated from every other tenant.

This sprint proves the core record and review loop. It does not attempt the full ingestion and entity-resolution platform.

## Sprint Shape

Sprint 1 is one deliverable with two ordered tracks:

- **Sprint 1A - horizontal foundation:** domain types, module interfaces, tenant context, RLS, immutable evidence, ingestion idempotency, processing outbox, extraction adapter, provenance, audit, and lifecycle transition rules.
- **Sprint 1B - vertical proof:** the Captured Invoice upload, review, and verification journey built only through those interfaces.

Track 1A is complete when its interfaces and contract tests support the vertical proof; it is not a mandate to build generalized entity resolution or unused adapters first.

Module ownership and interface rules follow [ThreadMerge Architecture](ARCHITECTURE.md).

## User Journey

1. A Tenant Administrator completes a minimal development workspace setup with one Issuer, one default Invoice Schema, and one Reviewer.
2. The Reviewer uploads a PDF, JPEG, or PNG containing one pre-existing invoice.
3. The system validates the file, stores the immutable original, and creates an ingestion event whose transport idempotency is independent from its content checksum.
4. A background job creates Extracted Observations, then assembles an Incomplete Invoice Draft with Resolved Field Values and field-level provenance.
5. The Reviewer opens the work queue, selects the draft, compares fields with the source, and corrects missing or uncertain values.
6. Validation and exact-duplicate checks pass.
7. Mandatory review moves the invoice through `READY_FOR_VERIFICATION` and `PENDING_REVIEW` to `VERIFIED`.
8. The Verified Invoice Record and audit history remain available after refresh.

## In Scope

### Foundation

- Ports-and-adapters project structure with domain logic independent from Supabase, object storage, model provider, and job runner SDKs.
- Tenant, user-role, and request-context foundations.
- Managed authentication, MFA enforcement, expiring invitations, session revocation, and non-interactive Integration Account credentials.
- Supabase Row Level Security for every tenant-owned table and storage path used in the slice.
- Structured migrations and deterministic local seed data.

### Canonical model

- `tenants`
- `tenant_memberships`
- `issuers`
- `invoice_schema_versions`
- `evidence_artifacts`
- `ingestion_events`
- `invoice_candidates`
- `extracted_observations`
- `invoice_field_values`
- `evidence_links`
- `work_items`
- `approval_policy_versions`
- `audit_events`
- `processing_jobs` or transactional outbox records

Invoice lifecycle, linkage status, processing status, and extraction confidence must be stored independently.

### Upload and processing

- Manual PDF, JPEG, and PNG upload only.
- File-size and media-type validation.
- Expanded-size, page-count, pixel-count, parser-timeout, and recursion limits.
- Malware-scanning port with a production adapter decision captured before release; tests use a deterministic fake.
- Immutable tenant-scoped raw-object storage with content checksums. Idempotency uses a channel-specific request identity, never the checksum alone.
- Background extraction through a model adapter with recorded provider, model, prompt/schema version, and timestamps.
- Schema-constrained model output with no model tools or remote-resource fetching and deterministic validation before persistence.
- One-invoice-per-upload assumption for Sprint 1; multi-invoice splitting becomes later work.
- Exact duplicate detection by tenant, content checksum, source invoice number, Issuer, and total. Semantic duplicate detection is deferred.

### Review experience

- Work queue with status, age, Issuer, amount, assignment, and blocker filters.
- Desktop evidence-and-form layout plus a non-overlapping narrow-screen source drawer or tab layout.
- Missing and conflicting fields emphasized before non-blocking provenance.
- Field-level **Inspect Source** behavior.
- Reviewer edits with optimistic concurrency and explicit stale-version handling.
- Mandatory approval only; conditional and automatic modes are represented in the domain model but not configurable in Sprint 1.

### Verification and audit

- Effective Invoice Schema built from the brokerage default for this slice.
- Fixed-precision monetary validation.
- Captured source invoice number retained separately from the internal ID.
- Atomic transition to `VERIFIED` with audit events and any required outbox entry.
- Append-only audit events for upload, extraction, edits, validation, approval, and failed stale writes.

## Out Of Scope

- Postmark forwarding addresses and inbound email parsing.
- Microsoft 365 and Gmail OAuth.
- Cross-email entity resolution, embeddings, `pgvector`, and Transaction File linkage.
- Generated Invoices, Official Invoice Number allocation, and generated PDF rendering.
- Transaction File convergence, dormancy, approval, dossiers, and amendments.
- Tenant template layering beyond the brokerage default.
- Conditional or automatic approval configuration.
- Conflict Precedence Policy editing.
- Generic outbound webhooks and dedicated CRM integrations.
- DOCX, XLSX, CSV, HEIC, handwritten OCR, and multi-invoice document splitting.
- Corrections, voiding, legal holds, retention execution, and tenant export.
- Email, Slack, or Teams notifications.

## Acceptance Scenarios

1. Retrying one upload request with the same idempotency key resolves to one ingestion event and one processing run.
2. Deliberately uploading identical content twice creates two receipt events referencing tenant-scoped equivalent evidence, preserves both user actions, and does not automatically create two invoice candidates.
3. The same checksum uploaded by two tenants remains isolated and creates independent tenant-owned records.
4. An unsupported or unsafe file never reaches extraction and appears as a remediation item.
5. Extraction creates observations whose source locations open the correct Evidence Artifact page or image region.
6. A missing required field prevents verification and appears as the primary blocker.
7. A Reviewer can correct a field, and the audit event retains before-and-after metadata and actor identity.
8. Two open review sessions cannot overwrite each other; the stale submission receives a refresh-required response.
9. An exact duplicate enters mandatory review and is never silently merged or deleted.
10. A valid Captured Invoice can be approved and remains `VERIFIED` after page reload and worker restart.
11. A user from another tenant cannot query, download, infer, or enumerate the invoice or its evidence.

## Definition Of Done

- Domain tests cover allowed and forbidden lifecycle transitions.
- Integration tests cover database transactions, RLS, storage authorization, idempotency, audit append-only behavior, and outbox claiming.
- Authentication tests cover invitation expiry, MFA enforcement, session revocation, and forbidden cross-tenant role use.
- Adversarial tests cover cross-tenant worker access, prompt-injection text in evidence, malformed files, decompression limits, and CSV formula neutralization.
- End-to-end tests cover upload, extraction, review, stale-write recovery, approval, and refresh persistence.
- Accessibility checks cover keyboard navigation, focus order, labels, status semantics, and color-independent blockers.
- Sensitive source content and extracted values do not appear in ordinary logs or test snapshots.
- Failure injection demonstrates safe retry after worker termination without duplicate records or audit events.
- The deployed development environment includes observable queue depth, processing duration, and failure count without sensitive payloads.

## Suggested Delivery Order

1. Domain types, lifecycle transition tests, and schema-composition contract.
2. Tenant schema, RLS, audit events, and storage authorization.
3. Idempotent upload, immutable evidence storage, and processing outbox.
4. Extraction adapter, deterministic fixtures, and provenance persistence.
5. Work queue and review form with optimistic concurrency.
6. Validation, exact duplicate review, approval, and atomic verification.
7. End-to-end hardening, failure injection, accessibility, and observability.
