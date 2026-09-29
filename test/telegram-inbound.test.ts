import { describe, expect, it, vi } from "vitest";
import { createTelegramInboundHandler, type TelegramInboundBackend } from "../src/services/telegram-inbound.js";

const secret = "webhook-secret";

function request(body: unknown, headerSecret = secret): Request {
  return new Request("http://localhost/webhooks/telegram/inbound", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": headerSecret },
    body: JSON.stringify(body),
  });
}

function backend(overrides: Partial<TelegramInboundBackend> = {}): TelegramInboundBackend {
  return {
    receive: vi.fn().mockResolvedValue({ ingestionEventId: "event-1", duplicate: false }),
    reject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("telegram inbound handler", () => {
  it("exposes an unauthenticated health check", async () => {
    const handler = createTelegramInboundHandler(backend(), secret);
    expect((await handler(new Request("http://localhost/health"))).status).toBe(200);
  });

  it("rejects a request missing or presenting the wrong secret token", async () => {
    const handler = createTelegramInboundHandler(backend(), secret);
    expect((await handler(request({ update_id: 1 }, "wrong-secret"))).status).toBe(401);
  });

  it("rejects an invalid payload", async () => {
    const handler = createTelegramInboundHandler(backend(), secret);
    const malformed = new Request("http://localhost/webhooks/telegram/inbound", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: "not json",
    });
    expect((await handler(malformed)).status).toBe(400);
  });

  it("acknowledges non-message updates without calling the backend", async () => {
    const store = backend();
    const handler = createTelegramInboundHandler(store, secret);
    const response = await handler(request({ update_id: 1, edited_message: { message_id: 1 } }));
    expect(response.status).toBe(200);
    expect(store.receive).not.toHaveBeenCalled();
    expect(store.reject).not.toHaveBeenCalled();
  });

  it("rejects a text-only message with a friendly reply instead of erroring", async () => {
    const store = backend();
    const handler = createTelegramInboundHandler(store, secret);
    const response = await handler(request({ update_id: 1, message: { message_id: 5, chat: { id: 42 }, text: "hi" } }));
    expect(response.status).toBe(200);
    expect(store.reject).toHaveBeenCalledWith(42, expect.stringContaining("photo"));
    expect(store.receive).not.toHaveBeenCalled();
  });

  it("rejects an unsupported document type", async () => {
    const store = backend();
    const handler = createTelegramInboundHandler(store, secret);
    const response = await handler(request({
      update_id: 1,
      message: { message_id: 5, chat: { id: 42 }, document: { file_id: "file-1", file_name: "notes.txt", mime_type: "text/plain" } },
    }));
    expect(response.status).toBe(200);
    expect(store.reject).toHaveBeenCalledWith(42, expect.stringContaining("PDF, JPG, or PNG"));
    expect(store.receive).not.toHaveBeenCalled();
  });

  it("accepts a document attachment and forwards it to the backend", async () => {
    const store = backend();
    const handler = createTelegramInboundHandler(store, secret);
    const response = await handler(request({
      update_id: 1,
      message: { message_id: 5, chat: { id: 42 }, from: { username: "alice" }, document: { file_id: "file-1", file_name: "invoice.pdf", mime_type: "application/pdf" } },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted", ingestionEventId: "event-1" });
    expect(store.receive).toHaveBeenCalledWith({ chatId: 42, messageId: 5, fromUsername: "alice", fileId: "file-1", fileName: "invoice.pdf", mediaType: "application/pdf" });
  });

  it("picks the largest photo size and reports duplicates", async () => {
    const store = backend({ receive: vi.fn().mockResolvedValue({ ingestionEventId: "event-2", duplicate: true }) });
    const handler = createTelegramInboundHandler(store, secret);
    const response = await handler(request({
      update_id: 1,
      message: { message_id: 6, chat: { id: 42 }, photo: [
        { file_id: "small", file_size: 1000 },
        { file_id: "large", file_size: 50000 },
      ] },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "duplicate", ingestionEventId: "event-2" });
    expect(store.receive).toHaveBeenCalledWith(expect.objectContaining({ fileId: "large", mediaType: "image/jpeg" }));
  });

  it("returns a retryable error without leaking backend details when registration fails", async () => {
    const store = backend({ receive: vi.fn().mockRejectedValue(new Error("private storage detail")) });
    const handler = createTelegramInboundHandler(store, secret);
    const response = await handler(request({
      update_id: 1,
      message: { message_id: 5, chat: { id: 42 }, document: { file_id: "file-1", file_name: "invoice.pdf", mime_type: "application/pdf" } },
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "processing_unavailable" });
  });
});
