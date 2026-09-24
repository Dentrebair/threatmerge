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

- Production malware-scanner integration is deferred to Sprint 9 and must not block the current workflow-development phase.
- The evidence worker and scanner interface are retained as dormant server-side foundation code; the browser does not invoke them.
- The worker is disabled by default through `MALWARE_SCANNING_ENABLED=false`. It may only be enabled after an approved scanner is configured and end-to-end quarantine tests pass.
- Until then, uploaded evidence remains pending and must not be represented as safe, verified, or ready for extraction.
- The intended implementation branch when Git is initialized is `feature/production-malware-scanner`.

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

The 5 MB cap is an interim product constraint. Malware-scanner activation, resumable uploads, quotas, derivative generation, lifecycle cleanup, archival storage, and operational dashboards belong in the production-readiness work before scaling beyond controlled tenants.
