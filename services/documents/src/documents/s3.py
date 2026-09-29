"""S3-lagring via boto3 (adobe/s3mock lokalt/CI, en riktig S3-bucket i
produktion — samma klientkod mot båda). boto3-klienter är trådsäkra och
byggs EN gång i S3Store.__init__ — att konstruera en ny klient per anrop
(som en tidigare version av den här modulen gjorde) laddar botocores
servicemodeller från disk varje gång, tiotals till hundratals ms blockerad
tid per anrop (PR-granskning fas 4, punkt 17). Alla nätverksanrop läggs
ändå på en trådpool med asyncio.to_thread för att inte blockera
event-loopen — boto3 är synkront.

S3-nyckeln härleds ur (tenant_id, invoice_id, document_type) — samma tre
värden som UNIQUE-nyckeln i `documents` — så samma event två gånger skriver
samma objekt till samma nyckel (planens idempotensavsnitt #5). Ingen
`document-1.pdf` / `document-2.pdf`.

Bucketen skapas INTE härifrån. I produktion: en gång, i förväg, med en
EGEN nyckel som bara har GetObject/PutObject/ListBucket på just den
bucketen (PR-granskning fas 4, punkt 13) — den nyckeln saknar rättighet
att skapa bucketar, och ska sakna den. Lokalt/CI: adobe/s3mock skapar
bucketen själv vid uppstart (docker-compose.yml,
COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS) — mocken har inget
IAM-system, så den begränsningen har ingen effekt där.
"""

from __future__ import annotations

import asyncio

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

from .config import Settings

_NOT_FOUND_CODES = frozenset({"404", "NoSuchBucket", "NoSuchKey"})


def storage_key(tenant_id: int, invoice_id: int, document_type: str) -> str:
    return f"{tenant_id}/invoices/{invoice_id}/{document_type}.pdf"


def _build_client(settings: Settings, *, public: bool):
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_public_endpoint if public else settings.s3_endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        # Varken s3mock eller MinIO (innan bytet, se docker-compose.yml)
        # svarar på virtual-host-style (bucket.host) — tvinga path-style,
        # annars pekar signerade URL:er på ett värdnamn som inte finns.
        config=BotoConfig(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


class S3Store:
    """Byggs EN gång vid uppstart (main.py) och delas av konsumenten,
    e-postarbetaren och documents_api. Två klienter: en mot det INTERNA
    endpointet (put/get) och en mot det PUBLIKA (signerade URL:er som en
    webbläsare ska kunna följa, fas 9-portalen) — se Settings.s3_endpoint
    kontra s3_public_endpoint."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = _build_client(settings, public=False)
        self._public_client = _build_client(settings, public=True)

    async def put_pdf(self, key: str, data: bytes) -> None:
        def _run() -> None:
            self._client.put_object(
                Bucket=self._settings.s3_bucket,
                Key=key,
                Body=data,
                ContentType="application/pdf",
            )

        await asyncio.to_thread(_run)

    async def get_pdf(self, key: str) -> bytes:
        def _run() -> bytes:
            obj = self._client.get_object(Bucket=self._settings.s3_bucket, Key=key)
            return obj["Body"].read()

        return await asyncio.to_thread(_run)

    async def object_exists(self, key: str) -> bool:
        """False om objektet inte finns. Ett ÅTKOMSTFEL (fel/utgången
        nyckel, fel policy, nätverksfel) är INTE samma sak som "finns
        inte" och ska synas som ett fel, inte tystas till False
        (PR-granskning fas 4, punkt 18)."""

        def _run() -> bool:
            try:
                self._client.head_object(Bucket=self._settings.s3_bucket, Key=key)
                return True
            except ClientError as err:
                code = err.response.get("Error", {}).get("Code", "")
                if code in _NOT_FOUND_CODES:
                    return False
                raise

        return await asyncio.to_thread(_run)

    async def presigned_get_url(self, key: str, ttl_seconds: int) -> str:
        """Tidsbegränsad GET-URL mot det PUBLIKA endpointet. Bärartoken —
        loggas aldrig (domain.md #19)."""

        def _run() -> str:
            return self._public_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._settings.s3_bucket, "Key": key},
                ExpiresIn=ttl_seconds,
            )

        return await asyncio.to_thread(_run)
