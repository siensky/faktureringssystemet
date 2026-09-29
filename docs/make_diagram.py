#!/usr/bin/env python3
"""Genererar docs/system-design.png — arkitekturkarta over faktureringssystemet.

Rutor = tjanster/frontends, cylindrar = datalager, breda barer = nginx och
RabbitMQ-exchangen, fargkodade pilar visar hur delarna samspelar
(HTTP / S2S / event / lagring).

Kor: python3 docs/make_diagram.py
"""

import math
from PIL import Image, ImageDraw, ImageFont

S = 2  # renderskala — ritar i 2x for skarp text, PNG:en skalas ner i README
W, H = 1600 * S, 1320 * S

REG = "/System/Library/Fonts/Supplemental/Arial.ttf"
BLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(size, bold=False):
    key = (BLD if bold else REG, int(size * S))
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(key[0], key[1])
    return _font_cache[key]


# ---- farger ---------------------------------------------------------------
ACCENT = "#1F4E79"
DARK = "#1A1A1A"
FE_F, FE_B = "#FFE9A8", "#C49A00"
EXT_F, EXT_B = "#E8DAF3", "#6A3D9A"
NG_F, NG_B = "#E8EAED", "#5F6368"
SV_F, SV_B = "#DCEAF7", "#2E5E8C"
EX_F, EX_B = "#FFD9A8", "#C26A00"
DB_F, DB_B = "#D9EAD3", "#38761D"
E_HTTP = "#1A1A1A"
E_S2S = "#8A8A8A"
E_EVT = "#E08A00"
E_DB = "#2E7D32"

img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)


def text(x, y, s, size=9, bold=False, color=DARK, center=True):
    f = font(size, bold)
    anchor = "mm" if center else "lm"
    d.text((x * S, (H / S - y) * S), s, font=f, fill=color, anchor=anchor)


def box(cx, cy, w, h, lines, fill, border, title_sz=13, sub_sz=8.5, r=10):
    x0, y0 = (cx - w / 2) * S, (H / S - cy - h / 2) * S
    x1, y1 = (cx + w / 2) * S, (H / S - cy + h / 2) * S
    d.rounded_rectangle([x0, y0, x1, y1], radius=r * S, fill=fill, outline=border, width=int(1.8 * S))
    if not lines:
        return
    n = len(lines)
    total = title_sz + 5 + (n - 1) * (sub_sz + 4) if n > 1 else title_sz
    ty = cy + total / 2 - title_sz / 2
    text(cx, ty, lines[0], size=title_sz, bold=True)
    for i, ln in enumerate(lines[1:], 1):
        text(cx, ty - i * (sub_sz + 4) - 2, ln, size=sub_sz)


def bar(cx, cy, w, h, title, sub, fill, border, title_sz=15, sub_sz=9):
    box(cx, cy, w, h, [], fill, border)
    text(cx, cy + 9, title, size=title_sz, bold=True)
    text(cx, cy - 11, sub, size=sub_sz)


def cylinder(cx, cy, w, h, lines):
    x0, x1 = (cx - w / 2) * S, (cx + w / 2) * S
    top, bot = (H / S - cy - h / 2) * S, (H / S - cy + h / 2) * S
    e = h * 0.18 * S
    d.rectangle([x0, top + e / 2, x1, bot - e / 2], fill=DB_F)
    d.line([x0, top + e / 2, x0, bot - e / 2], fill=DB_B, width=int(1.8 * S))
    d.line([x1, top + e / 2, x1, bot - e / 2], fill=DB_B, width=int(1.8 * S))
    d.ellipse([x0, bot - e, x1, bot], fill=DB_F, outline=DB_B, width=int(1.8 * S))
    d.ellipse([x0, top, x1, top + e], fill=DB_F, outline=DB_B, width=int(1.8 * S))
    text(cx, cy + 6, lines[0], size=11.5, bold=True)
    for i, ln in enumerate(lines[1:], 1):
        text(cx, cy + 6 - i * 13, ln, size=8)


def _head(x1, y1, x2, y2, color, size=9, lw=1.8):
    ang = math.atan2(y2 - y1, x2 - x1)
    for s in (1, -1):
        hx = x2 - size * math.cos(ang - s * 0.42)
        hy = y2 - size * math.sin(ang - s * 0.42)
        d.line([x2 * S, (H / S - y2) * S, hx * S, (H / S - hy) * S], fill=color, width=int(lw * S))


def arrow(x1, y1, x2, y2, color, dashed=False, double=False, lw=1.8, size=9):
    if dashed:
        seg, gap = 6, 5
        dist = math.hypot(x2 - x1, y2 - y1)
        steps = max(1, int(dist / (seg + gap)))
        for i in range(steps):
            t0, t1 = i * (seg + gap) / dist, min(1.0, (i * (seg + gap) + seg) / dist)
            ax, ay = x1 + (x2 - x1) * t0, y1 + (y2 - y1) * t0
            bx, by = x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1
            d.line([ax * S, (H / S - ay) * S, bx * S, (H / S - by) * S], fill=color, width=int(lw * S))
    else:
        d.line([x1 * S, (H / S - y1) * S, x2 * S, (H / S - y2) * S], fill=color, width=int(lw * S))
    _head(x1, y1, x2, y2, color, size, lw)
    if double:
        _head(x2, y2, x1, y1, color, size, lw)


def elbow(pts, color, dashed=False, double=False, lw=1.8):
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        if dashed:
            arrow_dash_only(a, b, color, lw)
        else:
            d.line([a[0] * S, (H / S - a[1]) * S, b[0] * S, (H / S - b[1]) * S], fill=color, width=int(lw * S))
    _head(*pts[-2], *pts[-1], color, 9, lw)
    if double:
        _head(*pts[1], *pts[0], color, 9, lw)


def arrow_dash_only(a, b, color, lw):
    seg, gap = 6, 5
    dist = math.hypot(b[0] - a[0], b[1] - a[1])
    if dist == 0:
        return
    steps = max(1, int(dist / (seg + gap)))
    for i in range(steps):
        t0, t1 = i * (seg + gap) / dist, min(1.0, (i * (seg + gap) + seg) / dist)
        ax, ay = a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0
        bx, by = a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1
        d.line([ax * S, (H / S - ay) * S, bx * S, (H / S - by) * S], fill=color, width=int(lw * S))


# ---- titel ----------------------------------------------------------------
text(60, H / S - 52, "Faktureringssystem — system design", size=25, bold=True, color=ACCENT, center=False)
text(62, H / S - 76, "Multi-tenant invoicing SaaS. Arrows show how the parts interact.", size=11, center=False)

# ---- positioner -----------------------------------------------------------
FE_Y, NG_Y, SV_Y, EX_Y, DS_Y, ST_Y = 1170, 1050, 850, 670, 500, 330
sv_cx = {"auth": 250, "billing": 560, "payments": 870, "documents": 1180}
SVW, SVH = 268, 104
sv_top, sv_bot = SV_Y + SVH / 2, SV_Y - SVH / 2
ng_top, ng_bot = NG_Y + 28, NG_Y - 28
ex_top, ex_bot = EX_Y + 30, EX_Y - 30

# ================= PILAR (ritas forst, hamnar under rutorna) ===============
PG = (790, DS_Y)
PG_W = 1260
RD, S3, MP = (300, ST_Y), (1280, ST_Y), (1280, 190)

# --- lagring (gron) — en lodrat pil per tjanst rakt ner i den delade
# Postgres-baren, forskjuten at sidan om event-pilen sa de aldrig overlappar.
# Lodrata linjer lases entydigt som "passerar bakom" exchangen. ---
for name in ("auth", "billing", "payments", "documents"):
    arrow(sv_cx[name] + 84, sv_bot, sv_cx[name] + 84, PG[1] + 54, E_DB, lw=1.6)

# --- ovriga lagringsberoenden dras i ytterkanalerna (x=120 resp. 1460/1520),
# utanfor bade exchange-baren och Postgres-baren (160-1420), sa ingen linje
# nagonsin korsar en annan nod ---
elbow([(sv_cx["auth"] - 90, sv_bot), (120, sv_bot), (120, RD[1]), (RD[0] - 95, RD[1])], E_DB, lw=1.6)
elbow([(sv_cx["documents"] + 120, sv_bot), (1460, sv_bot), (1460, S3[1]), (S3[0] + 105, S3[1])], E_DB, lw=1.6)
elbow([(sv_cx["documents"] + 130, sv_bot), (1520, sv_bot), (1520, MP[1]), (MP[0] + 105, MP[1])], E_DB, lw=1.6)

# --- event (orange) mellan tjanst och exchange ---
arrow(sv_cx["billing"], sv_bot, sv_cx["billing"], ex_top, E_EVT, double=True, lw=2.2)
arrow(sv_cx["payments"], sv_bot, sv_cx["payments"], ex_top, E_EVT, lw=2.2)
arrow(sv_cx["documents"], ex_top, sv_cx["documents"], sv_bot, E_EVT, double=True, lw=2.2)
arrow(sv_cx["auth"], sv_bot, sv_cx["auth"], ex_top, E_EVT, lw=2.2)

# --- HTTP (svart): klienter -> nginx -> tjanster ---
for fx in (300, 700, 1180):
    arrow(fx, FE_Y - 42, fx, ng_top, E_HTTP)
http_routes = {"auth": "/auth/*", "billing": "/admin/*  /portal/*", "payments": "/webhooks/*", "documents": "/webhooks/*"}
for name, route in http_routes.items():
    arrow(sv_cx[name], ng_bot, sv_cx[name], sv_top, E_HTTP)
    text(sv_cx[name], ng_bot - 14, route, size=7.5, color=E_HTTP)

# --- S2S (gra streckad) som bagar ovanfor tjansteraden ---
elbow([(sv_cx["auth"] + 30, sv_top), (sv_cx["auth"] + 30, 930),
       (sv_cx["billing"] - 75, 930), (sv_cx["billing"] - 75, sv_top)], E_S2S, dashed=True)
text((sv_cx["auth"] + sv_cx["billing"]) / 2 - 22, 938, "customer lookup  ·  BankID match", size=7.5, color=E_S2S)

elbow([(sv_cx["billing"] + 40, sv_top), (sv_cx["billing"] + 40, 958),
       (sv_cx["payments"] - 40, 958), (sv_cx["payments"] - 40, sv_top)], E_S2S, dashed=True, double=True)
text((sv_cx["billing"] + sv_cx["payments"]) / 2, 966, "Stripe session  ·  invoice by OCR", size=7.5, color=E_S2S)

elbow([(sv_cx["billing"] + 85, sv_top), (sv_cx["billing"] + 85, 986),
       (sv_cx["documents"] - 40, 986), (sv_cx["documents"] - 40, sv_top)], E_S2S, dashed=True, double=True)
text((sv_cx["billing"] + sv_cx["documents"]) / 2 + 25, 994, "signed PDF URL  ·  invoice snapshot", size=7.5, color=E_S2S)

# ================= RUTOR / NODER ===========================================
box(300, FE_Y, 300, 84, ["Backoffice (SPA)", "React · admin login",
                         "invoices, customers, payments"], FE_F, FE_B)
box(700, FE_Y, 300, 84, ["Portal (SPA)", "React · BankID or password",
                         "view invoices, pay via Stripe"], FE_F, FE_B)
box(1180, FE_Y, 360, 84, ["External systems", "bank file / payment webhook",
                          "Stripe webhook · email delivery reports"], EXT_F, EXT_B)

bar(760, NG_Y, 1360, 56, "nginx — single public entry point (:8080)",
    "serves both SPAs  ·  reverse-proxies /auth /admin /portal /webhooks  ·  blocks /internal/* from the outside",
    NG_F, NG_B)

box(sv_cx["auth"], SV_Y, SVW, SVH, ["auth  (:4001)", "tenants, users, sessions",
                                    "BankID · JWT · M2M tokens", "argon2id, rotating refresh"], SV_F, SV_B, title_sz=13)
box(sv_cx["billing"], SV_Y, SVW, SVH, ["billing  (:4002)", "customers, invoices, ledger",
                                       "recurring templates", "nightly cron 03:00"], SV_F, SV_B, title_sz=13)
box(sv_cx["payments"], SV_Y, SVW, SVH, ["payments  (:4003)", "bankgiro/OCR matching",
                                        "BgMax import · webhooks", "Stripe checkout"], SV_F, SV_B, title_sz=13)
box(sv_cx["documents"], SV_Y, SVW, SVH, ["documents  (:4004)", "Python · FastAPI",
                                         "WeasyPrint PDF rendering", "email + delivery status"], SV_F, SV_B, title_sz=13)

bar(790, EX_Y, 1260, 60, "RabbitMQ — topic exchange « events »",
    "routing keys invoice.* / payment.*  ·  one queue per consumer  ·  transactional outbox + dead-letter queue",
    EX_F, EX_B)

cylinder(PG[0], PG[1], PG_W, 100, ["PostgreSQL — one shared instance",
                                   "one database role per service · GRANTs limited to its own tables",
                                   "every service owns its tables, nobody reads another's"])

cylinder(RD[0], RD[1], 190, 100, ["Redis", "service-token cache", "rate limiting"])
box(S3[0], S3[1], 210, 96, ["S3", "invoice PDFs", "signed, time-limited URLs"], DB_F, DB_B, title_sz=11.5)
box(MP[0], MP[1], 210, 96, ["SMTP", "Mailpit in dev", "real provider in prod"], EXT_F, EXT_B, title_sz=11.5)

# ================= EVENT-TABELL ============================================
rows = [("invoice.sent", "billing → documents"),
        ("invoice.credited", "billing → documents"),
        ("invoice.delivery_updated", "documents → billing"),
        ("payment.matched", "payments → billing"),
        ("payment.partial", "payments → billing"),
        ("tenant.created", "auth → (audit trail)")]
tx, ty0, tw, rh = 560, 240, 420, 24
d.rounded_rectangle([tx * S, (H / S - ty0) * S, (tx + tw) * S, (H / S - (ty0 - len(rows) * rh - 30)) * S],
                    radius=8 * S, fill="#FFF4E6", outline=EX_B, width=int(1.4 * S))
text(tx + 14, ty0 - 18, "Event flow  (routing key → consumer)", size=10.5, bold=True, color=EX_B, center=False)
for i, (k, v) in enumerate(rows):
    yy = ty0 - 30 - i * rh - 10
    text(tx + 14, yy, k, size=8.5, bold=True, color=E_EVT, center=False)
    text(tx + 215, yy, v, size=8.5, center=False)
    if i < len(rows) - 1:
        d.line([(tx + 10) * S, (H / S - (yy - 8)) * S, (tx + tw - 10) * S, (H / S - (yy - 8)) * S],
               fill="#F0DCC0", width=max(1, int(0.8 * S)))

# ================= LEGEND ==================================================
lx, ly = 70, 170
text(lx, ly + 24, "Arrows", size=11, bold=True, center=False)
legend = [("HTTP (through nginx)", E_HTTP, False, False),
          ("Service-to-service REST (M2M token + scope)", E_S2S, True, False),
          ("Event via RabbitMQ (publish / consume)", E_EVT, False, True),
          ("Database / storage", E_DB, False, False)]
for i, (txt, col, dsh, dbl) in enumerate(legend):
    yy = ly - i * 26
    arrow(lx, yy, lx + 74, yy, col, dashed=dsh, double=dbl, lw=2.0, size=8)
    text(lx + 88, yy, txt, size=9.5, center=False)

img.save("docs/system-design.png")
print("OK: docs/system-design.png skapad")
