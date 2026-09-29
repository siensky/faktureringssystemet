# Testregler

Tester skrivs **under** utvecklingen, inte efter. En fas är inte klar förrän dess tester finns.

## Vad som testas hur

**Enhetstester** — ren logik utan databas eller nätverk. Snabba, många.

- OCR-generering och validering (Luhn mod-10)
- Momsberäkning, summering och avrundning
- Matchningslogik för betalningar
- Urvalslogik i cronjobb, med manipulerad klocka
- Token-generering, hashning, utgångstider

**E2e-tester** — riktig Postgres och RabbitMQ via Testcontainers. Färre, långsammare, men de enda som bevisar att tjänsterna faktiskt hänger ihop.

- Hela flöden genom API:et
- Eventkedjor mellan tjänster
- Allt som rör åtkomstkontroll

**Testa inte** getters, mappers utan logik, eller att ett ramverk gör sitt jobb. Ett test som aldrig kan gå sönder är underhåll utan värde.

## Tester som alltid måste finnas

1. **Tenant-isolering per skyddad endpoint.** Logga in som företag A, försök läsa företag B:s resurs, förvänta `404`. Sviten växer med varje ny endpoint.
2. **Rollisolering i kundportalen.** En kund får inte se en annan kunds faktura hos samma företag.
3. **Tokenförväxling.** Ett användar-token avvisas på `requireService()`-endpoints och tvärtom. Fel scope ger `403`, inget token ger `401`.
4. **`X-Tenant-Id` ignoreras** på användar-endpoints även när den skickas med.
5. **Idempotens.** Kör samma event, samma filimport och samma `Idempotency-Key` två gånger — resultatet ska vara identiskt med en körning.
6. **Samtidighet på fakturanummer.** Skapa fakturor parallellt, verifiera obruten serie utan dubbletter.
7. **Oföränderlighet.** `PUT` och `DELETE` mot en skickad faktura ger `409`.

## Hur tester skrivs

8. **Ett test bevisar en sak.** Går det sönder ska namnet räcka för att veta vad som gick fel.
9. **Namnge efter beteende, inte metod:** `returnerar 404 när fakturan tillhör annan tenant`, inte `test getInvoice`.
10. **Inga beroenden mellan tester.** Varje test sätter upp sin egen data och kan köras ensamt.
11. **Delad databas är okej — delad data är det inte.** Vad "isolerad" betyder skiljer sig åt beroende på testnivå:
    - **Integrationstester i samma process** (ett repository-test som pratar med riktig Postgres): egen transaktion som rullas tillbaka i slutet.
    - **E2e-tester över HTTP och RabbitMQ**: en transaktionsrollback räcker INTE — flera anslutningar (klienten, tjänsten, en eventuell konsument) ser inte varandras öppna transaktion. I praktiken delar alla e2e-tester en och samma databas (`e2e/helpers.ts`) och isoleras i stället genom att **aldrig dela data**: varje test skapar sin egen tenant med slumpade identifierare (`uniq()`), så två tester kan aldrig råka peka på samma rader oavsett körordning. Ett eget schema per test eller en egen Testcontainers-container hade också fungerat, men är inte vad koden faktiskt gör — den här regeln beskriver den vägen, inte den andra.
12. **Mocka bara det du inte äger** — BankID, e-postleverantör, betalleverantör. Mocka aldrig din egen databas; då testar du din mock.
13. **Testa gränsfallen, inte bara det lyckade fallet.** Noll rader, negativa belopp, saknad tenant, dubblettevent, utgången token.
14. **Coverage-krav: ≥ 90 % på ren affärslogik** (`services/**/services/**` i TS, motsvarande i Python) — inte en global siffra, som bara belönar tester på getters och mappers.

## Definition of Done

En fas är klar när **allt** stämmer:

- [ ] Enhetstester för all ren logik i fasen
- [ ] E2e-test för fasens huvudflöde
- [ ] Isoleringstest för varje ny skyddad endpoint
- [ ] Migrationens `down` är testad (`migrate up → down → up`), inte bara skriven — database.md #3
- [ ] Inga `.only`, `.skip` eller utkommenterade tester
- [ ] `bun test` och `pytest` gröna lokalt
- [ ] CI grön
- [ ] Reglerna i `architecture.md`, `database.md` och `domain.md` följda
