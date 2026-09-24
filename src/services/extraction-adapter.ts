import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { validateExtractionResult, type ExtractionResult } from "../workers/extraction-worker.js";

const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

export interface ExtractionEngine {
  extract(file: File): Promise<ExtractionResult>;
}

export interface ExtractionAdapterConfig {
  token: string;
  port: number;
  engineUrl: string;
  engineToken: string;
  engineTimeoutMs: number;
}

function matchesToken(actual: string | null, expected: string): boolean {
  if (!actual?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(actual.slice(7));
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function createExtractionAdapterHandler(engine: ExtractionEngine, token: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json(200, { status: "ok" });
    if (request.method !== "POST" || url.pathname !== "/extract") return json(404, { error: "not_found" });
    if (!matchesToken(request.headers.get("authorization"), token)) return json(401, { error: "unauthorized" });
    try {
      const form = await request.formData();
      const document = form.get("document");
      if (!(document instanceof File)) return json(400, { error: "document_required", message: "Attach one document using the document field." });
      if (!SUPPORTED_TYPES.has(document.type)) return json(415, { error: "unsupported_file_type", message: "Upload a PDF, JPG, or PNG file." });
      if (document.size < 1 || document.size > MAX_DOCUMENT_BYTES) return json(413, { error: "invalid_file_size", message: "The document must be no larger than 5 MB." });
      return Response.json(validateExtractionResult(await engine.extract(document)), { headers: { "cache-control": "no-store" } });
    } catch (reason) {
      console.error("Extraction adapter request failed", reason);
      return json(502, { error: "extraction_unavailable", message: "Document extraction is temporarily unavailable." });
    }
  };
}

export class RemoteExtractionEngine implements ExtractionEngine {
  constructor(private readonly endpoint: string, private readonly token: string, private readonly timeoutMs: number) {}

  async extract(file: File): Promise<ExtractionResult> {
    const form = new FormData();
    form.set("document", file, file.name);
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Error(`extraction engine unavailable (${response.status})`);
    return validateExtractionResult(await response.json());
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadExtractionAdapterConfig(environment: NodeJS.ProcessEnv): ExtractionAdapterConfig {
  const port = Number(environment.PORT ?? "8788");
  const engineTimeoutMs = Number(environment.EXTRACTION_ENGINE_TIMEOUT_MS ?? "60000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port number");
  if (!Number.isSafeInteger(engineTimeoutMs) || engineTimeoutMs < 1_000 || engineTimeoutMs > 300_000) throw new Error("EXTRACTION_ENGINE_TIMEOUT_MS must be between 1000 and 300000");
  const engineUrl = required(environment, "EXTRACTION_ENGINE_URL");
  const parsed = new URL(engineUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("EXTRACTION_ENGINE_URL must be an HTTP(S) URL");
  return {
    token: required(environment, "EXTRACTION_ADAPTER_TOKEN"),
    port,
    engineUrl,
    engineToken: required(environment, "EXTRACTION_ENGINE_TOKEN"),
    engineTimeoutMs,
  };
}

async function main() {
  const config = loadExtractionAdapterConfig(process.env);
  const handler = createExtractionAdapterHandler(new RemoteExtractionEngine(config.engineUrl, config.engineToken, config.engineTimeoutMs), config.token);
  const server = createServer(async (incoming, outgoing) => {
    const origin = `http://${incoming.headers.host ?? "localhost"}`;
    const request = new Request(new URL(incoming.url ?? "/", origin), {
      method: incoming.method,
      headers: incoming.headers as HeadersInit,
      body: incoming.method === "GET" || incoming.method === "HEAD" ? undefined : incoming as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(config.port, "0.0.0.0", () => console.log(`Extraction adapter listening on port ${config.port}`));
}

if (process.env.RUN_EXTRACTION_ADAPTER === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
