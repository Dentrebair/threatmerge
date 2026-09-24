# Background Workers

Uploads are stored first, then processed by server-side workers. The browser must never receive the Supabase service-role key or malware-scanner credentials.

## Evidence safety worker

> Deferred: production activation belongs to Sprint 9. The worker is disabled unless `MALWARE_SCANNING_ENABLED=true` is explicitly set in its server-only environment.

For local workflow testing, use the development validator. It verifies that PDF, JPG, and PNG contents match their file signatures, but it is **not malware protection** and cannot run when `NODE_ENV=production`.

The evidence worker claims queued `SCAN_EVIDENCE` jobs, downloads each private object, sends its bytes to the configured malware scanner, and records the result. Safe transaction documents then become available in the Transaction File; unsafe files remain quarantined.

1. Copy `.env.worker.example` to `.env.worker.local`.
2. Add the Supabase project URL, service-role key, and approved scanner credentials.
3. Complete the activation gate in `SCALING.md`.
4. Set `MALWARE_SCANNING_ENABLED=true` and start the long-running worker with `npm run worker:evidence`.

For local development instead, add only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `.env.worker.local`, then run `npm run worker:evidence:dev`. Keep that terminal open while testing uploads. The app refreshes pending uploads automatically, so a validated document will replace its waiting row without a page reload.

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

## Invoice extraction worker

The extraction worker claims `EXTRACT_EVIDENCE` jobs only after evidence has passed its safety check. It downloads the private object, sends it to a configured document-extraction provider, validates the provider response, and records versioned observations. Invoice assembly remains a separate queued step.

Production extraction is not active until an approved provider endpoint is configured. The application may accept uploads without this worker, but safe invoices will remain at the extraction stage.

1. Add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DOCUMENT_EXTRACTOR_URL`, and `DOCUMENT_EXTRACTOR_TOKEN` to `.env.worker.local`.
2. Optionally tune the batch size, polling delays, and request timeout using `.env.worker.example`.
3. Start the long-running process with `npm run worker:extraction`.

The extractor receives a multipart `POST` request whose `document` field contains the uploaded file. It must return version metadata and no more than 200 observations:

```json
{
  "provider": "provider-name",
  "modelVersion": "model-version",
  "promptVersion": "prompt-version",
  "startedAt": "2026-09-24T08:00:00.000Z",
  "observations": [
    {
      "fieldName": "invoiceNumber",
      "value": "INV-42",
      "sourceLocation": { "page": 1 },
      "confidence": 0.97
    }
  ]
}
```

Invalid provider responses fail the job without writing observations. Provider errors and timeouts are recorded as unavailable-provider failures so the queue retry policy can handle them. Run this worker as a monitored server-side service; its service-role key and provider token must never be exposed to the browser.

### Railway adapter deployment

`railway-extraction.toml` defines a separate Railway service for the provider-neutral adapter. Configure the service to use that file, then set `EXTRACTION_ADAPTER_TOKEN`, `EXTRACTION_ENGINE_URL`, and `EXTRACTION_ENGINE_TOKEN` in Railway. The adapter exposes `/health` and authenticated `/extract` routes, accepts PDF/JPG/PNG files up to 5 MB, and returns a concise error when the extraction engine is unavailable.

After Railway deploys the service, set the worker's `DOCUMENT_EXTRACTOR_URL` to `https://<railway-domain>/extract` and set `DOCUMENT_EXTRACTOR_TOKEN` to the same value as Railway's `EXTRACTION_ADAPTER_TOKEN`. Railway supplies the domain; the selected OCR/model provider supplies the engine endpoint and credentials. Do not reuse the adapter token as the engine token.
