# Product Requirements Document

## Document Control

| Field | Value |
| --- | --- |
| Project | NexusER (ThreadMerge) |
| Horizontal technology | Generalized Cross-Email Entity Resolution and Multimodal Dossier Synthesis Engine |
| Vertical product (v1) | Real Estate Invoice Processing and Transaction File Assembly |
| Architecture | Ports and Adapters: decoupled core engine with declarative Domain Schema Packs |
| Version | 1.5 |
| Status | Approved for engineering implementation |

Implementation module ownership, interfaces, adapters, and event flow are defined in [ThreadMerge Architecture](docs/ARCHITECTURE.md). Delivery sequencing is defined in the [master roadmap](docs/ROADMAP.md), with completed foundations recorded in [Sprint 1](docs/SPRINT-1.md), [Sprint 2](docs/SPRINT-2.md), and [Sprint 3](docs/SPRINT-3.md).

## 1. Executive Summary

Enterprises coordinate high-stakes workflows through fragmented, multi-channel communication. In real estate, facts needed for an invoice or closing file may arrive over weeks in email text, formal PDFs, spreadsheets, scans, photographs, and handwritten notes. Relevant messages may not share an email thread ID, and later evidence may supersede earlier statements.

Traditional document-processing systems treat each document as an isolated event. They do not reliably associate fragments with the same transaction, reconcile temporal conflicts, or combine partial evidence into a complete invoice.

NexusER addresses this with two distinct layers:

- The **Entity Resolution Engine** is reusable horizontal infrastructure for ingesting evidence, resolving related entities, accumulating state, and synthesizing structured records.
- The **Real Estate Invoice Processing App** is the initial customer-facing vertical product built on that engine.

The v1 product assembles invoice facts distributed across Evidence Artifacts, captures pre-existing invoices, validates both against tenant-configured requirements, routes uncertainty to human review, persists verified invoice records to ThreadMerge's canonical database, and optionally delivers them through a generic outbound webhook.

## 2. Users and Product Mission

### 2.1 Initial users

- **Buyer:** brokerage operations team.
- **Primary daily user:** transaction coordinator.
- **Early operating mode:** founders may perform the same workflow during rollout; this does not constitute a separate target persona.

### 2.2 Roles and authorization

The v1 product must support these tenant-scoped roles:

- **Tenant Administrator:** manages users, Invoice Schemas, Approval Policies, Conflict Precedence Policies, and integrations; may also perform review actions.
- **Reviewer:** resolves missing fields and conflicts, approves invoices, and dismisses or restores suspended invoices; cannot change tenant policies.
- **Viewer/Auditor:** has read-only access to records, Evidence Artifacts, and audit history.
- **Integration Account:** is a non-human identity restricted to explicitly configured ingestion and downstream actions; cannot perform interactive review or tenant administration.

Founders must receive one or more of these existing roles and must not have a hidden or privileged founder role. Human roles and Integration Accounts must be scoped to one tenant workspace in v1. Cross-tenant managed-service review is out of scope.

### 2.3 Product mission

The v1 product must:

1. Collect invoice facts and supporting evidence arriving through multiple emails and file formats.
2. Resolve which real estate transaction and invoice candidate each fact belongs to.
3. Support two invoice paths:
   - **Generated Invoice:** assemble an invoice from facts spread across multiple Evidence Artifacts when no complete source invoice exists.
   - **Captured Invoice:** extract a pre-existing invoice into structured form.
4. Validate the candidate against the customer's configured field and business rules.
5. Preserve an incomplete draft and identify missing or uncertain information when validation fails.
6. Require verification before producing a Verified Invoice Record.
7. Persist the Verified Invoice Record to ThreadMerge's canonical database, retain links to its supporting evidence, and optionally deliver it through the configured outbound webhook.

### 2.4 Invoice and transaction ownership

An invoice is an independently identifiable record within a tenant workspace. It may exist before the system can associate it with a Transaction File.

- A newly captured or generated invoice may begin as an **Unlinked Invoice**.
- Entity resolution may later associate it with a Transaction File.
- Linking enriches the invoice with transaction context; it does not create the invoice or change its identity.
- A Transaction File may contain multiple invoices.
- A property may be associated with multiple Transaction Files over time.
- Failure to resolve a Transaction File must not cause the invoice or its evidence to be discarded.

### 2.5 Financial-document scope

**Closing Financial Document** is the umbrella category for invoices, commission agreements, fee sheets, escrow instructions, settlement statements, and related financial documents. **Invoice** is reserved for a document that requests payment.

Supporting artifacts may include purchase agreements, title reports, appraisal photographs, inspection sketches, and other transaction documents needed to establish or validate invoice facts.

### 2.6 Observations, candidates, and canonical values

Extraction produces **Extracted Observations**, not canonical invoice fields. An observation is a claimed value tied to an Evidence Artifact location, extraction method, model and prompt versions, and confidence. It may later be accepted, superseded, rejected, or linked to more than one candidate without changing the source evidence.

Resolution groups observations into an **Invoice Candidate** and proposes field values and Transaction File linkage. Invoice assembly applies schema, precedence, calculation, conflict, duplicate, and review rules to select **Resolved Field Values**. Only a verified candidate produces a Verified Invoice Record.

Model output must never write directly to a Verified Invoice Record or silently replace a Resolved Field Value.

### 2.7 Invoice-origin classification

An Invoice Candidate is `CAPTURED` when source evidence contains a pre-existing issued invoice, including its invoice structure or source identifier. It is `GENERATED` when the system must create the invoice from facts that do not constitute a complete pre-existing invoice.

One Evidence Artifact may contain zero, one, or multiple invoices. One invoice may be supported by multiple Evidence Artifacts across unrelated messages. The system must create or update candidates at invoice granularity while retaining source-page, region, sheet, cell, message, and attachment relationships.

If origin is ambiguous, the candidate must enter review before verification, Official Invoice Number allocation, or final document generation. A reviewer may reclassify an unverified candidate with a reason. Reclassifying a verified invoice requires an Invoice Correction and must never discard an already allocated number or source identifier.

## 3. Invoice Configuration and Validation

### 3.1 Tenant configuration

During onboarding, each brokerage must configure a default invoice schema. The schema defines:

- Required source fields, such as invoice date, Issuer, Bill-To Party, optional Remit-To Party, line items, quantity, unit price, totals, currency, and payment details. A source invoice number may be required for Captured Invoices.
- Validation rules, such as invoice-number format, allowed currencies, valid tax rates, required calculations, and whether a value may be derived.
- Default output layout and downstream destination.

The product must also support optional invoice templates scoped by transaction type, office, or invoice-party identity and role. An authorized tenant user may update schemas and templates after onboarding without engineering support.

The system must build an **Effective Invoice Schema** by layering applicable configuration from least to most specific:

1. Brokerage default schema.
2. Invoice-party template.
3. Office template.
4. Transaction-type template.

More-specific layers override only the fields and rules they explicitly define; they must not discard unrelated requirements inherited from lower layers. If two templates at the same layer apply and define incompatible values, schema resolution must stop with an administrative configuration error rather than choosing silently.

For an `UNLINKED` invoice, transaction type and office are unresolved and must not be guessed. The Effective Invoice Schema therefore combines the brokerage default with an invoice-party template only when one unambiguously applies to that party's role. When linkage or identifying facts change, the system must rebuild the Effective Invoice Schema, retain all component versions, and re-run validation. A schema change must not silently discard accepted values or reviewer edits.

Configuration changes must be versioned. Each invoice must retain the ordered component versions and a deterministic fingerprint of the Effective Invoice Schema against which it was validated.

System-assigned finalization fields are not pre-verification requirements. In particular, a Generated Invoice's Official Invoice Number is assigned during the transition to `VERIFIED` and cannot block entry into `READY_FOR_VERIFICATION`. A Captured Invoice's source invoice number remains ordinary extracted evidence and may be required by its Effective Invoice Schema.

### 3.2 Completeness behavior

The system must create and retain an **Incomplete Invoice Draft** when one or more applicable required fields are missing, conflicting, or below the required confidence threshold.

An incomplete draft must:

- Preserve all accepted extracted and calculated facts.
- Display each missing, conflicting, or uncertain field.
- Link populated and conflicting values to their Evidence Artifacts.
- Be assignable to a reviewer for resolution.
- Accept additional evidence and re-run validation.

An incomplete draft must not be finalized, exported as an issued invoice, dispatched, or persisted as a Verified Invoice Record.

### 3.3 Inference and provenance

The system may normalize values and derive values through configured deterministic rules, such as calculating a line total from quantity and unit price. It must not invent identifiers, dates, parties, prices, quantities, or line items.

Every structured field must retain:

- The source Evidence Artifact and source location.
- Whether the value was extracted, calculated, or entered by a reviewer.
- Extraction or resolution confidence where applicable.
- The applicable precedence rule and any superseded values.
- Reviewer identity and timestamp for manual changes.

When applicable precedence rules leave two incompatible values at the same authority level, the field remains unresolved and requires review. Confidence, recency, or model preference must not silently break a precedence tie unless the versioned policy explicitly declares that rule.

### 3.4 Approval policy

Human approval is an explicit intermediate step in invoice processing. Mandatory review is the default for every newly onboarded tenant. A tenant administrator may configure how review applies to future invoices. Other tenant roles must not change the Approval Policy. The product must support three approval modes:

1. **Mandatory review:** every invoice that passes validation enters human review.
2. **Conditional review:** invoices matching tenant-defined conditions enter human review; non-matching invoices are automatically verified.
3. **Automatic verification:** invoices that pass all completeness, validation, conflict, and confidence requirements are verified without human review.

The Approval Policy must be evaluated only after an invoice reaches `READY_FOR_VERIFICATION`. It must never bypass missing required fields, unresolved conflicts, failed validation rules, or insufficient confidence. An invoice requiring review moves to `PENDING_REVIEW`; an invoice not requiring review moves to `VERIFIED` automatically.

Automatic verification must remain unavailable for an invoice origin and document class until the corresponding extraction and resolution profile has passed a versioned evaluation suite approved for production. Eligibility requires calibrated confidence based on held-out examples and deterministic financial validation; model self-reported confidence alone is insufficient. A model, prompt, schema, or material preprocessing change suspends automatic verification for the affected profile until regression evaluation passes again. Tenant enablement is still required after system eligibility.

Conditional review rules must support grouped `AND`/`OR` logic over this v1 condition set:

- Invoice total above a configured amount.
- New or unrecognized invoice party.
- Specific Issuer, Bill-To Party, Remit-To Party, office, or transaction type.
- Low-but-acceptable extraction or resolution confidence.
- Generated Invoice versus Captured Invoice origin.
- Unusual tax, commission, or pricing variance.

These conditions determine whether an otherwise valid invoice requires approval. A hard validation failure must return or retain the invoice as `INCOMPLETE_DRAFT` and must not be represented as a conditional-review match. Duplicate detection must complete before Approval Policy evaluation. A probable duplicate is a mandatory review override and is not configurable as an optional Approval Policy condition.

Approval Policy changes apply prospectively to upcoming invoices and must not reroute invoices already being processed. Changes are versioned and audit-logged and must record the tenant administrator who changed the policy and when. Each invoice must retain the policy version and evaluation result that determined its route.

### 3.5 Invoice numbering

Generated Invoice drafts use immutable internal IDs and must not consume or display an Official Invoice Number. At finalization, the system assigns the official number from a tenant-configurable, concurrency-safe sequence scoped to the legal Issuer, with an optional office component. The format may include supported tenant-defined prefixes and date components. Uniqueness must be enforced atomically tenant-wide as well as within the configured sequence scope.

Once reserved, an Official Invoice Number must never be released or reused. PDF compilation, persistence, or dispatch failure must retain the number and enter retry or failure handling. Voided invoices also retain their number and status so the sequence remains auditable.

Captured Invoices preserve the invoice number shown in their source evidence and receive a separate immutable ThreadMerge internal ID. The system must never replace a captured source number with a generated sequence number.

### 3.6 Duplicate resolution

A probable duplicate must enter `PENDING_REVIEW` regardless of mandatory, conditional, or automatic Approval Policy mode. Reviewers may:

- Merge the candidates while preserving every source and audit event.
- Mark them as distinct and record the justification.
- Dismiss the duplicate candidate without deleting its evidence.

The system must never silently delete or automatically merge a probable duplicate. Duplicate decisions must be retained for future matching and audit.

### 3.7 Currency and arithmetic

Each invoice must use exactly one ISO 4217 currency. Monetary values must use fixed-precision decimal arithmetic rather than binary floating point. The applicable Invoice Schema must define currency, decimal precision, line-level and invoice-level rounding rules, and the treatment of tax and fees.

The Verified Invoice Record must retain line amounts, subtotal, tax, fees, adjustments, and total together with the calculation inputs and rules used. V1 does not perform currency conversion or foreign-exchange calculations.

### 3.8 Invoice parties

Every invoice must model party roles explicitly:

- **Issuer:** the legal entity requesting payment.
- **Bill-To Party:** the legal entity responsible for payment.
- **Remit-To Party:** an optional party or payment destination used when funds are remitted somewhere other than the Issuer.

The generic term `payee` must not substitute for these roles. Each party must retain its resolved identity, source evidence, role, and relevant legal or payment details required by the applicable Invoice Schema.

### 3.9 Transaction File workspace

A Transaction File is the central operational workspace for one legally distinct real-estate deal. Multiple deals at the same property remain separate files with immutable internal identities. It groups deal summary, parties, dates, financials, documents, structured information requirements, linked invoices and payment status, issues, and append-only audit history. An invoice remains independently identifiable and may exist without a Transaction File.

Creation requires only property address, transaction type, assigned owner, and a named primary party with an explicit role. Internal reference, office, closing date, initial documents, and information requirements are optional. One workspace user owns the file; additional agents and coordinators may participate through role-based assignments. A deal supports multiple parties in buyer, seller, tenant, landlord, agent, lender, attorney, and title or escrow roles, with exactly one association marked primary. Default primary roles depend on transaction type and may be overridden with an audited reason.

Purchase, Sale, Lease, and Rental are default transaction types. Tenant Administrators may publish additional types or deactivate unused types without altering history. Each type may reference an immutable, versioned template defining documents, information, dates, validation, stage gates, financial requirements, payment policy, and health weights. Creation snapshots the published template. Existing files never change silently when a template changes; an authorized user previews and explicitly applies a newer version. Owners may add file-specific requirements but cannot weaken a template blocker without an audited administrator override.

The business lifecycle is `DRAFT` to `DOCUMENTS_PENDING` to `UNDER_REVIEW` to `READY_FOR_CLOSING`, ending in `CLOSED` or `CANCELLED`. Users initiate forward transitions and Transaction Processing evaluates the applicable versioned gate. `DRAFT` is always initial. Beginning work or receiving material evidence may move it to `DOCUMENTS_PENDING`. Before Review requires gate-specific documents, mandatory party details, required financials, and no unprocessed evidence. Before Approval requires all missing items and conflicts resolved. Before Closing requires verified final documents, confirmed closing date, satisfied invoice and payment policy, and no blocking issues. Material changes move a file backward to the earliest affected active stage. Deal progress must not encode ambiguity, inactivity, processing failure, or assignment; those are independent issues, statuses, or work items.

Cancellation is allowed from any active stage with a reason and does not cancel, delete, or void linked invoices. Closing is a distinct audited action available to a Tenant Administrator or assigned owner after closing validation. Reopening `CLOSED` or `CANCELLED` is administrator-only, requires a reason, and returns to `DOCUMENTS_PENDING` or `UNDER_REVIEW` according to current blockers, never directly to `READY_FOR_CLOSING`.

Workspace sections use structured records rather than one free-form JSON document. Documents progress through `MISSING`, `RECEIVED`, `VERIFIED`, `REJECTED`, or `EXPIRED`; every immutable artifact version is retained and one may be current. Required information retains typed value, completion state, verifier, provenance, and gate. Dates support date-only values and time-zone-qualified timestamps without inventing a time. Deal financials remain distinct from invoice and payment aggregates.

Invoices may use currencies different from the file's base currency. Totals must not combine currencies without an approved conversion mechanism; other currencies are shown separately. V1 tracks `UNPAID`, `SCHEDULED`, `PARTIALLY_PAID`, `PAID`, `DISPUTED`, or `VOIDED` but does not execute payments. Closing normally requires linked invoices to be approved and free of payment blockers, with policy-supported documented deferred payments. Verified invoices may be moved only through an audited review action because transaction context may change their Effective Invoice Schema.

Issues may be generated or manually created and retain category, severity, blocking status, owner, due date, resolution, and evidence links. The workspace has a persistent health header and tabs for Overview, Parties, Dates, Financials, Documents, Invoices, Issues, and History. Health shows explainable completion, missing documents, invoice conflicts, closing proximity, and outstanding approved invoice balance. Versioned weights cover blocking documents, required information and parties, dates, financials, invoices and payments, and unresolved issues. Source records remain canonical and the projection is reproducible.

The database uses a hybrid relational model. Files, associations, parties, assignments, dates, documents, requirements, invoices, payments, issues, and audit events use constrained tenant-scoped tables. JSONB is limited to immutable template or policy snapshots, normalized custom-field values, calculation detail, provenance, and metadata. Custom-field definitions remain relational with type, validation, stage gate, and template version. Audit events and superseded document versions are append-only.

## 4. Supported Evidence Artifacts

### 4.1 Required v1 inputs

The system must process:

- Email body text and email attachments received through a tenant-specific forwarding address or Microsoft 365 OAuth.
- Uploaded `.eml` messages, including Gmail-originated messages and their attachments.
- PDF and scanned PDF.
- DOCX.
- XLSX and CSV.
- JPEG, PNG, and HEIC images.
- Printed English text.
- Handwritten English text, including small scanned paper slips.

Low-quality scans and uncertain handwriting must be accepted for processing. Fields that cannot be extracted with sufficient confidence must be routed to review rather than silently omitted or invented.

### 4.2 Deferred inputs

The following are outside the initial v1 requirement:

- Legacy `.doc` and `.xls` files.
- Non-English handwriting.
- Password-protected files that have not been unlocked by the user.
- Spreadsheet macros and behavior that requires executing embedded code.

### 4.3 Evidence relationships

Evidence Artifacts are immutable source objects. Records reference them through audited Evidence Links. One Evidence Artifact may support multiple invoices, invoice fields, or Transaction Files, and each record may reference multiple Evidence Artifacts.

Linking evidence must not move, clone, or change the original artifact. Each link must identify the target record or field, relationship type, actor or automated process, confidence where applicable, and timestamps. Removing an incorrect link removes only the relationship and preserves the source artifact and its audit history.

## 5. Decoupled Architecture and Domain Schema Packs

The core platform must contain no hard-coded rules specific to real estate, logistics, or a particular invoice format. Domain-specific rules are supplied through declarative Domain Schema Packs loaded per tenant workspace.

Domain Schema Packs are an internal platform extension mechanism in v1. The product ships with one internally maintained Real Estate Domain Schema Pack. Customers cannot author, upload, execute, or directly edit complete packs. Customer configuration is limited to supported tenant-scoped settings for Invoice Schemas, templates, Approval Policies, and Conflict Precedence Policies, all of which remain validated against the pack's allowed structure.

For v1, the Real Estate Domain Schema Pack must define:

- Extraction anchors: patterns and natural-language extraction instructions for primary domain keys and invoice fields.
- Document checklist: mandatory artifact classes needed for transaction-file convergence.
- Invoice schemas and templates: required fields, validation rules, and applicability conditions.
- Conflict and precedence hierarchy: deterministic field-level authority rules, such as Signed Addendum over Purchase Agreement over Email Text.
- Canonical record schemas: the Transaction File and Verified Invoice Record output models.

The core engine remains responsible for:

- Multi-tenant data segregation through Supabase Row Level Security.
- Raw Evidence Artifact persistence and encrypted token storage.
- Mathematical blocking and multi-factor linkage scoring.
- Stateful cluster management, event-driven reactivation, and background weight tuning.
- Asynchronous processing and document compilation.

### 5.1 Conflict-precedence overrides

The Real Estate Domain Schema Pack supplies default field-level conflict-precedence rules. Tenant administrators may override those defaults for their workspace. Overrides must be declarative, scoped to specific fields or document classes, versioned, and audit-logged with actor and timestamp.

Each invoice and Transaction File must retain the Conflict Precedence Policy version used during synthesis. Conflict resolution must expose the winning value, superseded values, source evidence, and rule that selected the winner. Tenant overrides must not weaken tenant isolation or remove the underlying evidence history.

Policy changes apply to new invoices and Transaction Files by default and must not silently alter existing records. A tenant administrator may explicitly request re-evaluation of an active, non-terminal record under the latest policy. Before applying the result, the system must present and audit the prior policy version, new policy version, affected fields, previous winners, and proposed winners.

Verified or voided invoices must remain unchanged by policy re-evaluation and require an Invoice Correction. Archived Transaction Files require a Transaction File Amendment. Re-evaluating an active Transaction File or unverified invoice must follow its lifecycle transition rules and preserve the previous policy result in the audit history.

## 6. Functional Modules

### 6.1 Ingestion Gateway

V1 ingestion channels are:

- Manual drag-and-drop or file-picker upload.
- A unique forwarding address for each tenant workspace.
- Microsoft 365 OAuth ingestion.

Native Gmail OAuth and automatic Gmail mailbox synchronization are deferred. Gmail-originated messages remain supported when users forward them to the tenant address or upload them as `.eml` files.

Postmark Inbound is the v1 provider for tenant-specific forwarding addresses. The Postmark integration must remain behind the ingestion adapter so replacing the provider does not alter core processing or domain rules.

Postmark webhook handlers must authenticate inbound requests, acknowledge ingestion quickly, and shift processing to background workers. The target handler flow is:

1. Resolve and validate the tenant-specific recipient address.
2. Persist the original raw MIME message and Postmark payload to Supabase Storage before transformation and record a content checksum.
3. In one PostgreSQL transaction, insert the idempotent `canonical_events` row and its processing outbox job using the provider message identity, tenant recipient, and content checksum.
4. Let workers claim the committed outbox job through `pg-boss`; no separate non-transactional queue write is permitted.
5. Return `200 OK`, targeting completion within 300 ms.

Transport retries with the same tenant, channel, and idempotency identity must resolve to the same ingestion event and must not duplicate processing. A deliberate second receipt of identical content is a distinct ingestion event referencing a tenant-scoped content-equivalent artifact; it remains visible in receipt history but must not create a second invoice automatically. Content checksum alone is never an idempotency key.

A reconciliation job must detect and clean up unreferenced raw objects created when storage succeeds but the database transaction fails. Unknown, malformed, or inactive tenant addresses must be quarantined without exposing whether a tenant exists.

Native OAuth 2.0 ingestion must support Microsoft 365. Tokens must use KMS-backed envelope encryption with AES-256-GCM, a key hierarchy separate from the application database, rotation support, and `tenant_id` scope. Decrypted tokens must never be persisted or logged.

The ingestion layer must retain original files, media type, sender, recipients, timestamps, email metadata, and attachment relationships so downstream field provenance can point to the original evidence.

Every uploaded or received file must pass malware and safety scanning before parsing, OCR, extraction, or transmission to an AI provider. Validation must enforce compressed and expanded byte limits, page and sheet limits, image pixel limits, parser timeouts, and recursion limits. Infected, malformed, oversized, password-protected, or otherwise unsafe or unreadable files must become quarantined artifacts. Quarantine must preserve safe metadata, prevent downstream processing, and create an actionable remediation task without exposing unsafe content.

### 6.2 Multimodal Preprocessor and Token Optimization

Before model processing:

- Multi-page PDFs should pass through a `pdf-lib` pipeline that omits confidently blank pages from derived model input and chunks content into five-page segments where appropriate. The immutable original remains untouched, and every derived page retains its original page number.
- Images and sketches should be normalized through `sharp`, with a maximum target resolution of 2048 by 2048 and 85% JPEG quality where conversion does not destroy required detail.
- Spreadsheet processing must preserve sheet names, cell coordinates, displayed values, and formulas as provenance. The system must not execute macros.
- OCR must support printed and handwritten English. Low-confidence results must remain traceable to their image regions and enter review.

Evidence content is untrusted data, including text that attempts to instruct a model or application. Model calls used for extraction must have no tool permissions, must not follow document instructions, and must return schema-constrained data that passes deterministic validation before persistence. The ingestion and preprocessing pipeline must not fetch remote URLs embedded in emails or documents unless a later, separately reviewed feature explicitly allows it.

Model interactions use separately configurable extraction and multimodal-synthesis model aliases behind a token-bucket rate limiter with full-jitter exponential backoff. The initial deployment may map those aliases to Gemini 3.5 Flash-Lite and Gemini 3.8 Flash, but product behavior, schemas, tests, and stored records must not depend on provider-specific model names. Every extraction run records the provider, resolved model version, prompt/schema version, and timestamp for reproducibility.

### 6.3 Entity Resolution and Hybrid Linkage Scoring

Stage 1 uses embeddings stored in PostgreSQL with `pgvector`. A tenant-scoped k-nearest-neighbor query restricts candidate clusters, initially using cosine similarity greater than `0.65` as a tunable blocking threshold. Passing the blocking threshold only makes a record eligible for scoring; it must never imply assignment.

Stage 2 prevents assignment races with PostgreSQL transaction advisory locks through `pg_advisory_xact_lock`. Cluster evaluation and assignment are serialized by anchor key.

Candidate linkage uses a four-factor score:

```text
Score = w1*S_attr + w2*S_sem + w3*S_temp + w4*S_graph
```

Weights and thresholds must be configurable and auditable. Linkage must operate within tenant boundaries.

Each versioned Domain Schema Pack must define separate auto-link, review-band, and no-match thresholds. A candidate may auto-link only when it clears the auto-link threshold, has no hard-attribute contradiction, and wins by a configured margin over the next candidate. Review-band or near-tie results become `AMBIGUOUS`; no-match results create or retain an unlinked candidate. The engine must never force the highest-scoring match merely because one candidate ranks first.

### 6.4 Stateful Graph Accumulator

Persistent workflow state lives in PostgreSQL, but independent concerns must not be collapsed into one state enum.

#### Transaction File lifecycle

Transaction Files use `DRAFT`, `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `READY_FOR_CLOSING`, `CLOSED`, and `CANCELLED` as defined in Section 3.9. Ambiguous linkage, inactivity, approval blockers, and processing failures remain independent issues or work states. New material evidence re-evaluates gates and may move an active or ready file backward. New evidence for a closed file creates an amendment or reopening proposal without mutating closed history.

The previous implementation states `INGESTED`, `ACCUMULATING`, `AMBIGUOUS`, `CONVERGED`, `APPROVED`, `DORMANT`, and `ARCHIVED` are migration-only legacy values and must not remain customer-facing. Migration preserves the prior state in audit metadata. Invoice lifecycle remains independent.

#### Invoice lifecycle

- `INCOMPLETE_DRAFT`
- `SUSPENDED`
- `READY_FOR_VERIFICATION`
- `PENDING_REVIEW`
- `VERIFIED`
- `DISMISSED`
- `VOIDED`

An invoice reaches `READY_FOR_VERIFICATION` only after the Effective Invoice Schema passes and duplicate detection completes. The applicable Approval Policy then routes it to `PENDING_REVIEW` or directly to `VERIFIED`. A probable duplicate always routes to `PENDING_REVIEW`.

For a Generated Invoice, the transition into `VERIFIED` atomically reserves its Official Invoice Number and creates an outbox job for final PDF generation. A Captured Invoice retains its source invoice number and does not consume the generated-invoice sequence. Human-approved and automatically verified invoices use the same finalization transaction.

New evidence linked to a `VERIFIED` or `VOIDED` invoice must not mutate its canonical values. The system creates a correction candidate showing the new observations, affected fields, and proposed differences. A Reviewer must accept or dismiss that correction candidate according to the Invoice Correction workflow.

A suspended invoice preserves its evidence, values, validation results, prior state, and audit history while leaving active processing queues. A Reviewer may dismiss it with a reason. If its Transaction File reactivates, a non-dismissed invoice is revalidated and returns to `INCOMPLETE_DRAFT`; a dismissed invoice remains dismissed unless explicitly restored.

Only an Invoice Correction may move a `VERIFIED` invoice to `VOIDED`. Voiding preserves the original Verified Invoice Record, Official Invoice Number, correction reason, actor, and downstream synchronization status.

#### Independent statuses

Transaction association is tracked separately as `UNLINKED`, `AMBIGUOUS`, or `LINKED`. An unlinked invoice may become `VERIFIED` only when its Effective Invoice Schema does not require a Transaction File relationship; its linkage status remains visible in outputs and audit history.

PDF compilation is tracked separately as `NOT_REQUIRED`, `PENDING`, `READY`, or `FAILED`. Transaction dossier compilation uses the same independent status model and is required before archival only when the tenant's workflow requires a dossier.

Webhook delivery is tracked separately as `NOT_CONFIGURED`, `PENDING`, `DELIVERED`, or `DEAD_LETTER`. Canonical database persistence is a prerequisite for these statuses, not an invoice lifecycle state.

Processing jobs independently record `QUEUED`, `RUNNING`, `RETRY_SCHEDULED`, `SUCCEEDED`, or `FAILED`. Operational failure must never masquerade as a business lifecycle, validation, linkage, compilation, or delivery status.

Advancing or closing a Transaction File does not verify an invoice, and verifying an invoice does not advance or close a Transaction File.

### 6.5 Human-in-the-Loop Studio

The authenticated product opens on a work queue optimized for repeated operational use. It must support assignment, **Assigned to me**, status, blocker type, invoice origin, linkage status, age, Issuer, amount, and office filters. Counts and filters must distinguish business blockers from technical failures.

Work management is independent from invoice lifecycle. A work item may be `OPEN`, `ASSIGNED`, `WAITING_FOR_EVIDENCE`, or `DONE` without changing the invoice's business state. Marking work as `WAITING_FOR_EVIDENCE` requires a reason and optional follow-up date; it does not imply that ThreadMerge contacted an external party.

The review interface presents a chronological evidence timeline alongside the synthesized record form on wide screens. On narrow screens, the form and evidence use stable tabs or a source drawer rather than compressing two panes. Navigation must preserve unsaved reviewer edits or require an explicit discard decision.

The interface must use progressive disclosure so routine review emphasizes required actions instead of displaying all provenance metadata at once.

The default view must prioritize:

- Missing required fields and failed validation rules.
- Conflicting candidate values that require a decision.
- Probable duplicates and the records being compared.
- Suspended invoices awaiting dismissal or restoration.
- The Effective Invoice Schema fingerprint and component versions currently applied.

For an invoice in `PENDING_REVIEW`, the interface must show why review was required, the Approval Policy version, and the condition that matched when conditional review is active.

Generated, Captured, and Unlinked invoices must have distinct text labels in list and detail views. Actionable blockers must use a consistent visual hierarchy with status text and icons in addition to color, so meaning does not depend on color perception alone. Non-blocking provenance details, including confidence, extraction method, source location, precedence, and superseded values, must be hidden by default and available through field-level tooltips or an **Inspect Source** control. Opening source inspection must reveal the relevant Evidence Artifact and location without navigating away from or losing edits in the review form.

The `transaction_clusters` and invoice candidate records must use optimistic concurrency control with a `version` integer. Resolution updates must include the submitted version. If new evidence changes the record during review, the update must fail and prompt the reviewer to refresh, preventing stale overwrites.

### 6.6 Compilation, Persistence, and Delivery

PDF generation and branded dossier assembly run asynchronously on dedicated CPU-optimized Railway workers consuming `pg-boss` jobs. Rendering uses `@react-pdf/renderer` and may apply the tenant's organization logo, legal particulars, and configured image marks.

Image marks are presentational assets only. V1 must not describe them as cryptographic signatures, digital signatures, legal signatures, or proof of signing authority. Cryptographic signing and legally authorized electronic signatures are deferred until signer identity, consent, certificates, revocation, audit evidence, and jurisdictional requirements are specified.

Invoice outputs must distinguish:

- A preview or incomplete draft, which must be visibly marked and cannot be dispatched.
- A generated invoice document derived from a verified invoice candidate.
- A clean structured Verified Invoice Record, regardless of whether its source path was generated or captured.

The transition to `VERIFIED`, canonical record persistence, Official Invoice Number reservation when applicable, audit-event insertion, and outbox-job creation must occur in one PostgreSQL transaction. PDF rendering and webhook delivery happen asynchronously from the outbox and update their independent statuses. No incomplete or unverified invoice may enter PDF compilation or downstream delivery.

ThreadMerge's canonical database is the required v1 system of record. Dedicated CRM integrations are deferred until required by a named launch customer. V1 downstream integration uses a generic webhook with signed, versioned, idempotent payloads.

Webhook delivery must use exponential retry, expose attempt and response history, support authorized manual replay, and move exhausted deliveries to a visible dead-letter state. Payload signatures must include a timestamp and key identifier, support secret rotation, and document a receiver replay window. Manual and automatic retries must retain the same idempotency key for the same logical event. A webhook failure or dead-letter outcome must never roll back or invalidate canonical persistence.

V1 outbound delivery is limited to customer download, Transaction File dossier inclusion, canonical persistence, and the generic webhook. Direct sending to invoice parties is deferred until recipient authorization, delivery evidence, bounce handling, retry, revocation, and correction behavior are specified.

### 6.7 Customer-facing invoice output

Every completed invoice must expose an Invoice Output Bundle containing:

- The normalized, structured Verified Invoice Record.
- A final tenant-branded PDF for a Generated Invoice.
- The unmodified original source invoice for a Captured Invoice.
- Its Transaction File relationship when resolved, or its current linkage status otherwise.
- Field-level evidence links and provenance.
- Validation, conflict-resolution, and approval history.
- Canonical persistence and downstream webhook status, including an actionable failure state when delivery does not complete.
- Downloadable PDF and CSV/JSON exports as applicable.
- Optional inclusion in a compiled Transaction File dossier.

The product's primary value is the verified structured record together with its review workflow and evidence trail. An API or JSON response alone does not satisfy the customer-facing output requirement.

### 6.8 Corrections and voiding

A persisted or dispatched invoice must never be overwritten in place. A correction creates an immutable, versioned Invoice Correction linked to the original and records the reason, actor, changed fields, timestamps, and downstream synchronization status.

Voiding is a correction outcome and must preserve the original invoice. When an affected invoice was previously dispatched, the system must deliver or expose the correction through the same downstream channel and track whether synchronization succeeds. V1 does not silently retract or replace downstream data.

### 6.9 Payment status

Payment execution, bank reconciliation, and accounts-receivable collection are outside v1 scope. ThreadMerge tracks payment status and external references for closing readiness, while the customer's accounting or payment system remains authoritative. Status changes must be manual or received through an audited integration; ThreadMerge does not move funds.

### 6.10 Operational failures and notifications

When technical processing fails, the system must record a processing failure containing the reason, failed stage, last successful stage, attempt count, timestamps, and remediation status. Transient failures must retry automatically with bounded exponential backoff. Permanent or exhausted failures must be visible to authorized users and support manual retry without repeating completed idempotent work.

In-app work queues are required for blockers, review tasks, quarantined artifacts, suspended invoices, revoked approvals, processing failures, and dead-letter webhook deliveries. Tenant Administrators may configure email notifications as immediate alerts or digests for these events. Slack and Microsoft Teams notifications are outside v1 scope.

## 7. Performance and Service Targets

The following are engineering targets for v1, not contractual service-level commitments:

- Acknowledge inbound Postmark webhooks within 300 ms under normal operating conditions.
- Show a successful ingestion receipt in the tenant workspace within five seconds.
- Complete ordinary invoice processing within two minutes under normal operating conditions.
- Show stage-level progress for large documents and Transaction File dossiers rather than presenting an indefinite loading state.
- Maintain a recovery-point objective of 15 minutes and a recovery-time objective of four hours for canonical PostgreSQL data and required object metadata.

The product must collect latency, throughput, retry, queue-depth, failure-rate, and provider-dependency telemetry without logging sensitive content. Automated backups, point-in-time recovery where supported, and restore procedures must be enabled before production activation, and a restore test must pass before launch and at least quarterly thereafter. Contractual availability or processing-time SLAs must not be offered until production telemetry establishes defensible targets.

## 8. Acceptance Criteria for Invoice Processing

The v1 invoice workflow is acceptable when:

1. Facts from multiple Evidence Artifacts can be linked to one invoice candidate even when they arrive in unrelated email threads.
2. A complete Generated Invoice can be assembled from a combination of email text, images, documents, and spreadsheets.
3. A pre-existing invoice can be captured into the same canonical structure.
4. Every populated field exposes source provenance and extraction method.
5. Missing or uncertain required data produces an Incomplete Invoice Draft with actionable review items.
6. Configured validation rules prevent premature finalization, creation of a Verified Invoice Record, issued-invoice export, and downstream delivery while still allowing draft persistence for review.
7. A reviewer can resolve missing or conflicting fields without losing concurrently ingested evidence.
8. Both generated and captured paths produce a Verified Invoice Record persisted first to ThreadMerge's canonical database and suitable for downstream delivery.
9. Tenant data, configuration, evidence, and vector searches remain isolated by tenant.
10. An invoice can be retained, processed, and reviewed before a Transaction File relationship is resolved.
11. An unlinked invoice composes its Effective Invoice Schema from the brokerage default and an unambiguous invoice-party template, then revalidates when linkage supplies more-specific context.
12. Transaction inactivity is an independent issue or work state and never deletes data, changes unrelated invoices, or replaces the deal lifecycle.
13. The default review view emphasizes blockers while complete field provenance remains available on demand.
14. A Transaction File advances only when its versioned stage gate passes; `READY_FOR_CLOSING` does not close the deal or verify an invoice.
15. Material evidence re-evaluates stage gates, may move an active file backward, and records the evidence, prior stage, new stage, reason, actor, and time.
16. Each validation-complete invoice is routed through its versioned Approval Policy to human review or automatic verification, with the decision and matched condition retained for audit.
17. Tenant-admin precedence overrides determine field-level winners without deleting superseded values or their provenance, and every resolved record retains the policy version used.
18. Precedence changes affect new records by default; active records require explicit audited re-evaluation, verified invoices require correction, and closed Transaction Files require amendment or controlled reopening.
19. Role permissions are enforced within tenant boundaries, and no v1 human or integration identity can access multiple tenant workspaces through a single role assignment.
20. Gmail-originated messages complete the invoice workflow through forwarding or `.eml` upload without requiring native Gmail OAuth.
21. V1 uses the internally maintained Real Estate Domain Schema Pack and rejects customer-authored or uploaded packs while permitting supported tenant-level configuration.
22. A completed Generated Invoice and Captured Invoice each expose the applicable full Invoice Output Bundle, including persistence status and exportable results.
23. Official Invoice Numbers are assigned atomically only when Generated Invoices are finalized; captured source numbers and internal IDs remain distinct.
24. Probable duplicates always require human resolution and are never silently merged or deleted.
25. Verified and voided invoices remain immutable; corrections and voids preserve the original and track downstream synchronization.
26. V1 persists canonically before optional generic-webhook delivery and does not send invoices directly to invoice parties.
27. Every invoice uses one ISO 4217 currency and fixed-precision, rule-driven arithmetic without currency conversion.
28. Every invoice distinguishes Issuer, Bill-To Party, and optional Remit-To Party with role-specific evidence.
29. Generated Invoices reserve their Official Invoice Number and enqueue final PDF generation atomically upon verification; Captured Invoices retain their source number.
30. Transaction File review, closing, cancellation, reopening, and dossier compilation remain independent from invoice verification.
31. Evidence Artifacts can support multiple records through audited links without moving or duplicating source objects.
32. V1 tracks payment status and external references but does not execute payments or perform currency conversion.
33. Branding image marks are not represented as cryptographic or legally authorized signatures.
34. An unlinked invoice can be verified only when its Effective Invoice Schema permits it, and its unlinked status remains visible.
35. Official Invoice Number sequences are issuer-scoped, optionally office-qualified, tenant-unique, and never reuse reserved numbers.
36. Transaction stage actions enforce role permissions: Admins configure, owners manage active files, Reviewers resolve and verify, and Viewers remain read-only.
37. Material evidence moves an active file to the earliest affected stage or creates a closed-file amendment/reopening proposal without overwriting history.
38. Webhook delivery is signed, versioned, idempotent, retryable, manually replayable, and operationally independent from canonical persistence.
39. Technical failures retain stage and retry context without being confused with business-validation states.
40. Unsafe or unreadable files are quarantined before parsing or AI transmission and create safe remediation tasks.
41. Required in-app queues and configurable email alerts expose operational and review work without requiring Slack or Teams.
42. V1 performance targets are observable but are not represented as contractual SLAs.
43. Production processing remains blocked until the complete tenant activation checklist passes and is audited.
44. Support personnel cannot access tenant content without explicit, expiring, least-privilege, fully audited authorization.
45. Extracted Observations remain distinct from Resolved Field Values and cannot write directly to a Verified Invoice Record.
46. One artifact may yield multiple invoice candidates, and one invoice candidate may accumulate evidence from multiple artifacts without losing source locations.
47. Ambiguous Generated-versus-Captured classification requires review before verification or number allocation.
48. Transport retries are idempotent, while deliberate repeated receipts remain visible without automatically duplicating invoice candidates.
49. Entity resolution uses distinct blocking, auto-link, review-band, no-match, contradiction, and winning-margin rules and never forces the top-ranked candidate.
50. Equal-authority field conflicts remain unresolved unless the versioned Conflict Precedence Policy explicitly defines a tie-breaker.
51. New evidence for a verified or voided invoice creates a correction candidate and never mutates canonical values directly.
52. Transaction File creation requires only property address, configured transaction type, eligible owner, and named primary party with an allowed role.
53. Transaction Files use the `DRAFT`, `DOCUMENTS_PENDING`, `UNDER_REVIEW`, `READY_FOR_CLOSING`, `CLOSED`, and `CANCELLED` lifecycle.
54. Versioned transaction templates populate structured requirements without silently changing existing files.
55. The health summary is explainable, versioned, reproducible from canonical relational records, and never combines unsupported currencies.
56. Document versions and audit history remain append-only; ordinary editing cannot delete them.
57. Closing validates final documents, closing date, linked-invoice approval, payment policy, and blocking issues, while cancellation retains independent invoice records.
58. Work assignment and waiting status remain independent from invoice lifecycle, and defensible deletion does not retain sensitive payloads inside audit events.
59. Every production human user uses MFA, invitations and sessions are revocable, and non-human credentials are scoped, rotatable, and non-interactive.
60. Automatic verification remains disabled for an affected profile until calibrated evaluation and deterministic validation pass for its current model, prompt, schema, and preprocessing versions.
61. Production data and object metadata meet documented backup, restore-test, RPO, and RTO requirements.

## 9. Security, Compliance, and Data Governance

Invoices, emails, Transaction Files, Evidence Artifacts, extracted fields, and related identity data must be treated as confidential financial and personal data.

### 9.1 Security controls

The system must:

- Use managed authentication with verified email ownership and MFA for every production human user.
- Make tenant invitations single-use and expiring; prevent public self-enrollment into an existing tenant.
- Support immediate membership, session, and credential revocation.
- Store Integration Account credentials only as scoped, expiring or rotatable secrets and prevent their use for interactive login.
- Encrypt data in transit and at rest.
- Store OAuth tokens, webhook credentials, and downstream integration secrets in dedicated encrypted secret storage rather than ordinary application fields or logs.
- Enforce tenant isolation across database rows, object storage, queues, caches, logs, embeddings, vector searches, and generated outputs.
- Apply least-privilege access to human roles, Integration Accounts, workers, and service providers.
- Prevent sensitive message bodies, attachments, extracted values, credentials, and model prompts from appearing in ordinary application logs.
- Record access to sensitive records and evidence in the audit history.
- Require background workers and Integration Accounts to establish explicit tenant context for every read, write, storage operation, vector query, and job claim; privileged service credentials must not become an implicit bypass around tenant checks.
- Neutralize spreadsheet-formula execution in CSV exports while preserving the canonical unescaped value in the database.
- Keep production data out of development and test environments; approved debugging uses redacted fixtures or the audited support-access workflow.

Support personnel must have no standing access to tenant content. Diagnostic access requires explicit tenant approval and must be time-limited, least-privilege, scoped to a stated reason, revocable, and fully audit-logged. Expiration must remove access automatically. Emergency access, if later supported, requires a separately approved and audited break-glass policy and is not implied by ordinary support roles.

### 9.2 Audit history

The system must maintain tamper-evident, append-only audit events for:

- Ingestion and tenant routing.
- Extraction, calculation, and entity-linkage decisions.
- Field edits and conflict resolution.
- Approval and automatic-verification decisions.
- Schema, Approval Policy, Conflict Precedence Policy, role, and integration changes.
- Persistence, dispatch, suspension, restoration, dismissal, and correction.
- Export, legal-hold, retention, and deletion actions.

Each event must identify the tenant, record, actor or service identity, action, timestamp, and relevant policy or configuration version. Audit events must preserve before-and-after metadata where a value or policy changes without duplicating sensitive document content unnecessarily.

Audit immutability does not authorize indefinite retention of deleted customer content. Audit events should reference stable IDs, policy versions, hashes, and non-sensitive change metadata rather than copying source content. Defensible deletion removes or irreversibly anonymizes personal and financial payloads while retaining only the minimum non-sensitive event and deletion receipt required to prove that the action occurred.

### 9.3 AI and service providers

Customer data must not be used to train first-party or third-party models. AI, OCR, email, storage, hosting, observability, and other subprocessors must be covered by contractual data-handling terms appropriate to the product's confidential financial and personal data.

Only the minimum data required for a processing task may be sent to a provider. Provider selection and configuration must account for data retention, deletion, access controls, regional processing, incident notification, and prohibitions on model training.

### 9.4 Retention, legal hold, export, and deletion

Retention must be controlled by a versioned Data Governance Policy configured per tenant rather than by a single hardcoded jurisdictional period. Tenant administrators may configure supported retention rules, subject to product-enforced minimum operational requirements.

A tenant workspace must not activate production ingestion or processing until a Tenant Administrator completes the production activation checklist:

- Configure at least one legal Issuer and its required legal details.
- Configure the default Invoice Schema.
- Configure an Official Invoice Number sequence.
- Confirm or change the default Approval Policy.
- Select and acknowledge the initial Data Governance Policy and retention rules.
- Assign the initial Tenant Administrator and Reviewer roles.
- Enable at least one v1 ingestion route.

The system must not silently default to indefinite retention or infer a statutory period. The activation event must audit the administrator, completed checklist, selected configuration versions, retention acknowledgment, and timestamp. Production ingestion must remain blocked until every required item passes validation.

The system must:

- Support legal holds scoped to applicable records and Evidence Artifacts.
- Suspend ordinary expiration and deletion while a legal hold is active.
- Support tenant export of records, evidence, configuration versions, and audit history in usable formats.
- Support defensible deletion after the configured retention period when no legal hold or other recorded restriction applies.
- Propagate deletion to primary storage, derived artifacts, search indexes, embeddings, and provider-held copies where contractually and technically supported.
- Retain non-sensitive deletion receipts sufficient to demonstrate what policy ran, when it ran, and whether each deletion stage completed.

Security and retention behavior must be validated against applicable customer, contractual, and jurisdictional requirements before production deployment; this PRD does not prescribe a universal statutory retention period.
