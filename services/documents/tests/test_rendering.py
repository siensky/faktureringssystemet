"""build_template_context är ren logik — ingen WeasyPrint, ingen DB. Den
faktiska PDF-genereringen (native pango/cairo) täcks av e2e-sviten i
Docker."""

from documents.rendering import build_template_context, document_type_of

# Hårt mellanslag (U+00A0) — tusentalsavgränsare och avgränsare före %,
# svensk typografi. Byggs in explicit i förväntningarna så testet inte blir
# beroende av osynliga tecken i en sträng-literal.
NB = "\u00a0"

_SNAPSHOT = {
    "invoice": {
        "id": 7,
        "invoiceNumber": 1,
        "ocrNumber": "1236",
        "invoiceType": "invoice",
        "dateIssued": "2026-09-10",
        "dateDue": "2026-10-10",
        "currency": "SEK",
        "totalExclVatOre": 250_000,
        "totalVatOre": 62_500,
        "totalInclVatOre": 312_500,
    },
    "company": {
        "name": "Testbolaget AB",
        "orgNumber": "5560000000",
        "bankgiro": "1234567",
        "vatNumber": "SE556000000001",
        "address": {"street": "Storgatan 1", "zip": "11122", "city": "Stockholm"},
        "logoUrl": None,
    },
    "customer": {
        "id": 3,
        "name": "Kund AB",
        "email": "kund@example.test",
        "customerType": "company",
        "orgNumber": "5569999999",
        "address": {"street": "Kundvägen 2", "zip": "22233", "city": "Göteborg"},
    },
    "lines": [
        {
            "position": 1,
            "description": "Konsulttimmar",
            "quantity": 2.5,
            "unit": "h",
            "unitPriceOre": 100_000,
            "vatRate": 25,
            "lineExclVatOre": 250_000,
            "lineVatOre": 62_500,
            "lineInclVatOre": 312_500,
        }
    ],
}


def test_ore_omvandlas_till_kronor_med_svensk_formatering():
    ctx = build_template_context(_SNAPSHOT)
    assert ctx["total_excl_vat"] == f"2{NB}500,00"
    assert ctx["total_incl_vat"] == f"3{NB}125,00"
    assert ctx["lines"][0]["unit_price"] == f"1{NB}000,00"


def test_momssammanstallning_grupperas_per_sats():
    ctx = build_template_context(_SNAPSHOT)
    assert ctx["vat_summary"] == [{"rate": f"25{NB}%", "base": f"2{NB}500,00", "vat": "625,00"}]


def test_vanlig_faktura_har_ratt_titel():
    ctx = build_template_context(_SNAPSHOT)
    assert ctx["is_credit_note"] is False
    assert ctx["title"] == "Faktura"


def test_kreditfaktura_far_negativa_belopp_och_kredittitel():
    snap = {
        **_SNAPSHOT,
        "invoice": {
            **_SNAPSHOT["invoice"],
            "invoiceType": "credit_note",
            "totalExclVatOre": -250_000,
            "totalVatOre": -62_500,
            "totalInclVatOre": -312_500,
        },
        "lines": [
            {
                **_SNAPSHOT["lines"][0],
                "quantity": -2.5,
                "lineExclVatOre": -250_000,
                "lineVatOre": -62_500,
                "lineInclVatOre": -312_500,
            }
        ],
    }
    ctx = build_template_context(snap)
    assert ctx["is_credit_note"] is True
    assert ctx["title"] == "Kreditfaktura"
    assert ctx["total_incl_vat"] == f"-3{NB}125,00"
    assert ctx["lines"][0]["line_excl_vat"] == f"-2{NB}500,00"
    assert ctx["lines"][0]["quantity"] == "-2,5"
    assert document_type_of(snap) == "credit_note"


def test_saknad_adress_ger_tom_lista_inte_krasch():
    snap = {**_SNAPSHOT, "customer": {**_SNAPSHOT["customer"], "address": None}}
    ctx = build_template_context(snap)
    assert ctx["customer"]["address_lines"] == []


def test_document_type_of_vanlig_faktura():
    assert document_type_of(_SNAPSHOT) == "invoice"


def test_paminnelse_far_ratt_titel_och_referens_till_originalet():
    snap = {
        **_SNAPSHOT,
        "invoice": {
            **_SNAPSHOT["invoice"],
            "invoiceType": "reminder",
            "remindsInvoiceNumber": 1,
        },
    }
    ctx = build_template_context(snap)
    assert ctx["is_credit_note"] is False
    assert ctx["is_reminder"] is True
    assert ctx["title"] == "Påminnelse"
    assert ctx["reminder_for"] == 1
    assert document_type_of(snap) == "reminder"


def test_paminnelse_utan_remindsinvoicenumber_ger_ingen_krasch():
    snap = {**_SNAPSHOT, "invoice": {**_SNAPSHOT["invoice"], "invoiceType": "reminder"}}
    ctx = build_template_context(snap)
    assert ctx["reminder_for"] is None
