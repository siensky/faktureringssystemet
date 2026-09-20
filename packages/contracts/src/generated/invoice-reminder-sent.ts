/* eslint-disable */
/**
 * Denna fil är GENERERAD av packages/contracts/scripts/codegen.ts.
 * Ändra inte här — ändra motsvarande .schema.json och kör `bun run codegen`.
 */

/**
 * Payload för invoice.reminder_sent. Publiceras av billing i samma transaktion som det nattliga automationsjobbet skapar påminnelsen (createReminderInTx) och sätter originalet till superseded. invoiceId är PÅMINNELSEN — det är den som har en snapshot och som skickas till kunden som PDF (samma mönster som invoice.credited, domain.md #35).
 */
export interface InvoiceReminderSentPayload {
  /**
   * Påminnelsens id.
   */
  invoiceId: number;
  /**
   * Originalfakturan som påminnelsen avser.
   */
  remindsInvoiceId: number;
}
