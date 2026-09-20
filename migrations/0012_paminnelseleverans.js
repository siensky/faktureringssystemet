/**
 * Fas 14 — påminnelser får en egen leveransväg.
 *
 * Bakgrund: 0004_billing (invoices.invoice_type) tillät redan värdet
 * 'reminder', men documents kände bara till 'invoice'/'credit_note' — en
 * påminnelse skapades i billing men fick aldrig en PDF eller ett mejl.
 * Medvetet lämnat utanför fas 7 (se den borttagna kommentaren i
 * services/billing/src/invoices/services.ts, createReminderInTx): att
 * återanvända document_type 'invoice' för en påminnelse hade gett kunden
 * ett mejl och en PDF som säger "Faktura" i stället för "Påminnelse".
 *
 * Samma två CHECK-villkor som 0005_documents satte, bara utökade:
 *   - documents.document_type      (rad ~59 i 0005_documents.js)
 *   - email_outbox.email_type      (rad ~87 i 0005_documents.js)
 * Båda var inline och onamngivna när de skapades, så Postgres gav dem
 * standardnamnen documents_document_type_check respektive
 * email_outbox_email_type_check — samma DROP/ADD-mönster som
 * users_customer_shape i 0011_bankid_customer_portal.js.
 *
 * Ingen ny GRANT behövs (database.md, 0008_service_roles.js): grants är
 * tabellnivå, inte värdenivå, och documents har redan full DML på båda
 * tabellerna.
 *
 * Ingen backfill av redan skapade påminnelser (beslutat med Sienna) — bara
 * nya påminnelser framåt får PDF/mejl via den här vägen.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE documents DROP CONSTRAINT documents_document_type_check;
    ALTER TABLE documents ADD CONSTRAINT documents_document_type_check
      CHECK (document_type IN ('invoice', 'credit_note', 'reminder'));

    ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_email_type_check;
    ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_email_type_check
      CHECK (email_type IN ('invoice', 'credit_note', 'reminder'));
  `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_email_type_check;
    ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_email_type_check
      CHECK (email_type IN ('invoice', 'credit_note'));

    ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_document_type_check;
    ALTER TABLE documents ADD CONSTRAINT documents_document_type_check
      CHECK (document_type IN ('invoice', 'credit_note'));
  `);
};
