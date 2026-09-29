# ThreadMerge Scaling Plan

This document records capacity and reliability work that is intentionally deferred while the product workflow is being validated. These items are required before broad production rollout.

## Evidence Uploads

### Current limit

- Manual invoice and Transaction File document uploads are limited to 5 MB per file.
- Supported formats are PDF, JPEG, and PNG.
- The immutable original is stored without compression so checksums, audit history, and source evidence remain trustworthy.
- The limit is enforced in both the client and the Evidence Intake database command.

### Production upload subsystem

- Upload directly to object storage rather than passing bytes through the application server.
- Use resumable uploads so interrupted transfers continue instead of restarting.
- Make file-size limits configurable by tenant, plan, channel, and document type.
- Enforce tenant and user storage quotas with warnings before the limit is reached.
- Preserve the immutable original and generate smaller previews, thumbnails, and OCR-ready derivatives asynchronously.
- Track explicit states: `UPLOADING`, `UPLOADED`, `SCANNING`, `READY`, `FAILED`, `CANCELLED`, and `EXPIRED`.
- Detect stalled transfers and processing jobs, then provide clear Retry, Replace, and Cancel actions.
- Delete abandoned multipart uploads, cancelled objects, and unreferenced artifacts after a configured grace period.
- Run scanning, conversion, OCR, preview generation, and extraction through independently scalable worker queues.
- Use SHA-256 for integrity and controlled deduplication where retention and evidence policy permit it.
- Move eligible older originals to lower-cost archival storage without removing searchable metadata or audit links.
- Apply retention policies, legal holds, export rules, and controlled deletion at tenant scope.

### Capacity and operations

- Measure storage growth per tenant, upload throughput, failure rate, p50/p95 upload time, scan latency, worker backlog, retries, and abandoned-upload volume.
- Alert on queue age, repeated worker failures, quota exhaustion, storage errors, and unusual tenant growth.
- Apply concurrency limits and backpressure so one tenant cannot exhaust shared workers.
- Test interrupted transfers, duplicate submissions, stale leases, scanner outages, poison files, quota races, cancellation races, and storage-provider failures.
- Maintain runbooks for backlog recovery, storage migration, retention execution, and disaster recovery.

## Malware Scanning

### Current phase decision

- Production malware-scanner integration is deferred to the next product phase and must not block the current workflow-development phase.
- The evidence worker and scanner interface are retained as dormant server-side foundation code; the browser does not invoke them.
- The worker is disabled by default through `MALWARE_SCANNING_ENABLED=false`. It may only be enabled after an approved scanner is configured and end-to-end quarantine tests pass.
- Local workflow testing may use the explicitly enabled signature validator through `npm run worker:evidence:dev`; it is not malware protection and is blocked in production.
- Until then, uploaded evidence remains pending and must not be represented as safe, verified, or ready for extraction.
- The intended implementation branch when Git is initialized is `feature/production-malware-scanner`.

## Additional Next-Phase Deferrals

### Multi-invoice splitting

- The current phase supports one invoice per upload.
- A document classified as containing multiple invoices fails terminally with `MULTIPLE_INVOICES` and instructs the user to upload each invoice separately.
- Automatic page-boundary detection, splitting, child-candidate creation, and multi-artifact assembly are deferred to the next phase.
- Retries must not reinterpret this terminal rejection or create duplicate invoice candidates.

### Production entity resolution

- The current phase retains deterministic, tenant-scoped Transaction File suggestions and explicit reviewer decisions.
- Embeddings, `pgvector`, hybrid semantic scoring, configurable auto-link thresholds, and automatic Transaction File population are deferred to the next phase.
- Current suggestions must remain advisory: no ambiguous or unmatched invoice may be silently linked.
- Existing manual links, reviewer decisions, stale-proposal replacement, tenant isolation, and audit history remain supported.

### Cross-channel invoice fragment accumulation

- Sprint 10 ingestion (Telegram now, email later) allows the same invoice's details to arrive in separate messages days or weeks apart (e.g. a partial scan first, a clearer or more complete one later), across any channel. Merging these into one invoice, rather than creating duplicate candidates, is deferred design work, not yet implemented.
- Proposed approach, extending the existing architecture rather than changing it:
  - **Match key**: same deterministic key already used for duplicate detection (issuer + invoice number). This requires the invoice number to appear in at least one fragment; there is no fuzzy-text fallback.
  - **Match timing**: entity resolution must run before invoice assembly creates a candidate, not only at approval-routing time as today. On a new evidence artifact's extraction completing, check for an existing non-terminal invoice candidate with the same issuer + invoice number before deciding whether to create a new one or attach to the existing one.
  - **Attachment, not merge**: a matched fragment's evidence artifact gets an additional `evidence_links` row (`relationship = 'SOURCE_DOCUMENT'`) pointing at the existing `invoice_candidate_id`; the schema already permits multiple such links per invoice, so this needs new selection logic, not a schema change.
  - **Field resolution**: fields still missing get filled from the new fragment (clearing `MISSING:` blockers). Fields present in both fragments with the same value are unaffected. Fields present in both with different values become a `CONFLICT:` blocker for human review, reusing the conflict-detection logic already used when two extraction attempts on one document disagree.
  - **Provenance**: unaffected, since each observation already carries its own evidence-artifact link independent of which invoice candidate it ends up attached to.
  - **Known gap**: if the invoice number is absent from every fragment until a late message, there is nothing to match on until then; the fragments remain separate `INCOMPLETE_DRAFT` candidates until a human links them or a later message finally supplies the number.

### Telegram real tenant mapping

- The initial Telegram ingestion build (Sprint 10) routes every incoming message to a single fixed test tenant; there is no per-chat identity resolution.
- Deferred: a pairing step where a tenant admin links their workspace to a Telegram chat (e.g. the admin messages a shared bot with a one-time pairing code generated in-app), after which messages from that chat route to that tenant automatically.
- Until built, this ingestion channel is not usable with real, multiple tenants — single-tenant/demo use only.

### Retries and provider failures

- Production-grade retry and provider-failure handling is deferred to the next phase.
- The current bounded retries and cancellation safeguards remain in place, but they are not considered sufficient for production outage resilience.
- Rate-limit coordination, full-jitter backoff tuning, dead-letter recovery, lease-expiry recovery, poison-input isolation, provider failover, operational alerts, and recovery runbooks remain deferred.
- Until that work is complete, provider failures must remain visible as failed or retry-scheduled jobs and must never be reported as successful processing.

### HEIC images

- HEIC upload, decoding, normalization, preview generation, and extraction are deferred to the next phase.
- The current upload picker does not advertise HEIC support, and unsupported HEIC uploads must be rejected rather than stored as processable invoices.
- Current image support remains JPEG and PNG.

### Provider plan

- Evaluate Cloudmersive first for the controlled MVP. Its current free allowance is suitable for low-volume testing, but commercial terms, data processing, residency, retention, and DPA requirements must be reviewed before production use.
- Evaluate self-hosted ClamAV when volume makes per-call pricing inefficient or when document privacy requires local processing. Budget for its memory, signature updates, monitoring, redundancy, and HTTP service wrapper.
- Do not use the VirusTotal public API. Its public terms do not permit this commercial product workflow, and ordinary submissions are unsuitable for confidential real-estate documents.
- Keep the application-facing scanner contract provider-neutral so a provider change does not alter invoice, evidence, or Transaction File state machines.

### Activation gate

Before enabling scanning, complete all of the following:

- Implement and test the selected provider adapter, authentication, timeouts, response validation, and rate-limit handling.
- Confirm uploaded bytes and scan results are not retained or shared outside the agreed data-processing terms.
- Test clean files, known-safe antivirus test files, malformed files, password-protected files, scanner timeouts, provider outages, cancellation races, and duplicate delivery.
- Add queue-age alerts, scanner latency/error dashboards, retry limits, dead-letter handling, and an operator recovery runbook.
- Enable `MALWARE_SCANNING_ENABLED=true` only in the isolated worker environment; never expose scanner or service-role credentials through `VITE_` variables.

## Delivery Timing

The 5 MB cap is an interim product constraint. Malware-scanner activation, multi-invoice splitting, production entity resolution, cross-email invoice fragment accumulation, production retry/provider-failure hardening, resumable uploads, quotas, derivative generation, lifecycle cleanup, archival storage, and operational dashboards belong to the next-phase production-readiness work before scaling beyond controlled tenants.
