import { createHash } from "node:crypto";

export interface ReceiptIdentity {
  readonly tenantId: string;
  readonly channel: "MANUAL_UPLOAD" | "POSTMARK" | "MICROSOFT_365";
  readonly requestId: string;
}

export function ingestionIdempotencyKey(identity: ReceiptIdentity): string {
  return createHash("sha256")
    .update(`${identity.tenantId}\u0000${identity.channel}\u0000${identity.requestId}`)
    .digest("hex");
}

export function contentChecksum(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
