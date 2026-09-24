# Background Workers

Uploads are stored first, then processed by server-side workers. The browser must never receive the Supabase service-role key or malware-scanner credentials.

## Evidence safety worker

> Deferred: production activation belongs to Sprint 9. The worker is disabled unless `MALWARE_SCANNING_ENABLED=true` is explicitly set in its server-only environment.

The evidence worker claims queued `SCAN_EVIDENCE` jobs, downloads each private object, sends its bytes to the configured malware scanner, and records the result. Safe transaction documents then become available in the Transaction File; unsafe files remain quarantined.

1. Copy `.env.worker.example` to `.env.worker.local`.
2. Add the Supabase project URL, service-role key, and approved scanner credentials.
3. Complete the activation gate in `SCALING.md`.
4. Set `MALWARE_SCANNING_ENABLED=true` and start the long-running worker with `npm run worker:evidence`.

`.env.worker.local` is ignored by Git. Never prefix its variables with `VITE_`; doing so would expose server credentials to the browser bundle.

The scanner endpoint receives `POST` requests with `application/octet-stream` content and a bearer token. It must return JSON in one of these forms:

```json
{ "safe": true }
```

```json
{ "safe": false, "reason": "MALWARE_DETECTED" }
```

The worker polls while idle, backs off after database claim failures, retries failed jobs through the database queue policy, and exits cleanly on `SIGINT` or `SIGTERM`. The application can accept uploads without the worker, but those uploads remain pending until a worker is connected.

For production, run at least one worker as a separately monitored service. Configure restart-on-failure, capture structured logs, and alert on old queued jobs. Use an approved malware-scanning service; do not replace safety scanning with automatic success.
