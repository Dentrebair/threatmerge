---
status: accepted
---

# Give each domain record one owning module

Evidence, observations, invoices, Transaction Files, work items, and publication attempts each have one owning module; other modules use its interface or consume committed events instead of sharing table writes. This costs some explicit command and event design, but prevents extraction, queues, UI handlers, and delivery workers from independently mutating the same lifecycle and makes each module's interface the stable test surface.
