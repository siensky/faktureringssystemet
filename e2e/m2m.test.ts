// Fas 2 e2e: M2M-token (client_credentials), requireUser/requireService-
// separation, scope-kontroll, X-Tenant-Id-hantering (inkl. avstängd tenant),
// och BankID-mocken. Körs bara med RUN_E2E mot en uppe stack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  DB_URL,
  PNR_HMAC_KEY,
  decodeJwt,
  get,
  hmacField,
  post,
  registerVerifyLogin,
  uniq,
} from "./helpers";

const RUN = !!process.env.RUN_E2E;
const CLIENT_ID = `svc-e2e-${uniq()}`;
const CLIENT_SECRET = "e2e-client-secret-very-long-and-random-123456";
const ALLOWED = ["internal:fixture", "billing:invoice:read"];
const FIXTURE_SCOPE = "internal:fixture";

const PENDING_PNR = "000000000000";
const FAILED_PNR = "999999999999";

describe.skipIf(!RUN)("fas 2 e2e — M2M + BankID", () => {
  let sql: ReturnType<typeof postgres>;
  const createdTenantIds: number[] = [];
  let activeTenantId = 0;

  beforeAll(async () => {
    sql = postgres(DB_URL);
    const hash = await Bun.password.hash(CLIENT_SECRET, { algorithm: "argon2id" });
    await sql`
      INSERT INTO service_clients (client_id, client_secret_hash, allowed_scopes)
      VALUES (${CLIENT_ID}, ${hash}, ${ALLOWED})
    `;
    const [t] = await sql<{ id: number }[]>`
      INSERT INTO tenants (name, org_number) VALUES ('E2E aktiv', ${`55${Math.floor(1e8 + Math.random() * 8e8)}`})
      RETURNING id
    `;
    activeTenantId = t!.id;
    createdTenantIds.push(activeTenantId);
  });

  afterAll(async () => {
    await sql`DELETE FROM service_clients WHERE client_id = ${CLIENT_ID}`;
    if (createdTenantIds.length > 0) {
      await sql`DELETE FROM tenants WHERE id IN ${sql(createdTenantIds)}`;
    }
    await sql.end();
  });

  async function serviceToken(scope: string): Promise<string> {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  test("client_credentials ger ett tjänste-token", async () => {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: FIXTURE_SCOPE,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(300);
    expect(body.scope).toBe(FIXTURE_SCOPE);
    expect(decodeJwt(body.access_token as string).token_type).toBe("service");
    expect(decodeJwt(body.access_token as string).aud).toBe("internal");
  });

  test("saknat scope ger 400 (obligatoriskt)", async () => {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(res.status).toBe(400);
  });

  test("fel client_secret ger 401", async () => {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: "fel-hemlighet",
      scope: FIXTURE_SCOPE,
    });
    expect(res.status).toBe(401);
  });

  test("bara scopes i allowed_scopes beviljas", async () => {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: `${FIXTURE_SCOPE} billing:invoice:write`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe(FIXTURE_SCOPE);
  });

  test("scope som helt nekas ger 400 invalid_scope, inte tomt token", async () => {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "något:helt:otillåtet",
    });
    expect(res.status).toBe(400);
  });

  test("användar-token avvisas på requireService-endpoint (401)", async () => {
    const { accessToken } = await registerVerifyLogin(`u-${uniq()}@ex.test`);
    const res = await get("/internal/auth/tenant-echo", {
      authorization: `Bearer ${accessToken}`,
      "x-tenant-id": String(activeTenantId),
    });
    expect(res.status).toBe(401);
  });

  test("tjänste-token avvisas på requireUser-endpoint (401)", async () => {
    const token = await serviceToken(FIXTURE_SCOPE);
    const res = await get("/auth/me", { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
  });

  test("fel scope ger 403", async () => {
    const token = await serviceToken("billing:invoice:read");
    const res = await get("/internal/auth/tenant-echo", {
      authorization: `Bearer ${token}`,
      "x-tenant-id": String(activeTenantId),
    });
    expect(res.status).toBe(403);
  });

  test("X-Tenant-Id ignoreras på användar-endpoints", async () => {
    const { accessToken } = await registerVerifyLogin(`me-${uniq()}@ex.test`);
    const realTenant = decodeJwt(accessToken).tenantId as number;
    const res = await get("/auth/me", {
      authorization: `Bearer ${accessToken}`,
      "x-tenant-id": String(realTenant + 12345),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tenantId: number }).tenantId).toBe(realTenant);
  });

  test("S2S: utan X-Tenant-Id -> medvetet 400; med aktiv tenant -> data", async () => {
    const token = await serviceToken(FIXTURE_SCOPE);

    const without = await get("/internal/auth/tenant-echo", {
      authorization: `Bearer ${token}`,
    });
    expect(without.status).toBe(400);

    const withTenant = await get("/internal/auth/tenant-echo", {
      authorization: `Bearer ${token}`,
      "x-tenant-id": String(activeTenantId),
    });
    expect(withTenant.status).toBe(200);
    expect(((await withTenant.json()) as { tenantId: number }).tenantId).toBe(activeTenantId);
  });

  test("S2S: X-Tenant-Id mot avstängd eller okänd tenant -> 403", async () => {
    const token = await serviceToken(FIXTURE_SCOPE);

    const [suspended] = await sql<{ id: number }[]>`
      INSERT INTO tenants (name, org_number, status)
      VALUES ('E2E avstängd', ${`55${Math.floor(1e8 + Math.random() * 8e8)}`}, 'suspended')
      RETURNING id
    `;
    createdTenantIds.push(suspended!.id);

    const susRes = await get("/internal/auth/tenant-echo", {
      authorization: `Bearer ${token}`,
      "x-tenant-id": String(suspended!.id),
    });
    expect(susRes.status).toBe(403);

    const unknownRes = await get("/internal/auth/tenant-echo", {
      authorization: `Bearer ${token}`,
      "x-tenant-id": "2147483000",
    });
    expect(unknownRes.status).toBe(403);
  });

  describe("BankID (mock)", () => {
    test("okänt personnummer -> 200 no_company, identiteten skapas ändå men utan sessions-token", async () => {
      const pnr = "199001019999";
      const before = await sql`
        SELECT count(*)::int AS n FROM users WHERE pnr_hash = ${hmacField(pnr, PNR_HMAC_KEY)}
      `;
      const init = await post("/auth/bankid/init", { personalNumber: pnr });
      expect(init.status).toBe(200);
      const { orderRef } = (await init.json()) as { orderRef: string };

      const collect = await post("/auth/bankid/collect", { orderRef });
      expect(collect.status).toBe(200);
      const body = (await collect.json()) as { status: string; companies: unknown[] };
      expect(body.status).toBe("no_company");
      expect(body.companies).toEqual([]);
      // Inget accessToken/refreshToken i svaret — no_company utfärdar
      // uttryckligen ingen session (services/auth/src/bankid/services.ts,
      // domain.md #22).
      expect(body).not.toHaveProperty("accessToken");

      // Identiteten SKAPAS numera ändå (domain.md #22, omskriven i fas 15)
      // — bara sessions-utfärdandet krävde tidigare en matchning, inte
      // kontot självt.
      const after = await sql`
        SELECT count(*)::int AS n FROM users WHERE pnr_hash = ${hmacField(pnr, PNR_HMAC_KEY)}
      `;
      expect(after[0]!.n).toBe(before[0]!.n + 1);
    });

    test("pending-sentinel -> pending, failed-sentinel -> failed", async () => {
      const p = await post("/auth/bankid/init", { personalNumber: PENDING_PNR });
      const { orderRef: pRef } = (await p.json()) as { orderRef: string };
      expect(
        (
          (await (await post("/auth/bankid/collect", { orderRef: pRef })).json()) as {
            status: string;
          }
        ).status,
      ).toBe("pending");

      const f = await post("/auth/bankid/init", { personalNumber: FAILED_PNR });
      const { orderRef: fRef } = (await f.json()) as { orderRef: string };
      expect(
        (
          (await (await post("/auth/bankid/collect", { orderRef: fRef })).json()) as {
            status: string;
          }
        ).status,
      ).toBe("failed");
    });

    // Fas 12: BankID skapar inte längre en users-rad direkt (den gamla
    // fixturen ovan gjorde det med rå SQL i den enda-tenant-formen) —
    // collect() gör det nu SJÄLV, genom att slå upp customers.pnr_hmac hos
    // billing. Fixturen sätter därför bara in en PRIVAT kundrad (den enda
    // formen som räknas, planens Scope-beslut) och låter collect() göra
    // resten — vilket också är ett strikt bättre test: det övar den
    // riktiga mekanismen, inte en handskriven ersättning för en som inte
    // fanns.
    async function insertPrivateCustomer(
      tenantId: number,
      pnrHash: string,
      name: string,
    ): Promise<number> {
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO customers (tenant_id, customer_type, name, email, pnr_encrypted, pnr_hmac)
        VALUES (${tenantId}, 'private', ${name}, ${`${uniq()}@ex.test`}, 'e2e-placeholder-ciphertext', ${pnrHash})
        RETURNING id
      `;
      return row!.id;
    }

    async function insertTenant(name: string): Promise<number> {
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO tenants (name, org_number) VALUES (${name}, ${`55${Math.floor(1e8 + Math.random() * 8e8)}`})
        RETURNING id
      `;
      createdTenantIds.push(row!.id);
      return row!.id;
    }

    test("känt personnummer (privatkund) -> BankID skapar kundidentitet + token", async () => {
      const tenantId = await insertTenant("BankID Test");
      const pnr = `1995${Math.floor(1e7 + Math.random() * 8e7)}`;
      const customerId = await insertPrivateCustomer(
        tenantId,
        hmacField(pnr, PNR_HMAC_KEY),
        "BankID Testperson",
      );

      const init = await post("/auth/bankid/init", { personalNumber: pnr });
      const { orderRef } = (await init.json()) as { orderRef: string };
      const collect = await post("/auth/bankid/collect", { orderRef });
      expect(collect.status).toBe(200);
      const body = (await collect.json()) as {
        status: string;
        accessToken: string;
        refreshToken: string;
        companies: { tenantId: number; tenantName: string; customerId: number }[];
      };
      expect(body.status).toBe("complete");
      expect(decodeJwt(body.accessToken).role).toBe("customer");
      expect(decodeJwt(body.accessToken).tenantId).toBe(tenantId);
      // customerId måste vara med — annars avvisar verifyAccessToken tokenet
      // på nästa anrop (packages/shared/src/auth/tokens.ts).
      expect(decodeJwt(body.accessToken).customerId).toBe(customerId);
      expect(body.companies).toEqual([{ tenantId, tenantName: "BankID Test", customerId }]);

      // Regressionstest: GET /auth/me fungerar för en BankID-kundidentitet
      // (users.tenant_id är NULL på dess egen rad — se auth/repository.ts
      // findBankIdCustomerContext).
      const me = await get("/auth/me", { authorization: `Bearer ${body.accessToken}` });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as {
        companies?: { tenantId: number; tenantName: string; customerId: number }[];
      };
      expect(meBody.companies).toEqual([{ tenantId, tenantName: "BankID Test", customerId }]);

      // Kritiskt regressionstest (kodgranskning fas 12): POST /auth/refresh
      // läste tidigare users.tenant_id/customer_id rakt av — NULL för en
      // BankID-kundidentitet — och gav "Kontot är avstängt" i stället för
      // ett nytt token. refresh() ska nu läsa tenant/kund från
      // user_tokens-raden (row.tenant_id) och user_company_links, inte
      // från identitetens egen users-rad.
      const refreshed = await post("/auth/refresh", { refreshToken: body.refreshToken });
      expect(refreshed.status).toBe(200);
      const refreshedBody = (await refreshed.json()) as { accessToken: string };
      expect(decodeJwt(refreshedBody.accessToken).tenantId).toBe(tenantId);
      expect(decodeJwt(refreshedBody.accessToken).customerId).toBe(customerId);
      expect(decodeJwt(refreshedBody.accessToken).role).toBe("customer");
    });

    test("samma personnummer hos två tenants -> båda listas, byte av företag ger isolerad session", async () => {
      const tenantA = await insertTenant("BankID Test A");
      const tenantB = await insertTenant("BankID Test B");
      const pnr = `1996${Math.floor(1e7 + Math.random() * 8e7)}`;
      const pnrHash = hmacField(pnr, PNR_HMAC_KEY);
      const customerIdA = await insertPrivateCustomer(tenantA, pnrHash, "Person X hos A");
      const customerIdB = await insertPrivateCustomer(tenantB, pnrHash, "Person X hos B");

      const init = await post("/auth/bankid/init", { personalNumber: pnr });
      const { orderRef } = (await init.json()) as { orderRef: string };
      const collect = await post("/auth/bankid/collect", { orderRef });
      expect(collect.status).toBe(200);
      const body = (await collect.json()) as {
        accessToken: string;
        companies: { tenantId: number; customerId: number }[];
      };
      expect(body.companies.map((c) => c.tenantId).sort()).toEqual([tenantA, tenantB].sort());

      // GET /auth/companies/overview: en helt ny S2S-kedja (auth ->
      // billings /internal/portal/account-summary, en gång per länkat
      // företag). Båda tenants ska synas, med rätt customerId var för sig
      // — noll fakturor att vänta (inga skapade i det här testet), men
      // det bevisar att uppslaget är korrekt tenant-scopat, inte att
      // beloppen stämmer (det täcks redan av portalens egna tester).
      const overview = await get("/auth/companies/overview", {
        authorization: `Bearer ${body.accessToken}`,
      });
      expect(overview.status).toBe(200);
      const overviewBody = (await overview.json()) as {
        companies: { tenantId: number; customerId: number; outstandingInvoiceCount: number }[];
      };
      const byTenant = new Map(overviewBody.companies.map((c) => [c.tenantId, c]));
      expect(byTenant.get(tenantA)).toMatchObject({
        customerId: customerIdA,
        outstandingInvoiceCount: 0,
      });
      expect(byTenant.get(tenantB)).toMatchObject({
        customerId: customerIdB,
        outstandingInvoiceCount: 0,
      });

      // Byt till tenant B — ny session, verifierad mot user_company_links,
      // isolerad från tenant A:s kundId.
      const switched = await post(
        "/auth/companies/switch",
        { tenantId: tenantB },
        { authorization: `Bearer ${body.accessToken}` },
      );
      expect(switched.status).toBe(200);
      const switchedBody = (await switched.json()) as { accessToken: string };
      expect(decodeJwt(switchedBody.accessToken).tenantId).toBe(tenantB);
      expect(decodeJwt(switchedBody.accessToken).customerId).toBe(customerIdB);

      // Ett tenantId som INTE finns i user_company_links -> 403, aldrig
      // klientens önskemål (architecture.md #13/#17).
      const unlinked = await post(
        "/auth/companies/switch",
        { tenantId: 2147483000 },
        { authorization: `Bearer ${body.accessToken}` },
      );
      expect(unlinked.status).toBe(403);
    });

    test("kunden tas bort hos en tenant -> länken rensas bort vid nästa inloggning", async () => {
      const tenantA = await insertTenant("BankID Test C");
      const tenantB = await insertTenant("BankID Test D");
      const pnr = `1997${Math.floor(1e7 + Math.random() * 8e7)}`;
      const pnrHash = hmacField(pnr, PNR_HMAC_KEY);
      const customerIdA = await insertPrivateCustomer(tenantA, pnrHash, "Person Y hos A");
      await insertPrivateCustomer(tenantB, pnrHash, "Person Y hos B");

      // Första inloggningen: länkad till båda.
      const firstInit = await post("/auth/bankid/init", { personalNumber: pnr });
      const { orderRef: firstOrderRef } = (await firstInit.json()) as { orderRef: string };
      const first = await post("/auth/bankid/collect", { orderRef: firstOrderRef });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        accessToken: string;
        companies: { tenantId: number }[];
      };
      expect(firstBody.companies.map((c) => c.tenantId).sort()).toEqual([tenantA, tenantB].sort());

      // Kunden hos A tas bort helt (ingen faktura -> tillåtet, domain.md #21)
      // — precis "personen är inte längre kund där".
      await sql`DELETE FROM customers WHERE id = ${customerIdA}`;

      // Andra inloggningen: billing-uppslaget ger nu bara B. syncCompanyLinks
      // ska då RENSA BORT länken till A, inte bara låta den ligga kvar.
      const secondInit = await post("/auth/bankid/init", { personalNumber: pnr });
      const { orderRef: secondOrderRef } = (await secondInit.json()) as { orderRef: string };
      const second = await post("/auth/bankid/collect", { orderRef: secondOrderRef });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as {
        accessToken: string;
        companies: { tenantId: number }[];
      };
      expect(secondBody.companies.map((c) => c.tenantId)).toEqual([tenantB]);

      // Direkt mot databasen: raden i user_company_links för tenant A ska
      // vara helt borta, inte bara filtrerad bort i svaret.
      const userId = decodeJwt(secondBody.accessToken).sub as string;
      const remainingLinks = await sql<{ tenant_id: number }[]>`
        SELECT tenant_id FROM user_company_links WHERE user_id = ${Number(userId)}
      `;
      expect(remainingLinks.map((l) => l.tenant_id)).toEqual([tenantB]);

      // Byte till den borttagna tenanten A -> 403, precis som ett olänkat företag.
      const switchToRemoved = await post(
        "/auth/companies/switch",
        { tenantId: tenantA },
        { authorization: `Bearer ${secondBody.accessToken}` },
      );
      expect(switchToRemoved.status).toBe(403);
    });
  });
});
