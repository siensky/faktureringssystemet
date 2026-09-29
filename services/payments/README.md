# payments

Matchar inkommande betalningar mot fakturor, och driver Stripe-kassan för kundportalen. Se rot-[README.md](../../README.md) och [PLAN.md](../../PLAN.md) (fas 5, 10).

**Äger:** `bank_transactions`, `stripe_payments`. Har ingen egen SQL-åtkomst till `invoices` — frågar billing över S2S-HTTP istället.

**Gör:** matchar bankfil-import och webhook-betalningar mot rätt faktura via bankgiro + OCR (följer kedjan om en faktura hunnit ersättas av en påminnelse), skapar Stripe Checkout-sessioner för `/portal/invoices/:id/pay`, och lägger det som inte går att matcha automatiskt i en manuell kö.

```bash
docker compose up payments
```
