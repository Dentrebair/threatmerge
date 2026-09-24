---
status: accepted
---

# Persist canonically before downstream delivery

ThreadMerge's PostgreSQL database is the v1 system of record, and downstream PDF or webhook work starts from a transactional outbox only after canonical persistence. This favors recoverability and auditability over synchronous delivery: provider failures can be retried without losing verification results, reusing invoice numbers, or rolling back business state.
