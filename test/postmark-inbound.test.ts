import { describe, expect, it, vi } from "vitest";
import { createPostmarkInboundHandler, type PostmarkInboundBackend } from "../src/services/postmark-inbound.js";

const auth = { username: "postmark", password: "secret" };
const authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
const payload = { MessageID: "message-1", OriginalRecipient: "Inbox@Example.com", From: "sender@example.com", To: "inbox@example.com", Subject: "Invoice", Date: "2026-09-27T10:00:00Z", RawEmail: "From: sender@example.com\r\n\r\nInvoice attached" };

function request(body: unknown = payload, header = authorization): Request {
  return new Request("https://inbound.example/webhooks/postmark/inbound", { method: "POST", headers: { authorization: header, "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("Postmark inbound adapter", () => {
  it("requires HTTP Basic authentication", async () => {
    const backend: PostmarkInboundBackend = { receive: vi.fn() };
    const response = await createPostmarkInboundHandler(backend, auth)(request(payload, "Basic invalid"));
    expect(response.status).toBe(401);
    expect(backend.receive).not.toHaveBeenCalled();
  });

  it("rejects malformed and incomplete payloads", async () => {
    const backend: PostmarkInboundBackend = { receive: vi.fn() };
    const handler = createPostmarkInboundHandler(backend, auth);
    expect((await handler(new Request("https://inbound.example/webhooks/postmark/inbound", { method: "POST", headers: { authorization }, body: "{" }))).status).toBe(400);
    expect((await handler(request({ MessageID: "message-1" }))).status).toBe(400);
    expect(backend.receive).not.toHaveBeenCalled();
  });

  it("normalizes and accepts an inbound receipt", async () => {
    const backend: PostmarkInboundBackend = { receive: vi.fn().mockResolvedValue({ ingestionEventId: "event-1", duplicate: false }) };
    const response = await createPostmarkInboundHandler(backend, auth)(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted", ingestionEventId: "event-1" });
    expect(backend.receive).toHaveBeenCalledWith(expect.objectContaining({ messageId: "message-1", originalRecipient: "inbox@example.com", rawEmail: expect.stringContaining("Invoice attached") }));
  });

  it("acknowledges idempotent provider retries without another logical receipt", async () => {
    const backend: PostmarkInboundBackend = { receive: vi.fn().mockResolvedValue({ ingestionEventId: "event-1", duplicate: true }) };
    const response = await createPostmarkInboundHandler(backend, auth)(request());
    expect(await response.json()).toEqual({ status: "duplicate", ingestionEventId: "event-1" });
  });
});
