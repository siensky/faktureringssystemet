/* eslint-disable */
/**
 * Denna fil är GENERERAD av packages/contracts/scripts/codegen.ts.
 * Ändra inte här — ändra motsvarande .schema.json och kör `bun run codegen`.
 */

/**
 * Payload för invoice.delivery_updated. Publiceras av documents när en utskicksstatus ändras, och konsumeras av billing som äger invoices.delivery_status. Documents skriver ALDRIG i billings tabeller själv (architecture.md #20) — rapporten går som event till ägande tjänst. deliveryStatus är monoton hos mottagaren: ett försenat delivered får aldrig skriva över ett bounced (domain.md #29).
 */
export interface InvoiceDeliveryUpdatedPayload {
  /**
   * Fakturan (eller kreditfakturan) leveransen gäller.
   */
  invoiceId: number;
  /**
   * Vilket dokument som skickades. Samma värdemängd som documents.document_type.
   */
  documentType: "invoice" | "credit_note" | "reminder";
  /**
   * Ny leveransstatus. 'none' finns bara som DB-default i billing och rapporteras aldrig.
   */
  deliveryStatus: "queued" | "sent" | "delivered" | "bounced" | "failed";
  /**
   * Bara vid bounced. En HÅRD studs stänger av framtida utskick genom att billing sätter customers.email_valid = false (domain.md #23); en mjuk studs gör det inte.
   */
  bounceType?: "hard" | "soft";
}
