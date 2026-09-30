import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPPORTED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
// Telegram's own Bot API ceiling for files a bot can download.
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UPDATE_BYTES = 1 * 1024 * 1024;

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: { username?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  photo?: Array<{ file_id: string; file_size?: number }>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramFileMessage {
  chatId: number;
  messageId: number;
  fromUsername: string | null;
  fileId: string;
  fileName: string;
  mediaType: string;
}

export interface TelegramInboundBackend {
  receive(input: TelegramFileMessage): Promise<{ ingestionEventId: string; duplicate: boolean }>;
  reject(chatId: number, reason: string): Promise<void>;
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function extractFile(message: TelegramMessage): { fileId: string; fileName: string; mediaType: string } | null {
  if (message.document) {
    return { fileId: message.document.file_id, fileName: message.document.file_name ?? `document-${message.message_id}`, mediaType: message.document.mime_type ?? "" };
  }
  if (message.photo?.length) {
    // Telegram sends the same photo at several resolutions; the largest carries the most
    // detail for a handwritten or low-quality scan, so prefer it over lower resolutions.
    const largest = message.photo.reduce((best, candidate) => (candidate.file_size ?? 0) > (best.file_size ?? 0) ? candidate : best);
    return { fileId: largest.file_id, fileName: `photo-${message.message_id}.jpg`, mediaType: "image/jpeg" };
  }
  return null;
}

export function createTelegramInboundHandler(backend: TelegramInboundBackend, webhookSecret: string) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json(200, { status: "ok" });
    if (request.method !== "POST" || url.pathname !== "/webhooks/telegram/inbound") return json(404, { error: "not_found" });
    // Telegram does not sign webhook payloads; the secret_token configured on setWebhook
    // is echoed back on every delivery as this header, the same role Basic auth plays for
    // Postmark's inbound webhook.
    if (request.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret) return json(401, { error: "unauthorized" });

    let update: TelegramUpdate;
    try {
      const body = await request.text();
      if (Buffer.byteLength(body) > MAX_UPDATE_BYTES) return json(413, { error: "payload_too_large" });
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid payload");
      update = parsed as TelegramUpdate;
    } catch {
      return json(400, { error: "invalid_payload", message: "The Telegram update payload is invalid." });
    }

    const message = update.message;
    // Updates for edited messages, channel posts, callback queries, etc. carry no
    // actionable file and are not errors; acknowledge and move on.
    if (!message?.chat?.id) return json(200, { status: "ignored" });

    const file = extractFile(message);
    if (!file) {
      await backend.reject(message.chat.id, "Please send the invoice as a photo, or attach it as a PDF/JPG/PNG file.");
      return json(200, { status: "ignored" });
    }
    if (!SUPPORTED_TYPES.has(file.mediaType)) {
      await backend.reject(message.chat.id, "That file type isn't supported yet. Please send a PDF, JPG, or PNG.");
      return json(200, { status: "ignored" });
    }

    try {
      const result = await backend.receive({
        chatId: message.chat.id,
        messageId: message.message_id,
        fromUsername: message.from?.username ?? null,
        fileId: file.fileId,
        fileName: file.fileName,
        mediaType: file.mediaType,
      });
      return json(200, { status: result.duplicate ? "duplicate" : "accepted", ingestionEventId: result.ingestionEventId });
    } catch (reason) {
      // A non-2xx response makes Telegram retry the delivery with backoff, which is the
      // right behavior for a transient failure (Supabase blip, Telegram API hiccup); the
      // registration RPC is idempotent on chatId+messageId so a retry is safe.
      console.error("Telegram inbound request failed", reason);
      return json(502, { error: "processing_unavailable" });
    }
  };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class SupabaseTelegramBackend implements TelegramInboundBackend {
  constructor(private readonly client: SupabaseClient, private readonly botToken: string, private readonly tenantId: string) {}

  async receive(input: TelegramFileMessage): Promise<{ ingestionEventId: string; duplicate: boolean }> {
    const transportIdentity = `chat:${input.chatId}:message:${input.messageId}`;
    const { data: existing, error: lookupError } = await this.client
      .from("ingestion_events")
      .select("id")
      .eq("tenant_id", this.tenantId)
      .eq("channel", "TELEGRAM")
      .eq("transport_identity", transportIdentity)
      .maybeSingle();
    if (lookupError) throw new Error(`Unable to check for a duplicate delivery: ${lookupError.message}`);
    if (existing) {
      await this.notify(input.chatId, "Already received this invoice — it's in your processing queue.");
      return { ingestionEventId: existing.id as string, duplicate: true };
    }

    const filePath = await this.resolveFilePath(input.fileId);
    const bytes = await this.downloadFile(filePath);
    if (bytes.byteLength <= 0 || bytes.byteLength > MAX_FILE_BYTES) throw new Error("file size out of range");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storagePath = `${this.tenantId}/${randomUUID()}/${sanitizeFileName(input.fileName)}`;
    const { error: uploadError } = await this.client.storage.from("evidence").upload(storagePath, bytes, { contentType: input.mediaType, upsert: false });
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`);

    const { data, error } = await this.client.rpc("register_telegram_upload", {
      target_tenant: this.tenantId,
      target_storage_path: storagePath,
      target_media_type: input.mediaType,
      target_byte_size: bytes.byteLength,
      target_sha256: sha256,
      target_transport_identity: transportIdentity,
      target_metadata: { chatId: input.chatId, fromUsername: input.fromUsername },
    });
    if (error) {
      await this.client.storage.from("evidence").remove([storagePath]);
      throw new Error(`Registration failed: ${error.message}`);
    }
    const receipt = (data as Array<{ evidence_artifact_id: string; ingestion_event_id: string }>)[0];
    if (!receipt) throw new Error("registration returned no result");
    await this.notify(input.chatId, "Got it — processing your invoice now. I'll follow up if anything's missing.");
    return { ingestionEventId: receipt.ingestion_event_id, duplicate: false };
  }

  async reject(chatId: number, reason: string): Promise<void> {
    await this.notify(chatId, reason);
  }

  private async resolveFilePath(fileId: string): Promise<string> {
    const response = await fetch(`https://api.telegram.org/bot${this.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!response.ok) throw new Error(`Telegram getFile failed (${response.status})`);
    const body = await response.json() as { ok: boolean; result?: { file_path?: string } };
    if (!body.ok || !body.result?.file_path) throw new Error("Telegram getFile returned no file path");
    return body.result.file_path;
  }

  private async downloadFile(filePath: string): Promise<Buffer> {
    const response = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`);
    if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async notify(chatId: number, text: string): Promise<void> {
    // Best-effort: a failed confirmation reply must not fail the whole request, since the
    // evidence is already safely registered by the time this is called.
    await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch((reason: unknown) => console.warn("Telegram sendMessage failed", reason));
  }
}

export interface TelegramInboundConfig {
  port: number;
  botToken: string;
  webhookSecret: string;
  tenantId: string;
  supabaseUrl: string;
  serviceRoleKey: string;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadTelegramInboundConfig(environment: NodeJS.ProcessEnv): TelegramInboundConfig {
  const port = Number(environment.PORT ?? "8789");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid port number");
  return {
    port,
    botToken: required(environment, "TELEGRAM_BOT_TOKEN"),
    webhookSecret: required(environment, "TELEGRAM_WEBHOOK_SECRET"),
    tenantId: required(environment, "TELEGRAM_TEST_TENANT_ID"),
    supabaseUrl: required(environment, "SUPABASE_URL"),
    serviceRoleKey: required(environment, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}

async function main() {
  if (existsSync(".env.worker.local")) loadEnvFile(".env.worker.local");
  const config = loadTelegramInboundConfig(process.env);
  const client = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } });
  const handler = createTelegramInboundHandler(new SupabaseTelegramBackend(client, config.botToken, config.tenantId), config.webhookSecret);
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
  server.listen(config.port, "0.0.0.0", () => console.log(`Telegram inbound listening on port ${config.port}`));
}

if (process.env.RUN_TELEGRAM_INBOUND === "true") void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
