"""Låst url_fetcher för WeasyPrint.

`company.logo_url` (invoice.html) är ovaliderad fritext en tenant-admin
sätter via `PUT /admin/company-settings` i billing (1–500 tecken, ett
https-mönster men ingen adressvalidering). WeasyPrints DEFAULT url_fetcher
hämtar vad den än får serverside och följer omdirigeringar internt —
`http://169.254.169.254/latest/meta-data/` (molnmetadata),
`http://billing:4002/internal/...` eller `http://s3:9090/...` renderas
rakt in i PDF:en, som sedan mejlas till kunden och läggs i S3. En komplett
läs-SSRF med exfiltreringsväg (PR-granskning fas 4, punkt 1).

SafeURLFetcher byggs OVANPÅ weasyprint.urls.URLFetcher (inte en egen
hämtare från scratch) av två skäl:
  1. WeasyPrint 70 förväntar sig att url_fetcher är ett OBJEKT med bl.a.
     `_fail_on_errors` och returnerar en URLFetcherResponse-instans, inte
     en bar funktion eller en dict — den kontraktsformen får vi gratis av
     att ärva rätt bas.
  2. URLFetcher är byggd på urllib:s OpenerDirector, med en riktig
     handler-kedja: `allowed_protocols` filtrerar schema (file://, ftp://,
     data: ...) INNAN något öppnas, och ett eget handler-tillägg
     (_SsrfGuardHandler) körs för VARJE request — inklusive varje ny
     Request som HTTPRedirectHandler bygger vid en omdirigering. Att
     validera "bara första URL:en" och sedan låta urllib följa
     omdirigeringar fritt skulle läcka precis den kontrollen.

`fail_on_errors=False` (WeasyPrints egen default) gör att en blockerad
eller trasig bild bara loggas och hoppas över — resten av PDF:en renderas
ändå. En admin med en trasig logo_url ska inte kunna slå ut hela
fakturaflödet.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.request import BaseHandler, Request

FETCH_TIMEOUT_SECONDS = 5


class UnsafeImageUrlError(ValueError):
    """URL:en pekar på något vi inte får hämta serverside."""


def _resolve_ips(hostname: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError as err:
        raise UnsafeImageUrlError(f"kunde inte slå upp {hostname!r}") from err
    ips = {ipaddress.ip_address(info[4][0]) for info in infos}
    if not ips:
        raise UnsafeImageUrlError(f"{hostname!r} gav ingen adress")
    return list(ips)


def _is_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    # is_global täcker ensamt privata/loopback/link-local/reserverade/
    # multicast-block, INKLUSIVE molnens metadata-adress 169.254.169.254
    # (link-local) och CGNAT-blocket 100.64.0.0/10 (varken privat enligt
    # IPv4Address.is_private eller globalt) — verifierat i enhetstesten.
    return ip.is_global


def assert_public_host(hostname: str) -> None:
    """Kastar UnsafeImageUrlError om värdnamnet slår upp till en
    icke-publik adress (privat, loopback, link-local — inklusive
    molnens metadata-adress 169.254.169.254)."""
    ips = _resolve_ips(hostname)
    if not all(_is_public(ip) for ip in ips):
        raise UnsafeImageUrlError(f"{hostname!r} slår upp till en icke-publik adress")


class _SsrfGuardHandler(BaseHandler):
    """urllib-handler som körs för VARJE request OpenerDirector processar
    — inklusive varje ny Request som HTTPRedirectHandler bygger vid en
    omdirigering (den kör self.parent.open(new_request, ...) igen, vilket
    kör process_request/https_request-kedjan på nytt). Det är det som gör
    att omdirigeringar inte kan användas för att smita förbi kontrollen."""

    def https_request(self, request: Request) -> Request:
        hostname = (request.host or "").split(":")[0]
        if not hostname:
            raise UnsafeImageUrlError("URL saknar värdnamn")
        assert_public_host(hostname)
        return request


def build_safe_fetcher():
    """En URLFetcher låst till https mot publika adresser. Byggs per
    rendering (inte modulnivå-singleton) eftersom URLFetcher är en
    urllib.request.OpenerDirector med interna, muterbara handlers."""
    from weasyprint.urls import URLFetcher

    fetcher = URLFetcher(
        timeout=FETCH_TIMEOUT_SECONDS,
        allowed_protocols=["https"],
        allow_redirects=True,
        fail_on_errors=False,
    )
    fetcher.add_handler(_SsrfGuardHandler())
    return fetcher
