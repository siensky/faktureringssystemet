"""Kontraktstest: validerar samma fixture-filer som TS-sidans
envelope.contract.test.ts, mot samma schemafiler (packages/contracts/
schemas/). Går båda gröna betyder det att TS och Python ser eventen på
exakt samma sätt."""

import json
from pathlib import Path

import pytest

from documents.contracts import (
    EnvelopeValidationError,
    PayloadValidationError,
    assert_valid_envelope,
    assert_valid_payload,
    is_valid_envelope,
    is_valid_payload,
)

_FIXTURES_DIR = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "fixtures"


def _load_fixture(name: str) -> dict:
    with (_FIXTURES_DIR / name).open("r", encoding="utf-8") as f:
        return json.load(f)


def test_giltig_envelope_passerar_valideringen():
    valid = _load_fixture("valid-envelope.json")
    assert is_valid_envelope(valid) is True
    assert_valid_envelope(valid)  # kastar inte


def test_saknad_tenant_id_avvisas():
    invalid = _load_fixture("invalid-envelope-missing-tenant.json")
    assert is_valid_envelope(invalid) is False
    with pytest.raises(EnvelopeValidationError, match="tenantId"):
        assert_valid_envelope(invalid)


def test_ogiltigt_event_type_avvisas():
    invalid = _load_fixture("invalid-envelope-bad-event-type.json")
    assert is_valid_envelope(invalid) is False


def test_extra_falt_avvisas():
    valid = _load_fixture("valid-envelope.json")
    with_extra = {**valid, "unexpectedField": "should not be here"}
    assert is_valid_envelope(with_extra) is False


@pytest.mark.parametrize(
    ("fixture", "event_type"),
    [
        ("events/invoice-sent.json", "invoice.sent"),
        ("events/invoice-credited.json", "invoice.credited"),
        ("events/invoice-reminder-sent.json", "invoice.reminder_sent"),
        ("events/invoice-delivery-updated.json", "invoice.delivery_updated"),
    ],
)
def test_payload_per_eventtyp_passerar(fixture: str, event_type: str):
    envelope = _load_fixture(fixture)
    assert envelope["eventType"] == event_type
    assert is_valid_envelope(envelope) is True
    assert is_valid_payload(event_type, envelope["payload"]) is True
    assert_valid_payload(event_type, envelope["payload"])  # kastar inte


def test_delivery_updated_okant_status_avvisas():
    envelope = _load_fixture("events/invalid-invoice-delivery-updated-bad-status.json")
    assert is_valid_payload("invoice.delivery_updated", envelope["payload"]) is False
    with pytest.raises(PayloadValidationError, match="not one of"):
        assert_valid_payload("invoice.delivery_updated", envelope["payload"])


def test_extra_falt_i_payload_avvisas():
    assert is_valid_payload("invoice.sent", {"invoiceId": 1, "extra": True}) is False


def test_eventtyp_utan_schema_ar_ett_kodfel():
    assert is_valid_payload("invoice.nonexistent", {}) is False
    with pytest.raises(PayloadValidationError, match="inget schema"):
        assert_valid_payload("invoice.nonexistent", {})
