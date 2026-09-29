# auth

Konton, sessioner, BankID och service-to-service-token. Den enda tjänsten som utfärdar JWT — alla andra tjänster bara verifierar. Se rot-[README.md](../../README.md) och [PLAN.md](../../PLAN.md) (fas 1, 2, 11, 12).

**Äger:** `tenants`, `users`, `user_tokens`, `service_clients`, `user_company_links`.

**Gör:** registrering och inloggning (e-post/lösenord eller BankID), access- och refresh-token, tjänste-token via OAuth2 `client_credentials`, BankID-igenkänning tenant-övergripande (en identitet kan vara kund hos flera företag samtidigt).

```bash
docker compose up auth
```
