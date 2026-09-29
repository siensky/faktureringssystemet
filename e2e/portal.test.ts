// Fas 9 e2e — kundportal: kundinbjudan (skapa/förnya/fullfölja/dubblett),
// rollisolering i portalen (testing.md #2 — obligatorisk), tenant- och
// kund-isolering över /portal/*, admin/kund-rollväxling (403, inte 401),
// account-summary som inte dubbelräknar en påminnelsekedja, och signerad
// PDF-URL. Körs bara med RUN_E2E mot en uppe stack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  AUTH_URL,
  BILLING_URL,
  DB_URL,
  decodeJwt,
  get,
  getTo,
  post,
  postTo,
  putTo,
  registerVerifyLogin,
  uniq,
  until,
  validBankgiro,
  validOrgNumber,
} from "./helpers";

const RUN = !!process.env.RUN_E2E;

const ONE_LINE = [
  { description: "Konsulttimmar", quantity: 1, unitPriceOre: 100_000, vatRate: 25 },
];
const CUSTOMER_PASSWORD = "kundens-egna-losenord-9999";

const OPS_CLIENT_ID = `svc-billing-ops-portal-e2e-${uniq()}`;
const OPS_CLIENT_SECRET = "billing-portal-e2e-ops-secret-long-random-0123456789";

interface Session {
  token: string;
  tenantId: number;
}
const auth = (s: Session) => ({ authorization: `Bearer ${s.token}` });
const idem = (s: Session) => ({ ...auth(s), "idempotency-key": `idem-${uniq()}-${uniq()}` });

describe.skipIf(!RUN)("fas 9 e2e — kundportal", () => {
  let sql: ReturnType<typeof postgres>;
  const tenantIds: number[] = [];

  async function newAdmin(prefix = "portal"): Promise<Session> {
    const { accessToken } = await registerVerifyLogin(`${prefix}-${uniq()}@ex.test`);
    const tenantId = decodeJwt(accessToken).tenantId as number;
    tenantIds.push(tenantId);
    return { token: accessToken, tenantId };
  }

  async function fillCompanySettings(s: Session): Promise<void> {
    const res = await putTo(
      BILLING_URL,
      "/admin/company-settings",
      { companyName: `Bolag ${uniq()}`, orgNumber: validOrgNumber(), bankgiro: validBankgiro() },
      auth(s),
    );
    if (res.status !== 200) throw new Error(`company-settings: ${res.status}`);
  }

  async function makeCustomer(s: Session, email = `${uniq()}@ex.test`): Promise<number> {
    const res = await postTo(
      BILLING_URL,
      "/admin/customers",
      {
        customerType: "company",
        name: `Kund ${uniq()}`,
        email,
        orgNumber: validOrgNumber(),
        addressStreet: "Vägen 1",
        addressZip: "11122",
        addressCity: "Stockholm",
      },
      idem(s),
    );
    if (res.status !== 201) throw new Error(`makeCustomer: ${res.status}`);
    return ((await res.json()) as { id: number }).id;
  }

  async function createDraft(s: Session, customerId: number): Promise<number> {
    const res = await postTo(
      BILLING_URL,
      "/admin/invoices",
      { customerId, lines: ONE_LINE },
      idem(s),
    );
    if (res.status !== 201) throw new Error(`createDraft: ${res.status}`);
    return ((await res.json()) as { id: number }).id;
  }

  async function sentInvoice(s: Session, customerId: number): Promise<number> {
    const id = await createDraft(s, customerId);
    const res = await postTo(BILLING_URL, `/admin/invoices/${id}/send`, {}, idem(s));
    if (res.status !== 200) throw new Error(`send: ${res.status}`);
    return id;
  }

  /** Admin bjuder in kunden, hämtar länken via dev-endpointen (fas 9 följer
   *  samma dev-only-mönster som email_verification/password_reset — se
   *  services/auth/src/auth/controllers.ts:devToken) och fullföljer den. */
  async function inviteAndAccept(
    admin: Session,
    customerId: number,
    email: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const invite = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email },
      auth(admin),
    );
    if (invite.status !== 201) throw new Error(`customer-invites: ${invite.status}`);

    const tokenRes = await get(
      `/auth/dev/token?email=${encodeURIComponent(email)}&type=customer_invite`,
    );
    if (tokenRes.status !== 200) throw new Error(`dev/token: ${tokenRes.status}`);
    const { token } = (await tokenRes.json()) as { token: string };

    const accept = await post("/auth/accept-customer-invite", {
      token,
      password: CUSTOMER_PASSWORD,
    });
    if (accept.status !== 200) throw new Error(`accept-customer-invite: ${accept.status}`);

    const login = await post("/auth/login", { email, password: CUSTOMER_PASSWORD });
    if (login.status !== 200) throw new Error(`customer login: ${login.status}`);
    return (await login.json()) as { accessToken: string; refreshToken: string };
  }

  async function opsToken(): Promise<string> {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: OPS_CLIENT_ID,
      client_secret: OPS_CLIENT_SECRET,
      scope: "billing:ops:run",
    });
    if (res.status !== 200) throw new Error(`opsToken: ${res.status}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL);
    const opsHash = await Bun.password.hash(OPS_CLIENT_SECRET, { algorithm: "argon2id" });
    await sql`
      INSERT INTO service_clients (client_id, client_secret_hash, allowed_scopes)
      VALUES (${OPS_CLIENT_ID}, ${opsHash}, ${["billing:ops:run"]})
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM service_clients WHERE client_id = ${OPS_CLIENT_ID}`;
    if (tenantIds.length > 0) {
      await sql`DELETE FROM invoice_payments WHERE tenant_id IN ${sql(tenantIds)}`;
      await sql`DELETE FROM event_outbox WHERE tenant_id IN ${sql(tenantIds)}`;
      await sql`DELETE FROM tenants WHERE id IN ${sql(tenantIds)}`;
    }
    await sql.end();
  });

  test("kundinbjudan: skapa -> acceptera -> logga in ger role=customer + customerId; dubblett efter fullföljd ger 409", async () => {
    const admin = await newAdmin("inv");
    const email = `kund-${uniq()}@ex.test`;
    const customerId = await makeCustomer(admin, email);

    const tokens = await inviteAndAccept(admin, customerId, email);
    const claims = decodeJwt(tokens.accessToken);
    expect(claims.role).toBe("customer");
    expect(claims.tenantId).toBe(admin.tenantId);
    expect(claims.customerId).toBe(customerId);

    const me = await get("/auth/me", { authorization: `Bearer ${tokens.accessToken}` });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      role: string;
      customerId: number | null;
      customerName: string | null;
    };
    expect(meBody.role).toBe("customer");
    expect(meBody.customerId).toBe(customerId);
    // auth hämtar namnet från billings kundregister (S2S) — inte bara
    // vidarebefordrar ett null-fält. tenantName är FÖRETAGET; customerName
    // är personen/företaget som är inloggad, och de ska aldrig blandas ihop.
    const customerRes = await getTo(BILLING_URL, `/admin/customers/${customerId}`, auth(admin));
    const { name: expectedName } = (await customerRes.json()) as { name: string };
    expect(meBody.customerName).toBe(expectedName);

    const again = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email },
      auth(admin),
    );
    expect(again.status).toBe(409);
  });

  test("kundinbjudan: annan tenants customerId hittas inte (404), obehörig admin (customer-token) nekas 403", async () => {
    const adminA = await newAdmin("invA");
    const adminB = await newAdmin("invB");
    const customerOfB = await makeCustomer(adminB);

    const cross = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId: customerOfB, email: `${uniq()}@ex.test` },
      auth(adminA),
    );
    expect(cross.status).toBe(404);

    const customerOfA = await makeCustomer(adminA);
    const emailA = `kund-${uniq()}@ex.test`;
    const customerTokens = await inviteAndAccept(adminA, customerOfA, emailA);
    const asCustomer = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId: customerOfA, email: `${uniq()}@ex.test` },
      { authorization: `Bearer ${customerTokens.accessToken}` },
    );
    expect(asCustomer.status).toBe(403);
  });

  test("förnyad inbjudan innan fullföljd: gammal länk dör, ny fungerar", async () => {
    const admin = await newAdmin("renew");
    const email = `kund-${uniq()}@ex.test`;
    const customerId = await makeCustomer(admin, email);

    const first = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email },
      auth(admin),
    );
    expect(first.status).toBe(201);
    const firstTokenRes = await get(
      `/auth/dev/token?email=${encodeURIComponent(email)}&type=customer_invite`,
    );
    const { token: firstToken } = (await firstTokenRes.json()) as { token: string };

    const second = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email },
      auth(admin),
    );
    expect(second.status).toBe(201);

    // Den GAMLA länken (från innan förnyelsen) är nu återkallad.
    const acceptOld = await post("/auth/accept-customer-invite", {
      token: firstToken,
      password: CUSTOMER_PASSWORD,
    });
    expect(acceptOld.status).toBe(400);

    const tokens = await inviteAndAccept(admin, customerId, email);
    expect(decodeJwt(tokens.accessToken).role).toBe("customer");
  });

  test("förnyad inbjudan med RÄTTAD e-post: länken går till den nya adressen, den gamla slutar fungera", async () => {
    const admin = await newAdmin("renewEmail");
    const wrongEmail = `fel-${uniq()}@ex.test`;
    const customerId = await makeCustomer(admin, wrongEmail);

    const first = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email: wrongEmail },
      auth(admin),
    );
    expect(first.status).toBe(201);

    // Admin upptäcker felstavningen och bjuder in på nytt med RÄTT adress,
    // innan kunden hunnit fullfölja den första (kodgranskning fas 9, fynd 4).
    const correctEmail = `ratt-${uniq()}@ex.test`;
    const second = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email: correctEmail },
      auth(admin),
    );
    expect(second.status).toBe(201);

    // Den nya länken hämtas på den NYA adressen.
    const tokenRes = await get(
      `/auth/dev/token?email=${encodeURIComponent(correctEmail)}&type=customer_invite`,
    );
    expect(tokenRes.status).toBe(200);
    const { token } = (await tokenRes.json()) as { token: string };
    const accept = await post("/auth/accept-customer-invite", {
      token,
      password: CUSTOMER_PASSWORD,
    });
    expect(accept.status).toBe(200);

    // Inloggning på den GAMLA (felstavade) adressen fungerar inte längre —
    // raden pekar nu på den rätta.
    const loginOld = await post("/auth/login", {
      email: wrongEmail,
      password: CUSTOMER_PASSWORD,
    });
    expect(loginOld.status).toBe(401);
    const loginNew = await post("/auth/login", {
      email: correctEmail,
      password: CUSTOMER_PASSWORD,
    });
    expect(loginNew.status).toBe(200);
  });

  test("kundinbjudan: kolliderande e-post (globalt unik över users) ger 409, inte 500", async () => {
    // users_email_unique (0002_auth.js) är global — en NY inbjudan på en
    // e-post som redan tillhör ett annat konto (här: en admin i en annan
    // tenant) ska ge ett tydligt fel, inte en unique-violation som läcker
    // upp som 500 (kodgranskning fas 9, fynd 3).
    const takenEmail = `upptagen-${uniq()}@ex.test`;
    const adminWithTakenEmail = await registerVerifyLogin(takenEmail);
    tenantIds.push(decodeJwt(adminWithTakenEmail.accessToken).tenantId as number);
    expect(decodeJwt(adminWithTakenEmail.accessToken).role).toBe("admin");

    const invitingAdmin = await newAdmin("collisionInviter");
    const customerId = await makeCustomer(invitingAdmin);

    const invite = await postTo(
      AUTH_URL,
      "/auth/customer-invites",
      { customerId, email: takenEmail },
      auth(invitingAdmin),
    );
    expect(invite.status).toBe(409);
  });

  test("rollisolering i portalen: kund ser bara egna, ej draft, ej en annan kunds — 404 över kund- och tenant-gränsen", async () => {
    const admin = await newAdmin("iso");
    await fillCompanySettings(admin);
    const emailC1 = `c1-${uniq()}@ex.test`;
    const c1 = await makeCustomer(admin, emailC1);
    const c2 = await makeCustomer(admin, `c2-${uniq()}@ex.test`);

    const c1SentId = await sentInvoice(admin, c1);
    await createDraft(admin, c1); // ska ALDRIG synas i portalen
    const c2SentId = await sentInvoice(admin, c2);

    const otherAdmin = await newAdmin("isoOther");
    await fillCompanySettings(otherAdmin);
    const otherCustomerId = await makeCustomer(otherAdmin);
    const otherSentId = await sentInvoice(otherAdmin, otherCustomerId);

    const c1Tokens = await inviteAndAccept(admin, c1, emailC1);
    const cAuth = { authorization: `Bearer ${c1Tokens.accessToken}` };

    const list = await getTo(BILLING_URL, "/portal/invoices", cAuth);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { id: number; status: string }[];
    const ids = listBody.map((i) => i.id);
    expect(ids).toContain(c1SentId);
    expect(ids).not.toContain(c2SentId);
    expect(listBody.every((i) => i.status !== "draft")).toBe(true);

    expect((await getTo(BILLING_URL, `/portal/invoices/${c1SentId}`, cAuth)).status).toBe(200);
    // Kundens EGET utkast — status != 'draft' filtreras bort, 404 inte 403.
    expect((await getTo(BILLING_URL, `/portal/invoices/${c2SentId}`, cAuth)).status).toBe(404);
    expect((await getTo(BILLING_URL, `/portal/invoices/${otherSentId}`, cAuth)).status).toBe(404);

    // Rollväxling: en kund på /admin/*, en admin på /portal/* — 403 (rätt
    // identifierad, fel roll), aldrig 401.
    expect((await getTo(BILLING_URL, "/admin/invoices", cAuth)).status).toBe(403);
    expect((await getTo(BILLING_URL, "/portal/invoices", auth(admin))).status).toBe(403);
    expect((await getTo(BILLING_URL, "/portal/invoices", {})).status).toBe(401);
  });

  test("account-summary: status IN (sent,overdue) — en påminnelsekedja räknas exakt en gång", async () => {
    const admin = await newAdmin("sum");
    await fillCompanySettings(admin);
    const email = `kund-${uniq()}@ex.test`;
    const customerId = await makeCustomer(admin, email);

    const untouchedId = await sentInvoice(admin, customerId);
    const originalId = await sentInvoice(admin, customerId);
    await sql`UPDATE invoices SET date_due = (CURRENT_DATE - 10) WHERE id = ${originalId}`;

    const token = await opsToken();
    const run = await fetch(`${BILLING_URL}/internal/automation/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(run.status).toBe(200);

    const [original] = await sql<{ status: string; superseded_by_invoice_id: number | null }[]>`
      SELECT status, superseded_by_invoice_id FROM invoices WHERE id = ${originalId}
    `;
    expect(original!.status).toBe("superseded");
    const reminderId = original!.superseded_by_invoice_id!;

    const tokens = await inviteAndAccept(admin, customerId, email);
    const cAuth = { authorization: `Bearer ${tokens.accessToken}` };
    const summaryRes = await getTo(BILLING_URL, "/portal/account-summary", cAuth);
    expect(summaryRes.status).toBe(200);
    const summary = (await summaryRes.json()) as {
      outstanding: number;
      outstandingInvoiceCount: number;
    };

    // Precis två utestående poster: den orörda fakturan och PÅMINNELSEN —
    // ALDRIG originalet (superseded), annars vore skulden dubbelräknad.
    expect(summary.outstandingInvoiceCount).toBe(2);
    const [{ sum }] = await sql<{ sum: string }[]>`
      SELECT COALESCE(SUM(total_incl_vat_ore), 0)::bigint AS sum FROM invoices
      WHERE id IN ${sql([untouchedId, reminderId])}
    `;
    // Kronor, inte öre (kodgranskning fas 9, fynd 7).
    expect(summary.outstanding).toBe(Number(sum) / 100);
  });

  test("PDF: signerad URL för egen faktura, 404 för annan kunds", async () => {
    const admin = await newAdmin("pdf");
    await fillCompanySettings(admin);
    const email = `kund-${uniq()}@ex.test`;
    const customerId = await makeCustomer(admin, email);
    const otherCustomerId = await makeCustomer(admin);

    const id = await sentInvoice(admin, customerId);
    const otherId = await sentInvoice(admin, otherCustomerId);

    // documents konsumerar invoice.sent asynkront — vänta tills PDF+mejl
    // faktiskt landat (samma mönster som e2e/documents.test.ts).
    await until(
      async () => {
        const inv = await getTo(BILLING_URL, `/admin/invoices/${id}`, auth(admin));
        const body = (await inv.json()) as { deliveryStatus: string };
        return body.deliveryStatus === "sent" ? true : undefined;
      },
      { timeoutMs: 45000 },
    );

    const tokens = await inviteAndAccept(admin, customerId, email);
    const cAuth = { authorization: `Bearer ${tokens.accessToken}` };

    const pdfRes = await getTo(BILLING_URL, `/portal/invoices/${id}/pdf`, cAuth);
    expect(pdfRes.status).toBe(200);
    const { url, expiresAt } = (await pdfRes.json()) as { url: string; expiresAt: string };
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const pdf = await fetch(url);
    expect(pdf.status).toBe(200);
    const head = new Uint8Array(await pdf.arrayBuffer()).slice(0, 5);
    expect(Buffer.from(head).toString("latin1")).toBe("%PDF-");

    expect((await getTo(BILLING_URL, `/portal/invoices/${otherId}/pdf`, cAuth)).status).toBe(404);
  });
});
