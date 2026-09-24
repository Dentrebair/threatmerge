# ThreadMerge Domain Context

ThreadMerge turns fragmented real-estate transaction evidence into verified invoices and reviewable Transaction Files. This glossary defines the canonical language shared by product, design, and engineering.

## Product Boundaries

**Entity Resolution Engine**:
Reusable infrastructure that determines which fragments refer to the same business entity and synthesizes their facts.
_Avoid_: ThreadMerge app, invoice product

**Real Estate Invoice Processing App**:
The initial customer-facing product built on the Entity Resolution Engine for real-estate invoices and Transaction Files.
_Avoid_: engine, platform

**Domain Schema Pack**:
An internally maintained definition of a vertical's extraction anchors, document checklist, default precedence, and canonical records. V1 has one Real Estate Domain Schema Pack.
_Avoid_: customer template, tenant settings

## Evidence And Transactions

**Evidence Artifact**:
Immutable source material from which the system derives facts, such as an email, attachment, scan, image, document, spreadsheet, CSV, or handwritten slip.
_Avoid_: processed document, invoice

**Evidence Link**:
An auditable relationship from an Evidence Artifact to a record or field. One artifact may support multiple records without being copied or moved.
_Avoid_: attachment ownership

**Extracted Observation**:
A claimed value derived from a specific location in an Evidence Artifact. It is evidence for resolution, not a canonical invoice value.
_Avoid_: invoice field, verified value

**Transaction File**:
The record of one real-estate transaction. A property may have many Transaction Files over time, and a Transaction File may reference many invoices.
_Avoid_: property, invoice folder, Golden Record

**Converged Transaction File**:
A Transaction File whose current required artifacts and fields are present, whose conflicts are resolved, and whose confidence requirements pass. It is ready for final review, not yet approved.
_Avoid_: completed file, approved file

**Dormant Transaction File**:
An accumulating Transaction File with no qualifying activity for the tenant's configured inactivity period. New matching evidence may reactivate it.
_Avoid_: timed-out transaction, deleted transaction

**Transaction File Amendment**:
A versioned change created when material evidence arrives after a Transaction File is archived. It preserves the archived version.
_Avoid_: edit, overwrite

## Invoices

**Closing Financial Document**:
The umbrella category for invoices, commission agreements, fee sheets, escrow instructions, settlement statements, and related financial documents.
_Avoid_: invoice when the document does not request payment

**Generated Invoice**:
An invoice assembled from facts distributed across Evidence Artifacts when no complete source invoice exists.
_Avoid_: Captured Invoice

**Captured Invoice**:
A pre-existing invoice extracted from an Evidence Artifact into structured form.
_Avoid_: Generated Invoice

**Invoice Candidate**:
An unverified invoice assembled from related Extracted Observations and reviewer input. It becomes a Verified Invoice Record only after all applicable rules pass.
_Avoid_: invoice record, Verified Invoice Record

**Unlinked Invoice**:
An invoice whose relationship to a Transaction File is unresolved. Linking adds transaction context but does not create or redefine the invoice.
_Avoid_: orphan invoice

**Incomplete Invoice Draft**:
An invoice candidate with a missing, conflicting, or insufficiently supported required field. It cannot be finalized or delivered.
_Avoid_: failed invoice

**Suspended Invoice**:
An Incomplete Invoice Draft removed from active work because its linked Transaction File became dormant.
_Avoid_: dismissed invoice, deleted invoice

**Verified Invoice Record**:
The canonical structured record produced after a Generated or Captured Invoice passes validation and its Approval Policy.
_Avoid_: approved Transaction File, PDF

**Invoice Output Bundle**:
The customer-facing result containing the Verified Invoice Record, applicable invoice document, provenance, history, linkage, and delivery status.
_Avoid_: API response

**Official Invoice Number**:
The customer-facing number assigned to a Generated Invoice at verification from its legal Issuer's sequence. A Captured Invoice retains its source number.
_Avoid_: internal invoice ID

**Duplicate Candidate**:
An invoice sufficiently similar to another invoice to require a reviewer to merge it, distinguish it, or dismiss it.
_Avoid_: duplicate invoice until reviewed

**Invoice Correction**:
A versioned amendment to a verified or voided invoice that preserves the original. Voiding is a correction outcome, not deletion.
_Avoid_: edit, overwrite, delete

**Resolved Field Value**:
The currently selected canonical value for an Invoice Candidate after applying evidence, precedence, calculation, conflict, and reviewer decisions.
_Avoid_: Extracted Observation

## Invoice Parties

**Issuer**:
The legal entity requesting payment through an invoice.
_Avoid_: payee

**Bill-To Party**:
The legal entity responsible for paying an invoice.
_Avoid_: recipient, customer when the legal role is meant

**Remit-To Party**:
The optional party or payment destination that receives funds when it differs from the Issuer.
_Avoid_: Issuer, payee

## Rules And Evidence

**Invoice Schema**:
A versioned tenant definition of invoice fields and validation rules. It is an input to an Effective Invoice Schema.
_Avoid_: Domain Schema Pack, invoice form

**Effective Invoice Schema**:
The deterministic combination of the brokerage default and applicable invoice-party, office, and transaction-type templates used to validate one invoice.
_Avoid_: selected template

**Approval Policy**:
A versioned tenant rule that routes a valid invoice to human review or automatic verification. It never bypasses validation, conflict, confidence, or duplicate safeguards.
_Avoid_: validation policy

**Conflict Precedence Policy**:
A versioned field-level rule that determines which source governs when Evidence Artifacts disagree while preserving superseded values.
_Avoid_: Approval Policy

**Field Provenance**:
The evidence trail for a field, including its source, derivation method, confidence, precedence result, and reviewer changes.
_Avoid_: audit log

**Data Governance Policy**:
A versioned tenant policy for retention, legal holds, export, and deletion of confidential financial and personal data.
_Avoid_: Invoice Schema

## Actors

**Brokerage Operations Team**:
The initial customer organization responsible for operating the product.
_Avoid_: tenant when discussing people

**Transaction Coordinator**:
The primary daily user who reviews evidence, resolves ambiguity, verifies invoices, and prepares closing outputs.
_Avoid_: Tenant Administrator

**Tenant Administrator**:
A tenant-scoped user who manages users, policies, schemas, and integrations and may also perform review work.
_Avoid_: platform administrator

**Reviewer**:
A tenant-scoped user who resolves invoice and Transaction File work but cannot change tenant policies.
_Avoid_: approver when separation of duties applies

**Viewer/Auditor**:
A tenant-scoped user with read-only access to records, evidence, and audit history.

**Integration Account**:
A tenant-scoped non-human identity limited to configured ingestion and downstream actions.
_Avoid_: user, support account

**Work Item**:
A review or remediation task associated with a record without being part of that record's business lifecycle.
_Avoid_: invoice state, Transaction File state
