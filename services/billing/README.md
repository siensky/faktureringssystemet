# billing

Kunder, fakturor, betalningsledger, återkommande mallar — och det nattliga automatiseringsjobbet. Se rot-[README.md](../../README.md) och [PLAN.md](../../PLAN.md) (fas 3, 6, 9, 10, 13, 14).

**Äger:** `company_settings`, `customers`, `invoices`, `invoice_items`, `invoice_templates`, `invoice_snapshots`, `invoice_payments`.

**Gör:** fakturans hela livscykel (utkast → skicka → kreditera), OCR härlett ur fakturanumret, betalningar som rader i stället för en lagrad summa, det dagliga jobbet (förfallomarkering, påminnelser, återkommande fakturor), och de interna S2S-endpoints övriga tjänster läser mot (snapshot, OCR-uppslag, kontosammanfattning).

```bash
docker compose up billing
```
