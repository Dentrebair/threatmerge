# Sprint 3: Transaction Linkage Foundation

## Status

Completed foundation. The customer-facing Transaction Workspace redesign continues in Sprints 4-8 of [the delivery roadmap](ROADMAP.md).

## Goal

Prove that standalone invoices can be safely proposed, compared, linked, and retained independently from a Transaction File, while establishing tenant-safe persistence and audited requirement commands.

## Delivered

- Stable Transaction File identity distinct from property identity.
- Standalone `UNLINKED` invoices and explained linkage proposals.
- Manual proposal acceptance/rejection with optimistic concurrency and audit history.
- Linked-invoice ownership shown only on the correct Transaction File.
- Initial requirement tracking, readiness guards, detail editing, and transaction-specific requirement commands.
- Cascading behavior limited to invoices actually linked to the affected file.
- RLS, role checks, stale-version handling, negative database tests, and workspace UI tests.

## Superseded Decisions

The prototype lifecycle (`INGESTED`, `ACCUMULATING`, `AMBIGUOUS`, `CONVERGED`, `APPROVED`, `DORMANT`, `ARCHIVED`) and generic Transaction File approval are no longer the target customer model. They remain migration inputs until Sprint 4 replaces them with the PRD v1.5 deal lifecycle. Ambiguity and inactivity become independent issues or work states.

Free-text requirement entry and the compact Transaction File screen are transitional. Sprints 5-8 replace them with lightweight creation, versioned templates, structured workspace sections, stage gates, health projections, and explicit closing actions.

## Preserved Invariants

- Invoice and Transaction File identities and lifecycles remain independent.
- Transaction linkage is a coordinated audited command, never a mutable UI flag.
- Entity Resolution proposes; owning modules commit.
- An invoice may remain unlinked and is never discarded because no deal match exists.
- One property may have multiple distinct Transaction Files.
- Closing or cancelling a Transaction File never verifies, voids, dismisses, or deletes an invoice.
