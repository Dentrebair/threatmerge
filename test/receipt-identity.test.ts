import { describe, expect, it } from "vitest";
import {
  contentChecksum,
  ingestionIdempotencyKey,
} from "../src/domain/receipt-identity.js";

describe("receipt identity", () => {
  it("deduplicates a transport retry", () => {
    const receipt = {
      tenantId: "tenant-a",
      channel: "MANUAL_UPLOAD" as const,
      requestId: "request-1",
    };
    expect(ingestionIdempotencyKey(receipt)).toBe(
      ingestionIdempotencyKey(receipt),
    );
  });

  it("keeps deliberate repeated receipts distinct from content equality", () => {
    const content = new TextEncoder().encode("same invoice bytes");
    expect(contentChecksum(content)).toBe(contentChecksum(content));
    expect(
      ingestionIdempotencyKey({
        tenantId: "tenant-a",
        channel: "MANUAL_UPLOAD",
        requestId: "request-1",
      }),
    ).not.toBe(
      ingestionIdempotencyKey({
        tenantId: "tenant-a",
        channel: "MANUAL_UPLOAD",
        requestId: "request-2",
      }),
    );
  });

  it("scopes receipt identity by tenant and channel", () => {
    const base = { requestId: "same-provider-id" };
    expect(
      ingestionIdempotencyKey({
        ...base,
        tenantId: "tenant-a",
        channel: "POSTMARK",
      }),
    ).not.toBe(
      ingestionIdempotencyKey({
        ...base,
        tenantId: "tenant-b",
        channel: "POSTMARK",
      }),
    );
  });
});
