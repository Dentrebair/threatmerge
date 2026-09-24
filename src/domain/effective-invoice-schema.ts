import { createHash } from "node:crypto";
import { DomainRuleViolation } from "./domain-rule-violation.js";

export type SchemaScope =
  | "BROKERAGE_DEFAULT"
  | "INVOICE_PARTY"
  | "OFFICE"
  | "TRANSACTION_TYPE";

export interface FieldRule {
  readonly required?: boolean;
  readonly minimumConfidence?: number;
  readonly allowDerived?: boolean;
  readonly format?: string;
}

export interface InvoiceSchemaLayer {
  readonly id: string;
  readonly version: number;
  readonly scope: SchemaScope;
  readonly fields: Readonly<Record<string, FieldRule>>;
}

export interface EffectiveInvoiceSchema {
  readonly fields: Readonly<Record<string, FieldRule>>;
  readonly components: readonly Readonly<{
    id: string;
    version: number;
    scope: SchemaScope;
  }>[];
  readonly fingerprint: string;
}

const scopeOrder: Record<SchemaScope, number> = {
  BROKERAGE_DEFAULT: 0,
  INVOICE_PARTY: 1,
  OFFICE: 2,
  TRANSACTION_TYPE: 3,
};

export function composeEffectiveInvoiceSchema(
  layers: readonly InvoiceSchemaLayer[],
): EffectiveInvoiceSchema {
  const ordered = [...layers].sort(
    (left, right) => scopeOrder[left.scope] - scopeOrder[right.scope],
  );

  assertExactlyOneDefault(ordered);
  assertNoDuplicateScope(ordered);

  const fields: Record<string, FieldRule> = {};
  for (const layer of ordered) {
    for (const [field, override] of Object.entries(layer.fields)) {
      fields[field] = { ...fields[field], ...override };
    }
  }

  const components = ordered.map(({ id, version, scope }) => ({
    id,
    version,
    scope,
  }));
  const fingerprint = createHash("sha256")
    .update(stableJson({ components, fields }))
    .digest("hex");

  return { fields, components, fingerprint };
}

function assertExactlyOneDefault(layers: readonly InvoiceSchemaLayer[]): void {
  const defaults = layers.filter(
    ({ scope }) => scope === "BROKERAGE_DEFAULT",
  );
  if (defaults.length !== 1) {
    throw new DomainRuleViolation(
      "DEFAULT_SCHEMA_REQUIRED",
      "Effective Invoice Schema requires exactly one brokerage default",
    );
  }
}

function assertNoDuplicateScope(layers: readonly InvoiceSchemaLayer[]): void {
  const scopes = new Set<SchemaScope>();
  for (const layer of layers) {
    if (scopes.has(layer.scope)) {
      throw new DomainRuleViolation(
        "AMBIGUOUS_SCHEMA_LAYER",
        `Multiple ${layer.scope} schema layers apply`,
      );
    }
    scopes.add(layer.scope);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
