import { timingSafeEqual } from "node:crypto";

const MAX_WEBHOOK_BYTES = 15 * 1024 * 1024;

export interface PostmarkInboundReceipt {
  messageId: string;
  originalRecipient: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  rawEmail: string;
  payload: Record<string, unknown>;
}

export interface PostmarkInboundBackend {
  receive(receipt: PostmarkInboundReceipt): Promise<{ ingestionEventId: string; duplicate: boolean }>;
}

export interface PostmarkInboundAuth {
  username: string;
  password: string;
}

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorized(header: string | null, auth: PostmarkInboundAuth): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator > 0 && secureEqual(decoded.slice(0, separator), auth.username) && secureEqual(decoded.slice(separator + 1), auth.password);
  } catch {
    return false;
  }
}

function text(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function requiredString(payload: Record<string, unknown>, key: string, maximum: number): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum ? value.trim() : null;
}

export function createPostmarkInboundHandler(backend: PostmarkInboundBackend, auth: PostmarkInboundAuth) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return text(200, { status: "ok" });
    if (request.method !== "POST" || url.pathname !== "/webhooks/postmark/inbound") return text(404, { error: "not_found" });
    if (!isAuthorized(request.headers.get("authorization"), auth)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Basic realm=postmark-inbound", "cache-control": "no-store" } });
    }
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) return text(413, { error: "payload_too_large" });
    let payload: Record<string, unknown>;
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) return text(413, { error: "payload_too_large" });
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      payload = parsed as Record<string, unknown>;
    } catch {
      return text(400, { error: "invalid_payload", message: "The inbound email payload is invalid." });
    }
    const messageId = requiredString(payload, "MessageID", 256);
    const originalRecipient = requiredString(payload, "OriginalRecipient", 320);
    const from = requiredString(payload, "From", 1000);
    const to = requiredString(payload, "To", 4000);
    const rawEmail = requiredString(payload, "RawEmail", MAX_WEBHOOK_BYTES);
    if (!messageId || !originalRecipient || !from || !to || !rawEmail) {
      return text(400, { error: "invalid_payload", message: "MessageID, OriginalRecipient, From, To, and RawEmail are required." });
    }
    const result = await backend.receive({ messageId, originalRecipient: originalRecipient.toLowerCase(), from, to,
      subject: typeof payload.Subject === "string" ? payload.Subject.slice(0, 2000) : "",
      receivedAt: typeof payload.Date === "string" && !Number.isNaN(Date.parse(payload.Date)) ? new Date(payload.Date).toISOString() : new Date().toISOString(),
      rawEmail, payload });
    return text(200, { status: result.duplicate ? "duplicate" : "accepted", ingestionEventId: result.ingestionEventId });
  };
}
