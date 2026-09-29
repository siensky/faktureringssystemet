# Plan: Faktureringssystem — reviderad efter granskning

## Context

Multi-tenant SaaS för fakturering: företag registrerar sig, fakturerar sina kunder, och inbetalningar matchas automatiskt mot fakturor via OCR-nummer. Förfallna fakturor får påminnelser med avgift, delbetalningar räknas av mot skulden.

Utgångsläget är ett skelett: fyra tomma Fastify/FastAPI-tjänster med `/health`, en `docker-compose.yml` med healthchecks, en migration byggd på Auth0, färdig felhantering i `src/error/`, och sex rules-filer.

Planen har reviderats i två omgångar. Första omgången bytte arbetssätt (jag implementerar, Sienna granskar) och lade till frontend. Andra omgången är svar på en extern granskning som hittade åtta allvarliga och ett tjugotal mindre luckor. **De rättelserna är inbakade nedan** — de viktigaste är att fakturan får ett explicit `send`-steg, att bokföringsstatus skiljs från leveransstatus, att betalningar blir rader i stället för en summa, att OCR härleds ur fakturanumret i stället för att slumpas, och att `processed_events` skrivs i olika ordning beroende på om sidoeffekten är intern eller extern.

Granskningen läste den *förra* planen, så några punkter var redan lösta: CD är struket, refresh-tokens ligger redan i Postgres. (Portalbetalning via Stripe testläge var struket men återinfördes 2026-09-10 som fas 10 — se nedan.) Sakinnehållet i invändningarna stämmer ändå.

**Innehåll:** [Beslut](#beslut) · [Struktur](#struktur) · [Domänmodell](#domänmodell--rättelserna-från-granskningen) · [Säkerhet](#säkerhet) · [Idempotens](#idempotens) · [Faser](#faser) (fas 0–14, allt mergat till `main`) · [Tester](#tester) · [Verifiering](#verifiering) · [Granskningspunkter](#granskningspunkter--var-de-är-lösta)

---

## Beslut

| Område | Val | Skäl |
|---|---|---|
| Repo | Monorepo: `services/`, `packages/`, `apps/`, `migrations/`, `infra/` | Delade typer och auth-kod utan publicering |
| Tjänster | auth, billing, payments (TS/Bun) + documents (Python/FastAPI) | WeasyPrint ger riktig CSS Paged Media; documents har tunnast delad yta |
| Databas | Postgres, gemensam, gammal migration raderas och byggs om per fas | Inget är deployat |
| Migrationer | En gemensam `/migrations`, **en migration per fas**, DB-roller per tjänst i härdningsfasen | Följer `database.md` #1–2; FK över tjänstegränser fungerar |
| Event | RabbitMQ + transactional outbox med backoff och dead-letter | Inget event får tappas tyst |
| Ingång | nginx som enda publika ingång | En bas-URL för frontend, interna endpoints exponeras aldrig |
| Skydd | Rate limiting i nginx (grov, per IP) + Fastify (fin, **per konto**), CORS, helmet, body limits | Per-IP stoppar inte credential stuffing spritt över IP:n |
| Användarauth | Stateless access-JWT + refresh-token hashad i `user_tokens` | Överlever omstart, går att revokera och lista |
| Inloggning | E-post + lösenord (argon2id), samt BankID via mockad provider | Riktig BankID går inte att köra i CI |
| Signering | **HS256 med separat hemlighet per token-klass** — medvetet val, se Säkerhet | Minst kod; risken skrivs ner som accepterad, inte förbisedd |
| Personnummer | **Krypterat (AES-GCM) + deterministisk HMAC för uppslag** | En läckt databasdump *utan* `PNR_HMAC_KEY` lämnar inte ut personnummer — svenska personnummer har lågt nog värderymd (~100 år × 366 dagar × löpnummer) att en läckt HMAC-nyckel gör hela värderymden uträkningsbar offline; `PNR_HMAC_KEY` är alltså lika skyddsvärd som krypteringsnyckeln, inte en mindre viktig detalj |
| Påminnelse | **Ny faktura; originalet sätts `superseded` och räknas inte som utestående** | Ingen dubbelräkning av skulden |
| OCR | **Härleds ur fakturanumret** (nummer + längdsiffra + Luhn) | Kollision omöjlig per konstruktion; ingen retry-loop |
| Betalningar | **`invoice_payments`, en rad per betalning** — `paid_ore` beräknas, lagras aldrig | Dubbletter blir unique-violation i stället för fel saldo |
| Redis | Rate limiting-räknare, cron-lås, cache av tjänste-tokens | Det som är ofarligt att tappa vid omstart |
| Cron | I billing, Redis-lås som optimering, **DB-villkoret som garanti** | Ett lås som löper ut mitt i jobbet ger två körningar |
| Filer | Amazon S3 (boto3), `adobe/s3mock` som lokal/CI-endpoint (bytt från MinIO 2026-09-29, se `docker-compose.yml`) | Samma SDK, bara annan endpoint-URL |
| E-post | `EmailProvider`-gränssnitt, Mailpit lokalt | Inga riktiga mejl skickas av misstag |
| Betalningar in | Mockad BgMax-fil + webhook, båda idempotenta | Kunden betalar i sin bank |
| Validering | Rena JSON Schema-filer i `packages/contracts`, TS-typer **genereras** ur dem | Ett schema, tre konsumenter: Fastify, TS-typer, Python |
| Frontend | Vite + React Router + TanStack Query + Tailwind, två appar | Backend är separat |
| CI | GitHub Actions: lint → typecheck → unit → **migrate up/down/up** → e2e → docker build | Ingen deploy |
| Ordning | Hela backend först, därefter backoffice och portal | API:et hinner stabiliseras |

---

## Struktur

```
/services
  /auth        (TS, Fastify)     :4001
  /billing     (TS, Fastify)     :4002   ← innehåller cron
  /payments    (TS, Fastify)     :4003
  /documents   (Python, FastAPI) :4004
/packages
  /shared      db, rabbitmq, errors, logger, config, auth-middleware, crypto
  /contracts   JSON Schema för event + API-svar, genererade TS-typer
  /testing     testhjälpmedel som flera tjänster behöver
/apps
  /backoffice  React — administratörer
  /portal      React — "Mina sidor" för kunder
/migrations    gemensam tidslinje, en migration per fas
/infra         nginx.conf, docker-compose.yml
/rules         *.md
```

**Sju lager per modul**, inget lager gör ett annat lagers jobb:

```
routes/       HTTP-vägar, kopplar på schema
controllers/  plockar isär request, anropar service, formar svar
services/     ALL affärslogik — och bara här
repository/   ALL SQL — och bara här
schema/       JSON Schema för inkommande data
mappers/      databasrad ↔ API-form, öre → kronor
types/        TypeScript-typer för modulen
```

### `packages/contracts` når även Python

Envelope och alla event-payloads definieras som **JSON Schema-filer** i `packages/contracts/schemas/`. Från fas 0:

- TS-typer genereras ur schemafilerna (`bun run codegen`), aldrig handskrivna vid sidan av
- Python validerar inkommande event mot **samma filer** med `jsonschema`
- Ett kontraktstest per eventtyp körs i både `bun test` och `pytest` mot samma exempel-payloads

Detta är enda mekanismen som håller de två språken i synk, och den finns därför från början — inte i härdningsfasen.

### Vad som återanvänds

- `src/error/error.ts` och `errorHandler.ts` → `packages/shared/errors/`. `BaseError`-hierarkin är färdig och används oförändrad; documents får en spegling av samma felformat.
- `src/db/db.ts` → `packages/shared/db/`. Den dubblerade uppkopplingen i `src/index.ts` (`@fastify/postgres` *och* `postgres.js`) rensas till `postgres.js`.
- Lagermönstret i `src/invoices/`, `src/customer/`, `src/admin/` flyttas till `services/billing/src/`.
- Healthcheck-blocken i `docker-compose.yml` behålls, men pekas om till `/health/ready`.

---

## Domänmodell — rättelserna från granskningen

### 1. Fakturan får ett explicit `send`-steg

Utan det mejlas fakturan i samma ögonblick den skapas, och `draft` existerar aldrig i praktiken — då är hela oföränderlighetsregeln oåtkomlig och testet "`PUT` mot skickad faktura ger `409`" testar ett läge ingen kan nå.

- `POST /admin/invoices` skapar i `draft` och **publicerar inget event**
- `POST /admin/invoices/:id/send` gör `draft → sent`, sätter `sent_at`, skriver en **snapshot** och publicerar `invoice.sent` — allt i samma transaktion
- `invoice.created` finns inte. Ett event utan konsument är död kod (`code-style.md` #27)

**Snapshot.** PDF:en måste återge fakturan som den såg ut vid utskick. Ändrar tenanten logga eller bankgiro efteråt får det inte ändra hur en bokförd faktura ser ut. Därför skriver `send` en rad i `invoice_snapshots (invoice_id, payload JSONB)` med företagsuppgifter, kundadress, rader och summor. Documents hämtar den via `GET /internal/invoices/:id/snapshot`, aldrig de levande tabellerna. Payloaden i eventet är fortfarande bara id:n (`architecture.md` #8).

### 2. Bokföringsstatus och leveransstatus är två kolumner

Idag sätter `email.sent` fakturans status till `sent`. Är documents nere står fakturan kvar som `draft` fast admin tryckt skicka, och betalningsvillkoren börjar aldrig löpa.

| Kolumn | Ägs av | Värden |
|---|---|---|
| `invoices.status` | Admins handling i billing | `draft` · `sent` · `paid` · `overdue` · `credited` · `superseded` · `settled` |
| `invoices.delivery_status` | Documents rapporter | `none` · `queued` · `sent` · `delivered` · `bounced` · `failed` |

`status` sätts av `send`-endpointen, aldrig av ett leveransevent. `delivery_status` är **monoton**: `delivered` får aldrig skriva över `bounced`. `GET /admin/deliveries?status=failed` läser den andra kolumnen och blir därmed meningsfull.

Båda kolumnerna blir `TEXT` med `CHECK`-constraint, inte `ENUM` — en livscykel som fortfarande rör sig ska inte kräva `ALTER TYPE` för att byta ett värdenamn.

### 3. Påminnelse: ny faktura, originalet stängs

Valt av Sienna. Påminnelsen är en egen faktura (`invoice_type = 'reminder'`, `reminds_invoice_id`) på restskuld plus avgift, och originalet får `status = 'superseded'` med `superseded_by_invoice_id` — i samma transaktion. Utestående skuld är `status IN ('sent','overdue')`, så beloppet räknas exakt en gång.

Originalet blir alltså **inte** `paid` — det vore osant. `superseded` säger vad som faktiskt hänt: skulden har flyttat till en ny post.

**Konsekvensen du behöver känna till:** kunden har originalfakturans OCR i handen. Betalar hen på det numret efter att påminnelsen gått ut, pekar OCR:et på en `superseded` faktura. Matchningen måste därför **följa kedjan** `superseded_by_invoice_id` till den aktuella fakturan och boka betalningen där. Utan det tappas betalningen från precis de kunder som är sena — alltså de som påminnelserna handlar om. Det får ett eget e2e-test.

Endast en påminnelse per kedja: urvalet kräver `reminds_invoice_id IS NULL` (`domain.md` #17).

**Rättslig not vid `reminder_fee_ore`:** 60 kr påminnelseavgift förutsätter enligt lagen (1981:739) om ersättning för inkassokostnader att avgiften avtalats innan skulden uppkom. Kolumnen är per tenant och dokumenteras med att tenanten ansvarar för att det avtalet finns.

### 4. Betalningar blir rader, inte en summa

`paid_ore` som kolumn har samma fel som `domain.md` #11 förbjuder för restskuld, fast över en tjänstegräns: ett dubbellevererat `payment.matched` ökar den två gånger och gör en halvbetald faktura `paid`.

```
invoice_payments (id, tenant_id, invoice_id, payment_id, amount_ore, booked_at)
  UNIQUE (tenant_id, payment_id)
```

Dubbletten blir en unique-violation i stället för ett tyst fel. `paid_ore` beräknas som `SUM(amount_ore)`, lagras aldrig. Restskuld = `total_incl_vat_ore − paid`. En cachad kolumn läggs till först om något mäts som för långsamt (`architecture.md` #22).

Sidovinsten: du kan svara på *vilken* betalning som täckte vad, vilket en summa aldrig kan.

### 5. OCR härleds ur fakturanumret

"Omgenerering vid krock" fungerar inte — en unique-violation avbryter hela transaktionen i Postgres, så en retry-loop skulle kräva `SAVEPOINT` per försök mitt i transaktionen som redan håller radlåset på nummerserien.

`ocr = luhn(invoice_number ‖ längdsiffra)`, precis som Bankgirot gör det. Fakturanumret är redan unikt och obrutet per tenant, alltså är kollision omöjlig per konstruktion. `UNIQUE (tenant_id, ocr_number)` ligger kvar som databasgaranti, men ska aldrig kunna lösa ut.

**Följd som måste skrivas ner:** OCR blir därmed förutsägbart. Det är ofarligt — OCR står tryckt på fakturan och är ingen hemlighet — men det får aldrig användas som identitetsbevis. Portalens åtkomstkontroll går på tenant plus kund, aldrig på OCR.

### 6. Manuell hantering blir en riktig kö

"Tappas aldrig tyst" nämndes tre gånger utan tabell, endpoint eller test.

- `bank_transactions.status`: `matched` · `unmatched` · `manual_review` · `ignored`
- `bank_transactions.unmatched_reason`: `unknown_bankgiro` · `unknown_ocr` · `overpayment` · `ambiguous`
- `GET /admin/payments/unmatched`, `POST /admin/payments/:id/match { invoiceId }` (kräver `Idempotency-Key`, beloppet verifieras på servern), `POST /admin/payments/:id/ignore { reason }`

**Specialfallet okänt bankgiro:** en sådan transaktion har ingen tenant alls, så `tenant_id` är `NULL` och den kan per definition inte visas i något tenants backoffice. Den hamnar i en drift-endpoint utanför tenant-modellen, och antalet larmas på. Missas det blir "tappas aldrig tyst" osant just för det fall som är svårast att upptäcka.

### 7. Audit-logg

Uppdelningen `admins → users` motiverades med att kunna se vem som gjort vad, men det fanns inget ställe där det syntes. Med sjuårig arkiveringsplikt är det en märkbar lucka.

```
audit_log (id, tenant_id, actor_user_id, actor_service, action,
           resource_type, resource_id, correlation_id, occurred_at, metadata JSONB)
```

Skrivs i samma transaktion som ändringen, append-only (ingen `UPDATE`/`DELETE`-grant). Täcker: fakturaskick, kreditering, radering av utkast, kundändringar, manuell betalningsmatchning, inbjudan och rolländring, tenant-avstängning, cron-körning. Aldrig personnummer eller tokens i `metadata`.

### 8. `tenants.status` konsumeras

Fanns i modellen men användes ingenstans — en avstängd tenant kunde fortsätta arbeta tills token gick ut, och cron fakturerade vidare.

- Login och refresh kontrollerar status; avstängd ger `403` med förklaring (kallaren *är* rätt identifierad, så här är `403` rätt och inte `404`)
- Cron-urvalet filtrerar på aktiv tenant
- `requireService()` avvisar `X-Tenant-Id` som pekar på avstängd tenant

### 9. Kreditfakturans egen livscykel

Odefinierad tidigare. En kreditfaktura har negativa belopp och kan aldrig bli `paid` av en inbetalning.

`invoice_type = 'credit_note'`, skapas direkt i `settled` i samma transaktion som originalet blir `credited`. Den blir aldrig `overdue`, plockas aldrig av påminnelsejobbet, och räknas aldrig som utestående. Den har ändå `delivery_status`, eftersom den skickas till kunden som PDF.

### 10. Cron slutar bero på auth

`auth:tenant:read` gjorde ett nattligt batchjobb beroende av att auth svarar. Billing äger redan `company_settings` med en rad per tenant — jobbet itererar över den. Tenant-status hålls som en lokal läsmodell uppdaterad av `tenant.created` / `tenant.suspended` / `tenant.reactivated`. Scope-listan blir en rad kortare.

---

## Säkerhet

### Signering: HS256, som ett uttalat val

Sienna behåller HS256. Konsekvensen skrivs in i `rules/architecture.md` så den är ett beslut och inte en glömska: **den hemlighet som verifierar kan också signera**, alltså kan varje tjänst som verifierar en token-klass också utfärda tokens i den klassen. Försvaret är att alla fyra tjänsterna är samma kodbas på samma interna nät.

Fyra saker begränsar skadan och kostar nästan ingenting:

1. **Separat hemlighet per token-klass** — `JWT_USER_SECRET` och `JWT_SERVICE_SECRET`, distribuerade bara till de tjänster som faktiskt verifierar respektive klass. Documents har inga användar-endpoints och får därför **aldrig** användarhemligheten.
2. **Algoritmen pinnas explicit** vid verifiering (`algorithms: ['HS256']`). `alg` i token-headern litas aldrig på — det är den klassiska `alg: none`-attacken.
3. **`iss`, `aud` och `token_type` valideras** vid varje verifiering. Tjänste-token har `aud: internal`, användar-token `aud: api`. En token som passerar fel dörr avvisas på tre oberoende fält.
4. **Tjänste-tokens lever fem minuter.** Kort livstid är den enda revokering en stateless token har.

Uppgraderingsvägen till asymmetrisk signering är inbyggd: all signering och verifiering ligger i `packages/shared/auth`, och bytet är en nyckeltyp och en rad i två funktioner.

### Repository-basklassen failar stängt

Saknas tenant i `RequestContext` **kastas ett fel** — filtret får aldrig tyst utebli. Skillnaden mellan `WHERE tenant_id IS NULL` (returnerar inget, ofarligt) och ett bortfallet filter (returnerar alla tenanters rader) är skillnaden mellan en bugg och total läcka. Skrivs in i `architecture.md` och får ett eget test i M2M-sviten: ett S2S-anrop utan `X-Tenant-Id` mot en tenant-ägd resurs ska ge fel, aldrig data.

### Personnummer

`customers.org_or_pnr` delas i två kolumner för privatkunder: `pnr_encrypted` (AES-GCM, appnivå) och `pnr_hmac` (deterministisk, för exakt uppslag och sökning). Två **separata** nycklar, båda från miljön — i drift från en secrets manager, och dokumenterat att de aldrig får ligga i samma backup som databasen. `users.pnr_hash` använder samma HMAC-nyckel så BankID-inloggning kan slå upp kunden.

Förlusten är delsökning på pnr; exakt sökning fungerar via HMAC:en, och kundlistan söks ändå på namn och e-post.

Signerade PDF-URL:er läggs till i förbudslistan i `domain.md` #19 — de är bärartokens precis som återställningslänkar.

### Rate limiting från och med auth-fasen, inte fas 8

`code-style.md` #22 kräver strypning på login, BankID-init och glömt-lösenord — men de byggs i fas 1 och skulle annars stå oskyddade i sex faser.

- **Per konto** i Redis med exponentiell utlåsning på upprepade misslyckade inloggningar. Per-IP i nginx stoppar inte credential stuffing spritt över IP:n.
- **BankID-init** strypt per IP och per `pnr_hmac` — varje anrop är en kostnadsyta.
- **Ingen kontoenumerering:** `/register` och `/forgot-password` svarar identiskt oavsett om adressen finns, och gör alltid samma arbete (en hashning även när användaren saknas) så svarstiden inte skvallrar.

### Webhooks

Tre detaljer som inte fanns någonstans:

1. **Signaturen räknas över rå body.** Fastify har redan JSON-parsat när handlern kör, så webhook-routes får en `addContentTypeParser` som behåller bufferten. Validera först, parsa sen.
2. **Replayskydd:** tidsstämpelheader inom ±5 minuter, plus deduplicering på leverantörens event-id.
3. **Monoton status:** statusrapporter kommer regelbundet i fel ordning. Uppdateringen är villkorad (`WHERE status = <förväntat>`), så en försenad `delivered` inte kan återuppliva en död adress.

### Transportnära grunder

`@fastify/cors` med explicit origin-allowlist per app (aldrig `*` när cookies eller Authorization är med), `@fastify/helmet`, `bodyLimit` på 256 KB som standard med undantag bara på filimport-routen, och `client_max_body_size` i nginx som matchar.

`/health` delas i `/health/live` (processen lever) och `/health/ready` (Postgres, RabbitMQ och Redis nåbara). Docker healthcheck och nginx upstream använder `ready`; `live` används för omstartsbeslut så en tillfälligt onåbar databas inte startar om en frisk process.

---

## Idempotens

Principen är densamma överallt: **hitta en naturlig nyckel som är stabil mellan körningar, lägg en `UNIQUE`-constraint på den i databasen, och låt krocken vara svaret.** Constraint, inte en `SELECT`-koll före `INSERT` — mellan kollen och skrivningen hinner en parallell körning slinka in.

### 1. Publiceraren (outbox → RabbitMQ)

`event_outbox.event_id UUID UNIQUE`, satt när raden skrivs — i samma transaktion som affärsdatan, inte vid publiceringen. Det är den detaljen som gör konsumentens dedup nedan möjlig: ett omsänt event bär **samma** id.

Publishern behöver felhantering som saknades helt:

```
attempts INT NOT NULL DEFAULT 0
next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
last_error TEXT
published_at TIMESTAMPTZ
failed_at TIMESTAMPTZ          -- dead letter
```

Plockning med `FOR UPDATE SKIP LOCKED` filtrerat på egen `source_service` och `next_attempt_at <= NOW()`. Exponentiell backoff vid fel; efter maxantal försök sätts `failed_at` och larm går. Partiellt index `WHERE published_at IS NULL AND failed_at IS NULL` — utan det växer skanningen monotont med tabellen. Publicerade rader äldre än 30 dagar städas av det dagliga jobbet.

**Ordning garanteras inte.** Med `SKIP LOCKED`, flera publishers eller prefetch > 1 kan `invoice.sent` och `invoice.credited` för samma faktura komma i fel ordning. Försvaret är domänregel 3 — status går aldrig baklänges — och att `delivery_status` är monoton. Det skrivs ut som *skälet* till att de reglerna finns, inte som en trevlig bieffekt.

### 2. Event-konsumenter — två fall, inte ett

Regeln "skriv `processed_events` innan du gör jobbet" är rätt i ena fallet och farlig i det andra. Committas markeringen före en extern sidoeffekt och tjänsten sedan kraschar är eventet permanent markerat som hanterat: ingen retry, ingen dead-letter, ingen PDF. At-least-once har blivit at-most-once — exakt den tysta dataförlust outboxen finns för att förhindra.

**Fall A — effekten är en skrivning i den egna databasen** (billing som konsumerar `payment.matched`):

`INSERT INTO processed_events` → gör jobbet → `COMMIT`, **allt i en transaktion**. Unique-violation betyder redan hanterat: `ack`:a och gör inget. Kraschar jobbet rullar även markeringen tillbaka, så eventet får ett ärligt nytt försök.

**Fall B — effekten är extern** (documents som skriver till S3 och skickar mejl):

Sidoeffekten kan inte ligga i databastransaktionen. Gör jobbet **först**, markera efteråt, och luta dig på den naturliga idempotensnyckeln. Nyckeln `tenant_id + invoice_id + document_type` är då inte ett extra bälte — den **är** mekanismen. `processed_events` blir en optimering som slipper göra om arbetet, inte garantin.

`rules/architecture.md` #7 skrivs om till dessa två fall.

### 3. Skapande via API

```
idempotency_keys (tenant_id, key, endpoint, request_hash,
                  state, response_status, response_body, created_at, expires_at)
  PRIMARY KEY (tenant_id, key)
```

Skriv nyckeln som `in_progress` först, i samma transaktion som resursen. Vid krock:

| Läge | Svar |
|---|---|
| `completed`, samma `request_hash` | det lagrade svaret oförändrat, inklusive statuskod |
| `completed`, **annan** `request_hash` | `422` — samma nyckel med annan body är ett klientfel, inte en replay |
| `in_progress` | `409` med `Retry-After` — en samtidig dubblett pågår |

TTL 24 timmar, städas av det dagliga jobbet. Krävs på `POST /admin/invoices`, `/:id/send`, `/:id/credit`, `/admin/customers` och `/admin/payments/:id/match` — allt som skapar en bokföringspost eller förbrukar ett fakturanummer.

Frontend genererar nyckeln med `crypto.randomUUID()` när formuläret **öppnas**, inte när det skickas — annars får varje klick en ny nyckel och skyddet är verkningslöst.

### 4. Webhooks och filimport

`UNIQUE (source, external_id)` där `source` är `'bgmax'` eller `'webhook:<leverantör>'`. Unikheten är **global över tenants**, inte per tenant: tenant härleds ur bankgirot och kan härledas annorlunda vid en omimport, så en per-tenant-nyckel skulle släppa igenom dubbletten.

BgMax-poster har inte alltid ett eget id. Då härleds nyckeln deterministiskt ur filen: `sha256(filens sha256 ‖ postens ordningsnummer)`. Samma fil ger samma nycklar vid ominläsning.

Importen kör `INSERT ... ON CONFLICT DO NOTHING` och räknar faktiskt skrivna rader. Andra gången skrivs noll rader och inga betalningsevent publiceras.

### 5. PDF och S3

`UNIQUE (tenant_id, invoice_id, document_type)` på `documents`. S3-nyckeln härleds ur samma tre värden: `tenantId/invoices/{invoiceId}/{documentType}.pdf`. Uppladdningen blir självskrivande — samma event två gånger skriver samma objekt till samma nyckel. Ingen `document-1.pdf` och `document-2.pdf`.

### 6. E-postutskick

`email_outbox` med `UNIQUE (tenant_id, invoice_id, email_type)`. Statusövergångar som villkorade uppdateringar: `UPDATE ... SET status='sent' WHERE id=$1 AND status='queued'`. Noll skrivna rader betyder att någon annan hann först — då skickas inget mejl. Utan villkoret kan två arbetare båda läsa `queued`, båda skicka, och kunden får fakturan två gånger.

### 7. Cronjobbet

**Redis-låset ger inte "exakt en gång"** — ett lås som löper ut medan jobbet fortfarande kör ger två samtidiga körningar. Låset är en optimering som slipper dubbelarbete vid samtidiga försök. **Garantin ligger i urvalsvillkoret:**

```sql
WHERE date_due < CURRENT_DATE
  AND status IN ('sent', 'overdue')        -- superseded/credited/paid utesluts
  AND invoice_type = 'invoice'             -- aldrig på påminnelser eller kreditfakturor
  AND reminds_invoice_id IS NULL
  AND NOT EXISTS (
        SELECT 1 FROM invoices r WHERE r.reminds_invoice_id = invoices.id
      )
```

Andra körningen hittar ingenting att göra, oavsett om låset höll. Samma princip för återkommande fakturor: `next_generation_date` flyttas fram i **samma transaktion** som fakturan skapas.

Ett jobb som bara skyddas av ett lås är inte idempotent — det har bara inte krockat än.

---

## Faser

Finindelade. **Varje fas avslutas med en pull request.** Arbetet sker på branch enligt `rules/git.md` #3 (`fas0/fundament`, `fas1/auth`), aldrig direkt på `main`. PR:en beskriver vad och varför, har Definition of Done avbockad och grön CI. Jag stannar där och väntar på granskning; nästa fas börjar efter squash-merge. Fas 3 (billing) och fas 7 (e2e) delas i flera PR:ar — de blir för stora för en läsbar diff.

### Fas 0 — Fundament

Bun workspaces. `packages/shared` med db-klient, RabbitMQ-anslutning, errors, pino-logger med maskering av pnr/tokens/lösenord, env-validering som kraschar vid uppstart, `crypto`-modulen. `packages/contracts` med envelope som JSON Schema, TS-codegen och kontraktstest i båda språken. Fyra tjänster med `/health/live` och `/health/ready` som utbyter ett `ping`-event. Egna RabbitMQ-credentials per tjänst. nginx, CORS, helmet, body limits, grov rate limiting. Gammal migration raderas; `0001_extensions.js`. CI inklusive `migrate up → down → up`.

**Klart när:** `docker compose up` ger fyra `healthy` tjänster bakom nginx, ping-eventet går runt, kontraktstesten är gröna i både `bun test` och `pytest`, CI grön.

### Fas 1 — Auth, tenancy och sessioner

`0002_auth.js` (tenants, users, user_tokens, service_clients) och `0003_shared.js` (event_outbox, processed_events, idempotency_keys, audit_log). Registrering skapar tenant + första admin i en transaktion och publicerar `tenant.created` via outbox. Argon2id. Access-JWT 15 min; refresh-token hashad i `user_tokens`, som även bär engångstokens för verifiering, återställning och kundinbjudan — alla med TTL, engångsanvändning och ogiltigförklaring vid lösenordsbyte. `requireUser()` och repository-basklassen som failar stängt. Rate limiting per konto, enumereringssäkra svar. `tenants.status` kontrolleras vid login och refresh. Audit-logg tas i bruk.

**Klart när:** register → verifiera → login → refresh → logout går, en manipulerad `tenantId` i body ignoreras bevisligen, och en avstängd tenant kan inte logga in.

### Fas 2 — M2M och BankID-mock

`service_clients` + `POST /auth/token` (`client_credentials`). Tjänste-token HS256 med `JWT_SERVICE_SECRET`, `aud: internal`, `token_type`, 5 min TTL, pinnad algoritm. `requireService(scope)` som separat funktion. Redis-cache av tjänste-token. `BankIdProvider` med `MockBankIdProvider`, uppslag på `pnr_hmac`, inget konto skapas av en lyckad signering.

**Klart när:** användar-token avvisas på `requireService()`-endpoints och tvärtom, fel scope ger `403`, `X-Tenant-Id` ignoreras på användar-endpoints, och ett S2S-anrop utan tenant kastar fel i stället för att returnera data.

### Fas 3 — Billing: kärnan

`0004_billing.js`. Kunder med krypterat pnr. Fakturor, rader, snapshots, `invoice_payments`, `invoice_templates`. Fakturanummer med `SELECT ... FOR UPDATE` i skapandetransaktionen; OCR härlett ur numret. Moms per rad med **matematisk avrundning halvt uppåt per rad**, summering av avrundade radbelopp, ingen öresavrundning av totalen. `PUT`/`DELETE` endast på `draft`. `POST /:id/send` med snapshot och `invoice.sent`. `POST /:id/credit`. `Idempotency-Key`. Outbox-publisher med backoff och dead-letter. **S2S-läsendpoints som fas 4 och 5 behöver:** `GET /internal/company-settings`, `/internal/customers/:id`, `/internal/invoices/:id/snapshot`, `/internal/invoices/by-ocr`.

**Klart när:** parallella fakturor ger obruten nummerserie, `PUT` mot skickad faktura ger `409`, kreditering nollar originalet, och företag A får `404` på företag B:s faktura.

### Fas 4 — Documents: PDF och utskick

`0005_documents.js`. FastAPI konsumerar `invoice.sent` med idempotens enligt fall B. WeasyPrint renderar **ur snapshoten**. S3 via boto3, nycklar prefixade `tenantId/`, signerad tidsbegränsad URL. `email_outbox` med villkorade övergångar. `POST /webhooks/email-status` med rå-body-signatur, tidsfönster och monoton status. Hård studs sätter `customers.email_valid = false`; mjuk studs fortsätter. Rapporterar tillbaka `delivery_status` till billing.

**Klart när:** ett `invoice.sent` ger PDF i storage och mejl i Mailpit, fel signatur avvisas, hård studs flaggar adressen, och fakturans `status` är oförändrad av leveransutfallet.

### Fas 5 — Payments: matchning

`0006_payments.js`. Webhook och BgMax-filimport, båda idempotenta med härledd nyckel. Tenant ur mottagarbankgirot. OCR-uppslag mot billing via `billing:invoice:read`, och **matchningen följer `superseded_by_invoice_id`-kedjan**. Delbetalning skriver en `invoice_payments`-rad och publicerar `payment.partial`; full betalning `payment.matched`. Okänt bankgiro, okänt OCR och överbetalning går till manuell hantering med endpoints och drift-vy.

**Klart när:** två tenants med samma OCR matchas rätt tack vare bankgirot, en betalning på en superseded fakturas OCR landar på påminnelsen, och samma fil importerad två gånger ger noll nya rader.

### Fas 6 — Automatisering

Schemaläggare i billing kl. 03:00 `Europe/Stockholm`, Redis-lås som optimering. Dagligt jobb: markera `overdue`, skapa påminnelsefaktura och sätta originalet `superseded`, generera återkommande fakturor, städa utgångna `user_tokens`, `idempotency_keys` och publicerade outbox-rader. Iterering per tenant över `company_settings` med lokal tenant-status. Skyddad endpoint för manuell körning.

**Klart när:** två körningar i rad ger ingen dubbelpåminnelse, urvalet är testat över båda DST-dygnen, och en avstängd tenant får inga påminnelser.

### Fas 7 — Stort e2e-svit och härdning

Hela sviten nedan. Separata Postgres-roller med `GRANT` bara på egna tabeller. Larm på dead-letter och på omatchade transaktioner utan tenant.

**Klart när:** sviten är grön i CI och payments får rättighetsfel om den försöker skriva i `invoices`.

### Fas 8 — Backoffice

Inloggning, kunder, fakturalista med statusfilter, fakturaformulär med live-summering, fakturadetalj med `send`- och kreditknapp, leveransvy (`delivery_status`), betalningsöversikt, manuell matchning av omatchade transaktioner. Typer importeras från `packages/contracts` så en ändrad endpoint blir ett kompileringsfel — handskrivna REST-typer, inte genererade ur JSON Schema som planens Validering-beslut annars kräver; en medveten avvikelse för REST-formen specifikt (event-kontrakten är fortfarande schema + codegen), värd att stänga i en senare fas.

Två små S2S-lösa tillägg som backoffice behöver men som inte fanns från fas 3/1: `GET /admin/deliveries?status=` i billing (leveransvyn — samma `invoices`-tabell, filtrerad på `delivery_status` i stället för `status`) och en riktig `GET /auth/me` i auth (ersätter fas 2:s testfixtur på samma path).

**Klart när:** inloggning → kund → faktura med live-summering → skicka → kreditera → leveransvy → manuell betalningsmatchning går att genomföra i webbläsaren mot en körande stack, `bun run typecheck`/`lint`/`test` är gröna för `apps/backoffice` också, och tenant-isoleringen på de två nya endpointsen är e2e-testad.

### Fas 9 — Kundportal

BankID eller lösenord, samma JWT. `GET /portal/invoices`, `/:id`, `/:id/pdf` (signerad URL), `/account-summary` som räknar `status IN ('sent','overdue')` och därför aldrig dubbelräknar en påminnelse. Inbjudningsflöde med engångslänk. Åtkomstkontroll i två lager: rätt tenant **och** rätt kund.

### Fas 10 — Portalbetalning via Stripe (testläge)

Återinförd 2026-09-10 på Siennas begäran (var struken i den granskade planen). BgMax/OCR/bankgiro-matchningen i fas 5 är fortfarande den primära modellen — projektbeskrivningen bygger på den. Den här fasen låter kunden dessutom starta betalningen inifrån portalen.

- `POST /portal/invoices/:id/pay` skapar en Stripe Checkout-session i **testläge**. Beloppet sätts av servern ur fakturan, aldrig av klienten (`domain.md` #27).
- Stripes webhook tas emot av **payments** — samma tjänst som redan äger den säkerhetsytan. Stripes egen signaturvalidering (`Stripe-Signature`, rå body, tidsfönster) och idempotens på Stripes event-id, precis som BgMax-filerna (`domain.md` #25, planens idempotensavsnitt #4).
- **Betalstatus kommer alltid från webhooken, aldrig från redirecten** (`domain.md` #26). "Tack"-sidan bevisar ingenting.
- Resultatet blir en `invoice_payments`-rad och en `payment.matched` — exakt som en BgMax-betalning. Resten av kedjan (billing sätter `paid`, delbetalning → `payment.partial`) är redan byggd i fas 5 och ändras inte.
- Stripe-nyckeln (`STRIPE_SECRET_KEY`, testläge) och webhook-hemligheten kommer från miljön (`code-style.md` #23).

**Klart när:** en simulerad Stripe-testbetalning ger fakturan `paid` via webhooken, en webhook med fel signatur avvisas, en manipulerad beloppsparameter från klienten ignoreras, och samma Stripe-event levererat två gånger bokförs bara en gång.

### Fas 11 — Riktig BankID (valfri)

`MockBankIdProvider` → `RealBankIdProvider` mot RP-testmiljön. Mocken tas inte bort; CI kör vidare mot den.

### Fas 12 — BankID-igenkänning, tenant-övergripande

En privatperson som redan är registrerad som kund hos ett eller flera företag i systemet kan logga in **en gång** med BankID — utan inbjudningslänk — och se alla de företagen, som Klarna.

- **Ny tabell `user_company_links`** (`0011_bankid_customer_portal.js`): kopplar en BankID-inloggningsidentitet till N `(tenant, kund)`-par. Tenant-isoleringens kärna (`TenantScopedRepository`, JWT:ns enda-tenant `tenantId`-claim) är helt orörd — varje session gäller fortfarande exakt ett företag åt gången.
- **Tenant-övergripande uppslag** i billing (`GET /internal/customers/by-pnr-hmac`, egen scope `billing:customer:lookup`) — samma mönster som bankgiro→tenant-uppslaget i betalningsmatchningen, generaliserat till flera träffar.
- **`POST /auth/companies/switch`** byter aktivt företag, verifierar alltid mot länktabellen server-side — litar aldrig på klientens `tenantId`.
- **`GET /auth/companies/overview`** — en läsning per länkat företag (aldrig en fråga som korsar tenant-gränsen), tolerant mot att ett enskilt företag svarar trögt eller inte alls.
- Portal-frontend: BankID-inlogg med roterande QR-kod, företagsöversikt, byt-företag.

**Klart när:** samma personnummer kopplat till kunder hos två olika tenants loggar in en gång och ser båda, ett byte av aktivt företag ger en isolerad session verifierad server-side, och `GET /auth/refresh` fungerar för en BankID-identitet (`users.tenant_id` är `NULL` för den identitetstypen — ett separat regressionstest).

### Fas 13 — Återkommande fakturor: en egen yta

Fas 6 gav mallarna motorn (nattlig generering, `next_generation_date` som rullar fram) men ingen väg för en admin att faktiskt skapa eller ändra en mall. Den här fasen ger `invoice_templates` fullständig CRUD:

- `POST`/`GET`/`PUT`/`DELETE /admin/invoice-templates` i billing, samma mönster (repository/service/schema) som fakturor.
- Backoffice: formulär för att skapa och redigera en mall (kund, intervall, rader, nästa genereringsdatum).
- Portal: en skrivskyddad vy — kunden ser sina aktiva återkommande fakturor, ändrar dem aldrig själv.

**Klart när:** en admin skapar en månadsvis mall i backoffice, cron genererar en faktura av den vid nästa körning precis som fas 6 redan bevisat, och kunden ser mallen (men ingen redigeringsknapp) i portalen.

### Fas 14 — Påminnelser får en egen leveransväg

Påminnelser skapades redan korrekt av cron-jobbet (fas 6: ny faktura, restskuld + avgift, originalet `superseded`) men nådde aldrig kunden — den ursprungliga implementationen publicerade medvetet inget event, för att återanvända `invoice.sent` hade gett en påminnelse ett mejl som sa "Faktura". Den här fasen ger påminnelsen en egen, fullständig väg genom hela kedjan:

- Eget event `invoice.reminder_sent` (`packages/contracts/schemas/events/`) i stället för `invoice.sent` återanvänt.
- `documents.document_type`/`email_outbox.email_type` utökade med `'reminder'` (`0012_paminnelseleverans.js`).
- PDF:en får rubriken "Påminnelse" plus en referensrad till originalfakturans nummer; mejlets ämnesrad och brevtext blir egna för påminnelser i stället för fakturans hårdkodade text.
- Ingen backfill av redan skapade påminnelser — bara nya, framåt.

**Klart när:** `e2e/full-lifecycle.test.ts`s påminnelsekedja verifierar att `document_type = 'reminder'`, att ett mejl med ämnesraden "Påminnelse …" faktiskt går fram i Mailpit, och att `deliveryStatus` går till `sent` på påminnelsen — bevis på att `invoice.delivery_updated` med `documentType: 'reminder'` passerar billings konsument i stället för att dödbrevlådas av det gamla tvåvärda enumet.

---

## Tester

**Enhetstester i varje tjänst som täcker alla centrala delar:** OCR-härledning och Luhn, momsberäkning och avrundning, matchningslogik inklusive kedjeföljning, cron-urval med manipulerad klocka över båda DST-dygnen, token-generering och algoritm-pinning, kryptering och HMAC, mallrendering och studshantering i pytest.

**Coverage-krav** (saknades i `testing.md`): ≥ 90 % på `services/**/services/**` och andra rena logikmoduler. Ingen global siffra — den skulle bara belöna tester på getters.

**Ett stort e2e-test i backend** mot riktig Postgres och RabbitMQ via Testcontainers, med BankID, e-post och bank mockade:

- Lyckade vägen: registrera → kund → faktura i `draft` → **send** → PDF ur snapshot → mejl i Mailpit → betalning på OCR → `paid`
- Snapshot: ändra företagets logga efter utskick, återgenerera PDF, verifiera att den gamla loggan står kvar
- `status` kontra `delivery_status`: stoppa documents, skicka fakturan, verifiera att `status = 'sent'` ändå
- Delbetalning → påminnelse på restskuld + avgift → originalet `superseded` → **betalning på originalets OCR landar på påminnelsen**
- Kontoutdrag i portalen dubbelräknar inte en påminnelse
- Kreditering: `409` på `PUT`/`DELETE`, kreditfaktura `settled`, originalet `credited`, nummerserien obruten
- Överbetalning, okänt OCR och okänt bankgiro hamnar i manuell hantering och syns i rätt vy
- Tenant-isolering `404` på varje skyddad resurs; rollisolering i portalen
- Tokenförväxling, fel scope `403`, inget token `401`, `X-Tenant-Id` utan effekt för slutanvändare, S2S utan tenant kastar
- Idempotens: samma event, samma fil, samma `Idempotency-Key` två gånger — samma nyckel med annan body ger `422`
- Samtidighet på nummerserien; två tenants med identiskt OCR
- Cron två gånger, avstängd tenant utesluten
- Rate limiting: `429` på upprepade inloggningsförsök från olika IP mot samma konto
- Webhook med fel signatur, med gammal tidsstämpel, och `delivered` efter `bounced`

**Isolering mellan tester:** `testing.md` #11 säger idag "egen transaktion som rullas tillbaka". Det fungerar för repository-tester men **inte** för e2e över HTTP och RabbitMQ — flera anslutningar ser inte varandras öppna transaktion. Regeln delas: transaktionsrollback för integrationstester i samma process, schema per test eller egen container för e2e.

---

## Regeländringar

| Fil | Ändring |
|---|---|
| `architecture.md` | #7 delas i fall A/B (intern kontra extern sidoeffekt). Ny regel: tenant som saknas kastar fel, filtret får aldrig utebli. Ny regel: HS256-risken som uttalat accepterat val. `auth:tenant:read` utgår ur scope-tabellen. Outbox-ordning och varför statusreglerna är försvaret. |
| `domain.md` | #15–18 skrivs om till supersession-modellen och kedjeföljning vid betalning. Ny: kreditfakturans livscykel. Ny: `status` kontra `delivery_status`. Ny: OCR härleds och är förutsägbart, aldrig ett identitetsbevis. #19 utökas med signerade URL:er. #21 blir anonymisering, inte radering. Rättslig not vid påminnelseavgiften. Avrundningsregeln preciseras. |
| `database.md` | #1 förtydligas med den faktiska migrationsordningen. #16 nyanseras: `TEXT` + `CHECK` för livscykler som rör sig, `ENUM` bara för stabila mängder. Ny: `paid_ore` lagras aldrig. Ny: outbox-kolumner och partiellt index. `RESTRICT` mot kund kopplas ihop med anonymisering. |
| `code-style.md` | `schema/` och `types/` läggs till i lagerlistan. Ny: algoritmen pinnas vid JWT-verifiering, `alg` i headern litas aldrig på. Ny: CORS, helmet, body limits. Rate limiting flyttas fram till auth-fasen. |
| `testing.md` | #11 delas i integration kontra e2e. Coverage-krav skrivs in. `migrate up/down/up` blir en punkt i Definition of Done. |

---

## Filer som ändras

**Raderas:** `migrations/1775829869264_initial-migration.js` (byggs om per fas), `db.md` (Auth0), `src/plan.md`.

**Skrivs om:** `package.json` (workspace-rot), `docker-compose.yml` (postgres, redis, rabbitmq, mailpit, minio, nginx + fyra tjänster, healthcheck mot `/health/ready`), `Dockerfile` per tjänst (nuvarande kör npm/node trots Bun), `CLAUDE.md` och minnesfilen `codes-everything-herself.md`, samt de fem rules-filerna ovan.

**Flyttas:** `src/error/*` → `packages/shared/errors/`, `src/db/db.ts` → `packages/shared/db/`.

---

## Verifiering

1. `docker compose up` — alla tjänster `healthy` på `/health/ready`, nginx svarar
2. `bun test` och `pytest` gröna, inklusive kontraktstesten mot samma JSON Schema
3. `bun run migrate up && down && up` — rent i båda riktningarna
4. `bun run test:e2e` — hela sviten grön mot Testcontainers
5. Rökprov via backoffice: registrera → kund → faktura i `draft` → ändra den → skicka → PDF med rätt logga → mejl i Mailpit på `localhost:8025` → posta betalning → `paid`
6. Rökprov av påminnelsekedjan: förfallen faktura → trigga cron → påminnelse med restskuld + avgift, originalet `superseded`, portalens saldo oförändrat i belopp
7. Rökprov av oföränderlighet: `PUT` mot skickad faktura ger `409`, kreditfaktura skapas, serien obruten
8. CI grön före merge till `main`

---

## Granskningspunkter → var de är lösta

| # | Punkt | Löst i |
|---|---|---|
| 1 | `processed_events`-ordning ger at-most-once | Idempotens 2, fall A/B; `architecture.md` #7 |
| 2 | Inget `send`-steg, `draft` oåtkomligt | Domänmodell 1, fas 3 |
| 3 | Faktura- och leveransstatus sammanblandade | Domänmodell 2 |
| 4 | Påminnelsen dubblerar skulden | Domänmodell 3 (supersession + kedjeföljning) |
| 5 | `paid_ore` denormaliserad | Domänmodell 4 (`invoice_payments`) |
| 6 | `pnr_hash` skyddar mindre än påstått | Säkerhet: personnummer |
| 7 | Repository failar inte stängt | Säkerhet: fail closed + test i fas 2 |
| 8 | Signeringsalgoritm bara specad för M2M | Säkerhet: HS256 som uttalat val, fyra begränsningar |
| 9 | `Idempotency-Key` underspecad | Idempotens 3 |
| 10 | OCR-omgenerering fungerar inte | Domänmodell 5 (härlett OCR) |
| 11 | Manuell hantering aldrig modellerad | Domänmodell 6 |
| 12 | `contracts` når inte Python | Struktur: JSON Schema + codegen + kontraktstest från fas 0 |
| 13 | Outbox saknar felhantering och ordning | Idempotens 1 |
| 14 | Redis-låset ger inte exakt en gång | Idempotens 7 |
| 15 | Bankfil saknar externt id | Idempotens 4 |
| 16 | Webhook-validering ospecad | Säkerhet: webhooks |
| 17 | Rate limiting först i fas 8 | Säkerhet + fas 1 |
| 18 | Ingen audit-logg | Domänmodell 7 |
| 19 | `tenants.status` konsumeras aldrig | Domänmodell 8 |
| 20 | Cron beror i onödan på auth | Domänmodell 10 |
| — | Migrationsordning motsäger sig själv | Faser: en migration per fas, gammal raderas |
| — | `ENUM` svårändrat | Regeländringar: `database.md` #16 |
| — | Kreditfakturans livscykel odefinierad | Domänmodell 9 |
| — | `RESTRICT` krockar med raderingsrätten | Regeländringar: anonymisering |
| — | Avrundningsregeln vag | Fas 3: halvt uppåt per rad, ingen öresavrundning |
| — | `user_tokens` odokumenterad, enumerering | Fas 1 |
| — | Signerade URL:er är bärartokens | Säkerhet: personnummer |
| — | CORS, headers, body limits saknas | Säkerhet: transportnära grunder |
| — | `testing.md` #11 fungerar inte för e2e | Tester: isolering |
| — | Coverage-krav saknas | Tester |
| — | `down` testas aldrig | Fas 0: CI-steg `up/down/up` |
| — | Fas 2 saknade S2S-endpoints | Fas 3 |
| — | `/health` bör delas | Säkerhet: transportnära grunder |
| — | Scope för stort | Struket: PM2/nginx-drift, CD. Portalbetalning/Stripe återinförd 2026-09-10 som fas 10 (testläge, bygger på fas 5-kedjan) |
