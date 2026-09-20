"""E-postarbetare: plockar köade rader ur email_outbox, skickar mejlet med
PDF:en bifogad, och gör den VILLKORADE övergången 'queued' -> 'sent'
(planens idempotensavsnitt #6). Rapporterar 'sent' respektive 'failed'
till billing via ett delivery_updated-event i outboxen.

PDF:en bifogas som fil — ingen bärartoken (signerad URL) läggs i ett mejl
som lever för evigt (domain.md #19). Portalen (fas 9) använder i stället
GET /internal/documents/:invoiceId/url.

"Leasing": claim-steget skjuter fram next_attempt_at EXPONENTIELLT och
räknar upp attempts i en egen transaktion, så en samtidig arbetare (FOR
UPDATE SKIP LOCKED) hoppar över raden. Raden står kvar 'queued' medan SMTP
körs (utanför transaktionen — extern sidoeffekt).

Kraschar PROCESSEN mellan SMTP-svaret och statusskrivningen skickas
mejlet om vid nästa försök; det är medvetet at-least-once (samma avvägning
som resten av systemet). Ett enstaka DB-fel EFTER lyckad SMTP (utan att
processen kraschar) är en annan sak — det skulle annars mejla kunden igen
redan vid nästa lease-cykel utan att någon krasch alls skett. _on_send_
success görs därför om ett par gånger innan den ger upp, och _process_one
fångar den om den ändå felar — se kommentarerna där.
"""

from __future__ import annotations

import asyncio
from email.message import EmailMessage
from email.utils import make_msgid
from typing import Any

import aiosmtplib
import asyncpg

from . import repository
from .config import Settings
from .s3 import S3Store

POLL_INTERVAL_SECONDS = 2.0
BATCH_SIZE = 10
MAX_ATTEMPTS = 6
BACKOFF_BASE_SECONDS = 30
BACKOFF_CAP_SECONDS = 3600
_SEND_SUCCESS_MAX_ATTEMPTS = 3
_SEND_SUCCESS_RETRY_DELAY_SECONDS = 0.5


def _body_text(email_type: str) -> str:
    # Bara påminnelsen (fas 14) grenar — faktura och kreditfaktura delade
    # redan samma text innan detta, och det ändras inte här.
    if email_type == "reminder":
        return (
            "Hej,\n\nDin faktura har förfallit till betalning. Bifogat finner du en "
            "påminnelse där en påminnelseavgift tillkommit.\n\n"
            "Betala till bankgirot och ange OCR-referensen som står på påminnelsen "
            "— den skiljer sig från den ursprungliga fakturans referens.\n"
        )
    return (
        "Hej,\n\nBifogat finner du din faktura som PDF.\n\n"
        "Betala till bankgirot och ange OCR-referensen som står på fakturan.\n"
    )


def _build_message(
    *,
    sender: str,
    recipient: str,
    subject: str,
    message_id: str,
    pdf: bytes,
    filename: str,
    email_type: str,
) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = recipient
    msg["Subject"] = subject
    msg["Message-ID"] = message_id
    msg.set_content(_body_text(email_type))
    msg.add_attachment(pdf, maintype="application", subtype="pdf", filename=filename)
    return msg


class EmailWorker:
    def __init__(self, *, pool: asyncpg.Pool, settings: Settings, s3: S3Store, logger: Any) -> None:
        self._pool = pool
        self._settings = settings
        self._s3 = s3
        self._logger = logger
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        while not self._stopped.is_set():
            try:
                await self._tick()
            except Exception as error:  # noqa: BLE001 — loopen får aldrig dö
                self._logger.error("email-worker: varv misslyckades", error=str(error))
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=POLL_INTERVAL_SECONDS)
            except TimeoutError:
                pass

    async def _tick(self) -> None:
        async with self._pool.acquire() as conn, conn.transaction():
            leased = await repository.lease_queued_emails(
                conn,
                limit=BATCH_SIZE,
                base_backoff_seconds=BACKOFF_BASE_SECONDS,
                cap_backoff_seconds=BACKOFF_CAP_SECONDS,
            )
        for row in leased:
            await self._process_one(row)

    async def _process_one(self, row: dict[str, Any]) -> None:
        # RFC-formen (med vinkelparenteser) i Message-ID-headern; den
        # NORMALISERADE formen (utan) i provider_message_id, eftersom
        # leverantörernas webhooks rapporterar id:t utan parenteser.
        message_id = make_msgid(domain="documents.faktura.internal")
        stored_message_id = message_id.strip("<>")
        try:
            storage_key = await self._storage_key_for(row["document_id"])
            pdf = await self._s3.get_pdf(storage_key)
            message = _build_message(
                sender=self._settings.email_from,
                recipient=row["recipient_email"],
                subject=row["subject"],
                message_id=message_id,
                pdf=pdf,
                filename=f"{row['email_type']}-{row['invoice_id']}.pdf",
                email_type=row["email_type"],
            )
            await aiosmtplib.send(
                message,
                hostname=self._settings.smtp_host,
                port=self._settings.smtp_port,
                start_tls=self._settings.smtp_start_tls,
                username=self._settings.smtp_username,
                password=self._settings.smtp_password,
            )
        except Exception as error:  # noqa: BLE001
            await self._on_send_failure(row, str(error))
            return

        try:
            await self._on_send_success(row, stored_message_id)
        except Exception as error:  # noqa: BLE001
            # SMTP LYCKADES men bokföringen av det gjorde det inte, trots
            # _on_send_success:s egna interna omförsök. Om vi lät felet
            # bubbla upp härifrån skulle _tick/_run bara logga och gå
            # vidare med raden fortfarande 'queued' — och nästa lease-cykel
            # skulle skicka SAMMA mejl igen utan att processen ens kraschat.
            # Ett högljutt larm är bättre än ett tyst dubbelutskick.
            self._logger.critical(
                "email-worker: mejlet SKICKADES men kunde inte bokföras — "
                "risk för dubbelutskick vid nästa lease-cykel",
                email_id=row["id"],
                invoice_id=row["invoice_id"],
                error=str(error),
            )

    async def _storage_key_for(self, document_id: int) -> str:
        async with self._pool.acquire() as conn:
            doc = await conn.fetchrow(
                "SELECT storage_key FROM documents WHERE id = $1", document_id
            )
        if doc is None:
            raise RuntimeError(f"documents-rad {document_id} saknas")
        return doc["storage_key"]

    async def _on_send_success(self, row: dict[str, Any], message_id: str) -> None:
        # Ett par snabba interna omförsök på själva BOKFÖRINGEN (inte ett
        # nytt SMTP-utskick) — de allra flesta "DB-blippar" är
        # sub-sekundsstörningar. Räcker inte det bubblar felet upp till
        # _process_one, som loggar högljutt i stället för att tyst mejla
        # kunden igen vid nästa lease-cykel.
        last_error: Exception | None = None
        for attempt in range(_SEND_SUCCESS_MAX_ATTEMPTS):
            try:
                async with self._pool.acquire() as conn, conn.transaction():
                    changed = await repository.mark_email_sent(
                        conn, email_id=row["id"], provider_message_id=message_id
                    )
                    if changed == 1:
                        await repository.write_event(
                            conn,
                            event_type="invoice.delivery_updated",
                            tenant_id=row["tenant_id"],
                            correlation_id=str(row["correlation_id"]),
                            payload={
                                "invoiceId": row["invoice_id"],
                                "documentType": row["email_type"],
                                "deliveryStatus": "sent",
                            },
                        )
                self._logger.info(
                    "email-worker: mejl skickat", email_id=row["id"], invoice_id=row["invoice_id"]
                )
                return
            except Exception as error:  # noqa: BLE001
                last_error = error
                if attempt < _SEND_SUCCESS_MAX_ATTEMPTS - 1:
                    await asyncio.sleep(_SEND_SUCCESS_RETRY_DELAY_SECONDS)
        assert last_error is not None
        raise last_error

    async def _on_send_failure(self, row: dict[str, Any], error: str) -> None:
        attempts = row["attempts"]
        async with self._pool.acquire() as conn, conn.transaction():
            if attempts >= MAX_ATTEMPTS:
                changed = await repository.mark_email_failed(conn, email_id=row["id"], error=error)
                if changed == 1:
                    await repository.write_event(
                        conn,
                        event_type="invoice.delivery_updated",
                        tenant_id=row["tenant_id"],
                        correlation_id=str(row["correlation_id"]),
                        payload={
                            "invoiceId": row["invoice_id"],
                            "documentType": row["email_type"],
                            "deliveryStatus": "failed",
                        },
                    )
                self._logger.error(
                    "email-worker: mejl gav upp efter maxantal försök",
                    email_id=row["id"],
                    error=error,
                )
            else:
                await repository.record_email_error(conn, email_id=row["id"], error=error)
                self._logger.warning(
                    "email-worker: mejl misslyckades, försöker igen senare",
                    email_id=row["id"],
                    attempts=attempts,
                    error=error,
                )
