# documents

PDF-rendering och e-postutskick — den enda tjänsten skriven i Python, vald för WeasyPrint (riktig CSS Paged Media, inte ett headless-webbläsar-hack). Se rot-[README.md](../../README.md) och [PLAN.md](../../PLAN.md) (fas 4, 14).

**Äger:** `documents`, `email_outbox`, `email_webhook_events`.

**Gör:** konsumerar `invoice.sent` / `invoice.credited` / `invoice.reminder_sent`, renderar PDF ur billings frusna snapshot (aldrig de levande tabellerna), laddar upp till S3/MinIO, skickar mejl via SMTP, och rapporterar leveransstatus tillbaka till billing.

```bash
uv sync
uv run uvicorn documents.main:app --reload --port 4004
```
