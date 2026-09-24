import { describe, expect, it } from "vitest";
import {
  composeEffectiveInvoiceSchema,
  type InvoiceSchemaLayer,
} from "../src/domain/effective-invoice-schema.js";

const defaultSchema: InvoiceSchemaLayer = {
  id: "default",
  version: 1,
  scope: "BROKERAGE_DEFAULT",
  fields: {
    invoiceDate: { required: true, minimumConfidence: 0.9 },
    officeCode: { required: false },
  },
};

describe("Effective Invoice Schema", () => {
  it("inherits lower layers and overrides only declared properties", () => {
    const schema = composeEffectiveInvoiceSchema([
      {
        id: "sale",
        version: 3,
        scope: "TRANSACTION_TYPE",
        fields: { invoiceDate: { minimumConfidence: 0.98 } },
      },
      defaultSchema,
      {
        id: "office",
        version: 2,
        scope: "OFFICE",
        fields: { officeCode: { required: true } },
      },
    ]);

    expect(schema.fields).toEqual({
      invoiceDate: { required: true, minimumConfidence: 0.98 },
      officeCode: { required: true },
    });
    expect(schema.components.map(({ scope }) => scope)).toEqual([
      "BROKERAGE_DEFAULT",
      "OFFICE",
      "TRANSACTION_TYPE",
    ]);
  });

  it("produces the same fingerprint regardless of input order", () => {
    const party: InvoiceSchemaLayer = {
      id: "party",
      version: 4,
      scope: "INVOICE_PARTY",
      fields: { taxId: { required: true } },
    };
    expect(
      composeEffectiveInvoiceSchema([defaultSchema, party]).fingerprint,
    ).toBe(composeEffectiveInvoiceSchema([party, defaultSchema]).fingerprint);
  });

  it("rejects ambiguous layers at the same scope", () => {
    expect(() =>
      composeEffectiveInvoiceSchema([
        defaultSchema,
        { ...defaultSchema, id: "another-default" },
      ]),
    ).toThrowError(/exactly one brokerage default|Multiple/);
  });
});
