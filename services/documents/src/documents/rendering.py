"""PDF-rendering ur snapshoten. WeasyPrint importeras LAZY inne i
render_pdf — de native-biblioteken (pango/cairo) behövs bara vid själva
renderingen, inte för att importera den här modulen, så enhetstesterna kan
täcka build_template_context utan att installera dem.

Renderas ALLTID ur snapshoten (invoice_snapshots i billing, hämtad via
GET /internal/invoices/:id/snapshot), aldrig ur de levande tabellerna, så
en senare ändring av företagets logga eller bankgiro inte ändrar en redan
bokförd fakturas PDF (database.md #30, planens snapshot-avsnitt).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

_TEMPLATES_DIR = Path(__file__).resolve().parent / "templates"

_env = Environment(
    loader=FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
)


def _ore_to_kr(ore: int) -> str:
    """Öre (heltal) -> "1 234,56". Negativa belopp (kreditfaktura) behåller
    tecknet. Tusentalsavgränsare = tunt mellanslag, decimal = komma."""
    negative = ore < 0
    kronor, rest = divmod(abs(int(ore)), 100)
    # U+00A0 (hårt mellanslag) som tusentalsavgränsare — svensk
    # typografi, och håller "3 125" ihop över radbrytning i PDF:en.
    grouped = f"{kronor:,}".replace(",", "\u00a0")
    formatted = f"{grouped},{rest:02d}"
    return f"-{formatted}" if negative else formatted


def _format_quantity(quantity: float) -> str:
    text = f"{quantity:.3f}".rstrip("0").rstrip(".")
    return text.replace(".", ",")


def _format_rate(rate: float) -> str:
    text = f"{rate:g}".replace(".", ",")
    return f"{text}\u00a0%"  # hårt mellanslag före %


def _address_lines(address: dict[str, Any] | None) -> list[str]:
    if not address:
        return []
    street = address.get("street")
    zip_code = address.get("zip")
    city = address.get("city")
    lines: list[str] = []
    if street:
        lines.append(street)
    if zip_code or city:
        lines.append(" ".join(part for part in [zip_code, city] if part))
    return lines


def build_template_context(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Ren omvandling snapshot -> mall-kontext. Öre -> kronor för visning;
    momssammanställning grupperad per momssats (domain.md #10 — moms räknas
    per rad, summan är summan av de redan avrundade radbeloppen)."""
    invoice = snapshot["invoice"]
    company = snapshot["company"]
    customer = snapshot["customer"]
    raw_lines = snapshot.get("lines", [])

    is_credit_note = invoice.get("invoiceType") == "credit_note"
    is_reminder = invoice.get("invoiceType") == "reminder"

    lines: list[dict[str, Any]] = []
    vat_groups: dict[float, dict[str, int]] = {}
    for line in raw_lines:
        rate = float(line["vatRate"])
        group = vat_groups.setdefault(rate, {"base_ore": 0, "vat_ore": 0})
        group["base_ore"] += int(line["lineExclVatOre"])
        group["vat_ore"] += int(line["lineVatOre"])
        lines.append(
            {
                "position": line["position"],
                "description": line["description"],
                "quantity": _format_quantity(float(line["quantity"])),
                "unit": line["unit"],
                "unit_price": _ore_to_kr(int(line["unitPriceOre"])),
                "vat_rate": _format_rate(rate),
                "line_excl_vat": _ore_to_kr(int(line["lineExclVatOre"])),
                "line_incl_vat": _ore_to_kr(int(line["lineInclVatOre"])),
            }
        )

    vat_summary = [
        {
            "rate": _format_rate(rate),
            "base": _ore_to_kr(group["base_ore"]),
            "vat": _ore_to_kr(group["vat_ore"]),
        }
        for rate, group in sorted(vat_groups.items())
    ]

    if is_credit_note:
        title = "Kreditfaktura"
    elif is_reminder:
        title = "Påminnelse"
    else:
        title = "Faktura"

    return {
        "is_credit_note": is_credit_note,
        "is_reminder": is_reminder,
        "title": title,
        # Bara satt för en påminnelse (mappers.ts buildSnapshotPayload,
        # fas 14) — originalfakturans NUMMER, för referensraden på
        # påminnelse-PDF:en.
        "reminder_for": invoice.get("remindsInvoiceNumber"),
        "invoice_number": invoice.get("invoiceNumber"),
        "ocr": invoice.get("ocrNumber"),
        "date_issued": invoice.get("dateIssued"),
        "date_due": invoice.get("dateDue"),
        "currency": invoice.get("currency", "SEK"),
        "company": {
            "name": company.get("name"),
            "org_number": company.get("orgNumber"),
            "vat_number": company.get("vatNumber"),
            "bankgiro": company.get("bankgiro"),
            "logo_url": company.get("logoUrl"),
            "address_lines": _address_lines(company.get("address")),
        },
        "customer": {
            "name": customer.get("name"),
            "org_number": customer.get("orgNumber"),
            "address_lines": _address_lines(customer.get("address")),
        },
        "lines": lines,
        "vat_summary": vat_summary,
        "total_excl_vat": _ore_to_kr(int(invoice["totalExclVatOre"])),
        "total_vat": _ore_to_kr(int(invoice["totalVatOre"])),
        "total_incl_vat": _ore_to_kr(int(invoice["totalInclVatOre"])),
    }


def document_type_of(snapshot: dict[str, Any]) -> str:
    invoice_type = snapshot["invoice"].get("invoiceType")
    if invoice_type == "credit_note":
        return "credit_note"
    if invoice_type == "reminder":
        return "reminder"
    return "invoice"


def render_pdf(snapshot: dict[str, Any]) -> bytes:
    """Renderar snapshoten till PDF-bytes. Lazy import av WeasyPrint så att
    modulen (och dess enhetstester) inte kräver pango/cairo.

    url_fetcher=build_safe_fetcher() LÅST till https mot publika adresser
    — se safe_fetch.py. company.logo_url i mallen är ovaliderad
    admin-fritext; utan detta är WeasyPrints default url_fetcher en
    komplett läs-SSRF (file://, molnmetadata, interna tjänster) rakt in i
    en PDF som mejlas till kunden och läggs i S3. fail_on_errors=False
    (satt i build_safe_fetcher) gör att en blockerad/trasig bild bara
    hoppas över — resten av fakturan renderas ändå."""
    from weasyprint import HTML

    from .safe_fetch import build_safe_fetcher

    html = _env.get_template("invoice.html").render(**build_template_context(snapshot))
    return HTML(
        string=html, base_url=str(_TEMPLATES_DIR), url_fetcher=build_safe_fetcher()
    ).write_pdf()
