"""documents-tjänsten (fas 4). Bootstrap och wiring — ingen affärslogik
bor här (code-style.md #2), bara att koppla ihop delarna:

  RabbitMQ-konsument (invoice.sent / invoice.credited, fall B)
      -> hämtar snapshot från billing, renderar PDF ur den, lägger i S3,
         köar mejlet och skriver ett delivery_updated-event i outboxen.
  E-postarbetare
      -> plockar köade mejl, skickar med PDF bifogad, rapporterar sent/failed.
  Webhook  POST /webhooks/email-status
      -> leverantörens statusrapporter, monotont in i email_outbox +
         delivery_updated-event.
  OutboxPublisher
      -> enda stället som publicerar documents event till RabbitMQ.
  GET /internal/documents/:invoiceId/url
      -> signerad, tidsbegränsad PDF-URL för portalen (fas 9).
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import redis.asyncio as redis_asyncio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .billing_client import BillingClient
from .config import MissingEnvError, load_settings
from .consumer import EventConsumer
from .db import close_db, connect_db
from .documents_api import create_documents_router
from .email_worker import EmailWorker
from .logging import configure_logging, get_logger
from .middleware import BodySizeLimitMiddleware, SecurityHeadersMiddleware
from .outbox import OutboxPublisher
from .rabbitmq import RabbitConnection, connect_rabbitmq, events_exchange, start_system_ping
from .s3 import S3Store
from .service_auth import create_require_service
from .webhooks import create_webhook_router

MAX_BODY_BYTES = 256 * 1024  # 256 KB, samma standard som TS-tjänsterna

try:
    settings = load_settings()
except MissingEnvError as error:
    raise SystemExit(str(error)) from error

configure_logging(settings.service_name, settings.log_level)
logger = get_logger()

_state: dict[str, Any] = {}


def _pool():
    return _state["db"]


def _s3_store() -> S3Store:
    return _state["s3"]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    pool = await connect_db(settings.database_url)
    redis_client = redis_asyncio.from_url(settings.redis_url)
    rabbit: RabbitConnection = await connect_rabbitmq(settings.rabbitmq_url)

    ping_state = await start_system_ping(
        rabbit.channel,
        settings.service_name,
        on_ping=lambda msg: logger.info("mottog system.ping", **{"from": msg["service"]}),
    )

    # Bucketen skapas av S3-tjänsten själv vid uppstart lokalt/CI (adobe/
    # s3mock, se docker-compose.yml) eller i förväg i produktion, med en
    # EGEN, bucket-begränsad nyckel — documents saknar (avsiktligt)
    # rättighet att skapa bucketar. Se s3.py:s moduldoc, PR-granskning
    # fas 4, punkt 13.
    s3_store = S3Store(settings)

    publisher_channel = await rabbit.connection.channel()
    exchange = await events_exchange(publisher_channel)

    billing = BillingClient(settings, redis_client)

    outbox_publisher = OutboxPublisher(
        pool,
        exchange,
        logger,
        on_dead_letter=lambda event_id, event_type, error: logger.error(
            "LARM: documents-event dead-letter:at",
            event_id=event_id,
            event_type=event_type,
            error=str(error),
        ),
    )
    outbox_publisher.start()

    consumer = EventConsumer(
        connection=rabbit.connection,
        pool=pool,
        settings=settings,
        billing=billing,
        s3=s3_store,
        logger=logger,
    )
    await consumer.start()

    email_worker = EmailWorker(pool=pool, settings=settings, s3=s3_store, logger=logger)
    email_worker.start()

    _state.update(
        db=pool,
        redis=redis_client,
        rabbit=rabbit,
        ping_state=ping_state,
        publisher_channel=publisher_channel,
        outbox_publisher=outbox_publisher,
        consumer=consumer,
        email_worker=email_worker,
        s3=s3_store,
    )

    logger.info("documents lyssnar", port=settings.port)
    yield

    await email_worker.stop()
    await consumer.stop()
    await outbox_publisher.stop()
    ping_state.stop()
    await publisher_channel.close()
    await rabbit.close()
    await redis_client.aclose()
    await close_db(pool)


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(BodySizeLimitMiddleware, max_bytes=MAX_BODY_BYTES)

_require_service = create_require_service(settings.jwt_service_secret)
app.include_router(create_webhook_router(settings, _pool, logger))
app.include_router(create_documents_router(_pool, _s3_store, settings, _require_service))


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.error("unhandled error", error=str(exc), exc_info=exc)
    return JSONResponse(
        status_code=500,
        content={"success": False, "code": 500, "message": "Internal server Error"},
    )


@app.get("/health/live")
async def health_live() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/ready")
async def health_ready() -> JSONResponse:
    failed: list[str] = []

    rabbit: RabbitConnection | None = _state.get("rabbit")
    if rabbit is None or not rabbit.is_open:
        failed.append("rabbitmq")

    redis_client = _state.get("redis")
    try:
        if redis_client is None:
            raise RuntimeError("redis not initialised")
        await redis_client.ping()
    except Exception as error:  # noqa: BLE001 — health-check ska aldrig krascha
        logger.warning("redis readiness check misslyckades", error=str(error))
        failed.append("redis")

    pool = _state.get("db")
    try:
        if pool is None:
            raise RuntimeError("db pool not initialised")
        async with pool.acquire() as conn:
            await conn.execute("SELECT 1")
    except Exception as error:  # noqa: BLE001
        logger.warning("postgres readiness check misslyckades", error=str(error))
        failed.append("postgres")

    if failed:
        return JSONResponse(status_code=503, content={"status": "unhealthy", "failed": failed})
    return JSONResponse(status_code=200, content={"status": "ok"})


@app.get("/internal/debug/pings-seen")
async def pings_seen() -> dict[str, list[str]]:
    # Kvar tills fas 0-rökprovet i CI (som pollar den här på alla fyra
    # tjänsterna) ersätts. Tas bort tillsammans med motsvarande i de tre
    # TS-tjänsterna, inte styckvis.
    ping_state = _state.get("ping_state")
    return {"seen": sorted(ping_state.seen) if ping_state else []}
