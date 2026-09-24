---
status: accepted
---

# Separate business lifecycles from operational statuses

Invoice lifecycle, Transaction File lifecycle, transaction linkage, processing jobs, PDF compilation, and webhook delivery are independent state dimensions. We keep them separate because collapsing them into one enum makes valid combinations impossible, couples business approval to infrastructure outcomes, and causes retries or delivery failures to corrupt domain state.
