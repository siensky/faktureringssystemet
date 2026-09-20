"""RabbitMQ-konsument för invoice.sent, invoice.credited och
invoice.reminder_sent (fas 14 — påminnelser fick sin egen leveransväg;
tidigare band den här konsumenten bara de två första).

architecture.md #7 FALL B — sidoeffekten är extern (S3 + senare SMTP), så:
  1. gör jobbet FÖRST: hämta snapshot, rendera PDF, ladda upp till S3
  2. markera EFTERÅT, i en transaktion: skriv documents-raden, köa mejlet,
     skriv delivery_updated-eventet, och sist processed_events

Den naturliga idempotensnyckeln UNIQUE (tenant_id, invoice_id,
document_type) i `documents` ÄR garantin. processed_events är bara en
optimering som slipper göra om S3-arbetet — en tidig SELECT på den, och en
sista INSERT ON CONFLICT DO NOTHING.

Felhantering:
  - ogiltig envelope/payload   -> ack (permanent skräp)
  - snapshot 404 eller 403     -> ack + error-logg. Billing skrev aldrig
                                  snapshoten, eller tokenet saknar rätt
                                  scope/tenanten är avstängd — inget av det
                                  löser sig av att vänta (401 hanteras
                                  redan i BillingClient som transient: ett
                                  utgånget cachat token förnyas och
                                  försöket görs om DÄR, det bubblar aldrig
                                  hit som 401).
  - övrigt (S3/DB/billing nere) -> ETT nytt försök, räknat i ett
                                  x-attempts-headerfält på meddelandet
                                  (inte RabbitMQs `redelivered`-flagga —
                                  den sätts även vid en vanlig omstart/
                                  rullande deploy, oavsett om NÅGOT
                                  bearbetningsförsök gjorts, och skulle
                                  då ge upp på första riktiga försöket).
                                  Försöket görs om genom att ack:a
                                  originalet och publicera en kopia med
                                  x-attempts+1 till samma kö — headern
                                  överlever på så vis en omstart av
                                  documents, till skillnad från
                                  redelivered. Efter MAX_ATTEMPTS ges
                                  meddelandet upp: NACK (requeue=False),
                                  inte ack, så det landar i events.dlq
                                  (infra/rabbitmq/init.sh) i stället för
                                  att bara försvinna tyst — samma mönster
                                  som billings TS-konsumenter redan
                                  använde. GET /internal/ops/alerts i
                                  billing (fas 7) visar ködjupet.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

import aio_pika
import asyncpg

from . import repository
from .billing_client import BillingClient, SnapshotAccessDenied, SnapshotNotFound
from .config import Settings
from .contracts import (
    EnvelopeValidationError,
    PayloadValidationError,
    assert_valid_envelope,
    assert_valid_payload,
)
from .rendering import document_type_of, render_pdf
from .s3 import S3Store, storage_key

QUEUE = "documents.events"
ROUTING_KEYS = ("invoice.sent", "invoice.credited", "invoice.reminder_sent")
REQUEUE_DELAY_SECONDS = 1.0
PREFETCH = 5
ATTEMPTS_HEADER = "x-attempts"
MAX_ATTEMPTS = 3
# Ett republish väntar på brokerns confirm (channel(publisher_confirms=True)
# i main.py) — precis som OutboxPublisher. Utan en tidsgräns kan EN hängd
# publicering (och det delade låset runt den) stanna alla PREFETCH
# samtidiga _on_message-tasks på en gång, så kön slutar leverera helt.
REPUBLISH_TIMEOUT_SECONDS = 5.0
# Måste vara IDENTISKA med infra/rabbitmq/init.sh:s förhandsdeklaration —
# RabbitMQ ger PRECONDITION_FAILED om en redeklaration har andra
# argument. Se init.sh för varför de sätts nu, innan de behövs.
QUEUE_ARGUMENTS = {"x-dead-letter-exchange": "events.dlx"}


def _subject(snapshot: dict[str, Any], document_type: str) -> str:
    number = snapshot["invoice"].get("invoiceNumber")
    company = snapshot["company"].get("name") or "Faktura"
    if document_type == "credit_note":
        return f"Kreditfaktura {number} från {company}"
    if document_type == "reminder":
        return f"Påminnelse {number} från {company}"
    return f"Faktura {number} från {company}"


class EventConsumer:
    def __init__(
        self,
        *,
        connection: aio_pika.abc.AbstractConnection,
        pool: asyncpg.Pool,
        settings: Settings,
        billing: BillingClient,
        s3: S3Store,
        logger: Any,
    ) -> None:
        self._connection = connection
        self._pool = pool
        self._settings = settings
        self._billing = billing
        self._s3 = s3
        self._logger = logger
        self._channel: aio_pika.abc.AbstractChannel | None = None
        # EGEN kanal för _republish_with_attempt, skild från
        # konsumtionskanalen. prefetch(5) gör att flera _on_message-anrop
        # kan köra SAMTIDIGT (en task per obekräftat meddelande), och de
        # kan då försöka publicera en ombud-kopia samtidigt — att dela en
        # kanal mellan aktiv konsumtion och sådan samtidig publicering
        # visade sig i praktiken kunna tappa konsumentregistreringen helt
        # (RabbitMQ rapporterade 0 consumers på kön utan någon synlig
        # traceback). Samma mönster som ping-kanalen redan är skild från
        # den här kanalen, och som OutboxPublisher har sin egen kanal.
        self._republish_channel: aio_pika.abc.AbstractChannel | None = None
        # Flera _on_message-tasks kan fortfarande vilja publicera på
        # _republish_channel SAMTIDIGT (prefetch > 1) — ett lås serialiserar
        # dem som ett andra säkerhetslager utöver den egna kanalen.
        self._republish_lock = asyncio.Lock()

    async def start(self) -> None:
        # Egen kanal, skild från ping-kanalen, så prefetch här inte stryper
        # system-pingen.
        self._channel = await self._connection.channel()
        await self._channel.set_qos(prefetch_count=PREFETCH)
        self._republish_channel = await self._connection.channel()
        # 'events' deklareras av infra/rabbitmq/init.sh; documents-kontot har
        # inte 'configure' på det, så vi binder bara mot namnet.
        queue = await self._channel.declare_queue(QUEUE, durable=True, arguments=QUEUE_ARGUMENTS)
        for key in ROUTING_KEYS:
            await queue.bind("events", routing_key=key)
        await queue.consume(self._on_message)

    async def stop(self) -> None:
        if self._republish_channel is not None:
            await self._republish_channel.close()
        if self._channel is not None:
            await self._channel.close()

    async def _on_message(self, message: aio_pika.abc.AbstractIncomingMessage) -> None:
        attempts = int((message.headers or {}).get(ATTEMPTS_HEADER, 0))
        try:
            envelope = json.loads(message.body.decode("utf-8"))
            assert_valid_envelope(envelope)
            assert_valid_payload(envelope["eventType"], envelope["payload"])
            await self._handle(envelope)
            await message.ack()
        except (EnvelopeValidationError, PayloadValidationError) as error:
            self._logger.error("consumer: ogiltigt event, kastas utan requeue", error=str(error))
            await message.ack()
        except (SnapshotNotFound, SnapshotAccessDenied) as error:
            self._logger.error(
                "consumer: snapshot ej tillgänglig, kastas utan requeue", error=str(error)
            )
            await message.ack()
        except Exception as error:  # noqa: BLE001
            await self._retry_or_give_up(message, attempts, error)

    async def _retry_or_give_up(
        self, message: aio_pika.abc.AbstractIncomingMessage, attempts: int, error: Exception
    ) -> None:
        next_attempts = attempts + 1
        if next_attempts >= MAX_ATTEMPTS:
            self._logger.error(
                "consumer: transient fel, gav upp efter maxantal försök (nackas till events.dlq)",
                attempts=next_attempts,
                error_type=type(error).__name__,
                error=str(error),
            )
            # nack (INTE ack) med requeue=False: det är DET som faktiskt
            # dead-letter:ar meddelandet till events.dlx/events.dlq (kön
            # deklarerades med x-dead-letter-exchange redan i
            # infra/rabbitmq/init.sh). Ett ack hade bara kastat bort det
            # tyst utan att en operatör någonsin kunnat se det (fas 7,
            # kodgranskning PR #7) — exakt samma mönster som billings två
            # TS-konsumenter (deliveries/consumer.ts, payments/consumer.ts)
            # redan gör.
            await message.nack(requeue=False)
            return
        self._logger.warning(
            "consumer: transient fel, försöker igen",
            attempts=next_attempts,
            error_type=type(error).__name__,
            error=str(error),
        )
        await asyncio.sleep(REQUEUE_DELAY_SECONDS)
        try:
            await self._republish_with_attempt(message, next_attempts)
        except Exception as republish_error:  # noqa: BLE001
            # Ett republish som hänger (t.ex. brokern svarar inte med en
            # confirm) fick tidigare HELA konsumenten att stå still: med
            # PREFETCH samtidiga _on_message-tasks och ett delat lås runt
            # publiceringen väntade alla på varandra i evighet, och kön
            # slutade leverera helt (prefetch ständigt fullt av oackade
            # meddelanden). ack:a ORIGINALET ändå hellre än att riskera
            # samma stopp igen — det kostar ett förlorat omförsök, inte
            # hela konsumenten.
            self._logger.error(
                "consumer: kunde inte publicera om, ger upp det här försöket",
                error_type=type(republish_error).__name__,
                error=str(republish_error),
            )
        await message.ack()

    async def _republish_with_attempt(
        self, message: aio_pika.abc.AbstractIncomingMessage, attempts: int
    ) -> None:
        """Publicerar en KOPIA av meddelandet till vår egen kö (default-
        exchange, routing key = könamnet) med x-attempts satt. Bygger inte
        på RabbitMQs redelivered-flagga — se moduldocen — så
        försöksräkningen överlever en omstart av documents. Tidsbegränsad
        — se anropsstället för varför."""
        assert self._republish_channel is not None
        headers = dict(message.headers or {})
        headers[ATTEMPTS_HEADER] = attempts
        copy = aio_pika.Message(
            body=message.body,
            headers=headers,
            content_type=message.content_type,
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        )
        async with self._republish_lock:
            await asyncio.wait_for(
                self._republish_channel.default_exchange.publish(copy, routing_key=QUEUE),
                timeout=REPUBLISH_TIMEOUT_SECONDS,
            )

    async def _handle(self, envelope: dict[str, Any]) -> None:
        event_id = envelope["eventId"]
        tenant_id = envelope["tenantId"]
        correlation_id = envelope["correlationId"]
        invoice_id = int(envelope["payload"]["invoiceId"])

        # Optimering (inte garantin): hoppa över om redan hanterat.
        async with self._pool.acquire() as conn:
            if await repository.already_processed(conn, event_id):
                return

        # 1. Jobbet först (fall B).
        snapshot = await self._billing.fetch_snapshot(
            invoice_id=invoice_id, tenant_id=tenant_id, correlation_id=correlation_id
        )
        document_type = document_type_of(snapshot)
        pdf_bytes = await asyncio.to_thread(render_pdf, snapshot)
        sha256 = hashlib.sha256(pdf_bytes).hexdigest()
        key = storage_key(tenant_id, invoice_id, document_type)
        await self._s3.put_pdf(key, pdf_bytes)  # självskrivande nyckel

        recipient = snapshot["customer"].get("email")
        subject = _subject(snapshot, document_type)
        # billing skriver emailValid FÄRSKT i snapshoten vid send/credit
        # (mappers.ts buildSnapshotPayload). domain.md #23: en hård studs
        # ska stoppa FRAMTIDA utskick, inte bara det bounce:ade mejlet —
        # annars svartlistas avsändardomänen. Standard True om fältet
        # ändå saknas (en äldre snapshot från innan detta fanns).
        email_valid = snapshot["customer"].get("emailValid", True)

        # 2. Markera efteråt, allt i EN transaktion.
        async with self._pool.acquire() as conn, conn.transaction():
            document_id = await repository.insert_document(
                conn,
                tenant_id=tenant_id,
                invoice_id=invoice_id,
                document_type=document_type,
                storage_key=key,
                byte_size=len(pdf_bytes),
                sha256=sha256,
            )
            if document_id is not None:
                # Ny PDF — rapportera vidare. Fanns raden redan gjordes
                # det redan vid förra körningen.
                if email_valid:
                    await repository.enqueue_email(
                        conn,
                        tenant_id=tenant_id,
                        invoice_id=invoice_id,
                        email_type=document_type,
                        document_id=document_id,
                        recipient_email=recipient,
                        subject=subject,
                        correlation_id=correlation_id,
                    )
                    delivery_status = "queued"
                else:
                    # Känt ogiltig adress — PDF:en finns (portalen/admin
                    # kan fortfarande nå den), men INGET mejl köas.
                    delivery_status = "failed"
                    self._logger.warning(
                        "consumer: hoppar över utskick — kundens e-post är känt ogiltig",
                        invoice_id=invoice_id,
                        document_type=document_type,
                    )
                await repository.write_event(
                    conn,
                    event_type="invoice.delivery_updated",
                    tenant_id=tenant_id,
                    correlation_id=correlation_id,
                    payload={
                        "invoiceId": invoice_id,
                        "documentType": document_type,
                        "deliveryStatus": delivery_status,
                    },
                )
            await repository.mark_processed(conn, event_id)

        self._logger.info(
            "consumer: dokument genererat",
            event_id=event_id,
            invoice_id=invoice_id,
            document_type=document_type,
            regenerated=document_id is None,
            email_valid=email_valid,
        )
