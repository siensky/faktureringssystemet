"""S3-nyckeln härleds ur (tenant_id, invoice_id, document_type) — samma tre
värden som UNIQUE-nyckeln i `documents`, så samma event två gånger skriver
samma objekt (planens idempotensavsnitt #5)."""

from documents.s3 import storage_key


def test_nyckel_for_faktura():
    assert storage_key(1, 42, "invoice") == "1/invoices/42/invoice.pdf"


def test_nyckel_for_kreditfaktura():
    assert storage_key(7, 100, "credit_note") == "7/invoices/100/credit_note.pdf"


def test_nyckel_for_paminnelse():
    assert storage_key(7, 101, "reminder") == "7/invoices/101/reminder.pdf"


def test_nyckeln_ar_deterministisk():
    assert storage_key(3, 9, "invoice") == storage_key(3, 9, "invoice")
