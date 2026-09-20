import { describe, expect, test } from "bun:test";
import type { CompanySettingsRow } from "../src/company-settings/types";
import type { CustomerRow } from "../src/customers/types";
import { buildSnapshotPayload } from "../src/invoices/mappers";
import type { InvoiceItemRow, InvoiceRow } from "../src/invoices/types";

const invoice: InvoiceRow = {
  id: 42,
  tenant_id: 1,
  customer_id: 7,
  invoice_number: 1005,
  ocr_number: "10054",
  invoice_type: "reminder",
  status: "sent",
  delivery_status: "none",
  date_issued: "2026-09-20",
  date_due: "2026-10-04",
  currency: "SEK",
  total_excl_vat_ore: "10000",
  total_vat_ore: "0",
  total_incl_vat_ore: "10000",
  credits_invoice_id: null,
  reminds_invoice_id: 41,
  superseded_by_invoice_id: null,
  parent_template_id: null,
  sent_at: new Date("2026-09-20T10:00:00Z"),
  created_at: new Date("2026-09-20T10:00:00Z"),
  updated_at: new Date("2026-09-20T10:00:00Z"),
};

const items: InvoiceItemRow[] = [];

const company: CompanySettingsRow = {
  tenant_id: 1,
  company_name: "Testbolaget AB",
  org_number: "5566778899",
  bankgiro: "1234566",
  vat_number: "SE556677889901",
  address_street: null,
  address_zip: null,
  address_city: null,
  logo_url: null,
  next_invoice_number: 1006,
  reminder_fee_ore: "6000",
  payment_terms_days: 30,
  tenant_status: "active",
  created_at: new Date(),
  updated_at: new Date(),
};

const customer: CustomerRow = {
  id: 7,
  tenant_id: 1,
  customer_type: "private",
  name: "Kalle Kund",
  email: "kalle@example.test",
  email_valid: true,
  org_number: null,
  pnr_encrypted: null,
  pnr_hmac: null,
  address_street: null,
  address_zip: null,
  address_city: null,
  payment_terms_days: null,
  created_at: new Date(),
  updated_at: new Date(),
};

describe("buildSnapshotPayload", () => {
  test("utan remindsInvoice saknar snapshoten remindsInvoiceNumber helt (faktura/kreditfaktura)", () => {
    const snapshot = buildSnapshotPayload({ invoice, items, company, customer });
    const snapshotInvoice = snapshot.invoice as Record<string, unknown>;
    expect("remindsInvoiceNumber" in snapshotInvoice).toBe(false);
  });

  test("med remindsInvoice bär snapshoten originalets fakturanummer (fas 14 — referensrad på påminnelse-PDF:en)", () => {
    const original: InvoiceRow = {
      ...invoice,
      id: 41,
      invoice_type: "invoice",
      invoice_number: 1002,
    };
    const snapshot = buildSnapshotPayload({
      invoice,
      items,
      company,
      customer,
      remindsInvoice: original,
    });
    const snapshotInvoice = snapshot.invoice as Record<string, unknown>;
    expect(snapshotInvoice.remindsInvoiceNumber).toBe(1002);
    // Påminnelsens EGET nummer ligger kvar oförändrat i invoiceNumber.
    expect(snapshotInvoice.invoiceNumber).toBe(1005);
  });
});
