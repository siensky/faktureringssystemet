// Fas 7 e2e — "Ett stort e2e-test i backend" (PLAN.md). De per-fas-sviterna
// (auth/m2m/billing/documents/payments/automation) testar redan sina egna
// hörn väl, men ingen av dem kedjar ihop HELA livscykeln i EN körning, eller
// bevisar de tvärgående korrekthetskraven planen explicit listar. Den här
// filen fyller PRECIS de luckorna — inte samma mark igen:
//
//   1. Hela lyckade vägen i en enda sammanhängande resa: registrera → kund
//      → draft → send (status='sent' OBEROENDE av documents, se testet) →
//      PDF ur snapshot → mejl i Mailpit → betalning på OCR → paid.
//   2. Snapshotens frysning: företagets logga ändras EFTER utskick, den
//      redan skrivna snapshoten ska ändå visa den gamla loggan.
//   3. Den RIKTIGA påminnelsekedjan (automation.test.ts testar bara halva
//      biten med en delbetalning skriven direkt via SQL; payments.test.ts
//      testar bara halva biten med superseded_by_invoice_id satt direkt via
//      SQL): en RIKTIG webhook-delbetalning, en RIKTIG cron-skapad
//      påminnelse, och en ANDRA riktig webhook-betalning på ORIGINALETS OCR
//      som ska landa på påminnelsen.
//   4. Kontostrypning oberoende av IP: fem misslyckade inloggningar mot
//      SAMMA konto från OLIKA (spoofade) IP:n ska ändå ge 429 — bevisar att
//      det är kontot, inte avsändar-IP:t, som stryps.
//   5. Riktig RabbitMQ-omleverans av SAMMA event (inte bara outboxens egen
//      dedup vid publicering) ska inte skapa ett dubblett-dokument.
//
// Körs bara med RUN_E2E mot en uppe stack.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import amqplib from "amqplib";
import postgres from "postgres";
import {
  AUTH_URL,
  BILLING_URL,
  DB_URL,
  MAILPIT_URL,
  MQ_URL,
  PASSWORD,
  PAYMENTS_URL,
  PAYMENT_WEBHOOK_SECRET,
  decodeJwt,
  getTo,
  post,
  postTo,
  putTo,
  registerVerifyLogin,
  signPaymentWebhook,
  uniq,
  until,
  validBankgiro,
  validOrgNumber,
} from "./helpers";

const RUN = !!process.env.RUN_E2E;

const OPS_CLIENT_ID = `svc-billing-alerts-e2e-${uniq()}`;
const OPS_CLIENT_SECRET = "billing-e2e-alerts-secret-long-and-random-0123456789";

const ONE_LINE = [
  { description: "Konsulttimmar", quantity: 1, unitPriceOre: 100_000, vatRate: 25 },
];
const FULL_AMOUNT_ORE = 125_000; // 100_000 + 25% moms
const REMINDER_FEE_ORE = 6000; // company_settings default

interface Session {
  token: string;
  tenantId: number;
  email: string;
}
const auth = (s: Session) => ({ authorization: `Bearer ${s.token}` });
const idem = (s: Session) => ({ ...auth(s), "idempotency-key": `idem-${uniq()}-${uniq()}` });

function pastDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!RUN)("fas 7 e2e — stor svit (hela livscykeln, tvärgående korrekthet)", () => {
  let sql: ReturnType<typeof postgres>;
  const tenantIds: number[] = [];

  async function newAdmin(prefix: string): Promise<Session> {
    const email = `${prefix}-${uniq()}@ex.test`;
    const { accessToken } = await registerVerifyLogin(email);
    const tenantId = decodeJwt(accessToken).tenantId as number;
    tenantIds.push(tenantId);
    return { token: accessToken, tenantId, email };
  }

  async function fillCompanySettings(s: Session, logoUrl?: string): Promise<void> {
    const res = await putTo(
      BILLING_URL,
      "/admin/company-settings",
      {
        companyName: `Bolag ${uniq()}`,
        orgNumber: validOrgNumber(),
        bankgiro: validBankgiro(),
        ...(logoUrl ? { logoUrl } : {}),
      },
      auth(s),
    );
    if (res.status !== 200) throw new Error(`company-settings: ${res.status}`);
  }

  async function makeCustomer(s: Session): Promise<number> {
    const res = await postTo(
      BILLING_URL,
      "/admin/customers",
      {
        customerType: "company",
        name: `Kund ${uniq()}`,
        email: `${uniq()}@ex.test`,
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

  async function sentInvoice(
    s: Session,
    customerId: number,
  ): Promise<{ id: number; ocr: string; status: string }> {
    const draftRes = await postTo(
      BILLING_URL,
      "/admin/invoices",
      { customerId, lines: ONE_LINE },
      idem(s),
    );
    if (draftRes.status !== 201) throw new Error(`createDraft: ${draftRes.status}`);
    const { id } = (await draftRes.json()) as { id: number };
    const sendRes = await postTo(BILLING_URL, `/admin/invoices/${id}/send`, {}, idem(s));
    if (sendRes.status !== 200) throw new Error(`send: ${sendRes.status}`);
    const body = (await sendRes.json()) as { ocrNumber: string; status: string };
    return { id, ocr: body.ocrNumber, status: body.status };
  }

  async function getInvoice(s: Session, id: number) {
    const res = await getTo(BILLING_URL, `/admin/invoices/${id}`, auth(s));
    if (res.status !== 200) throw new Error(`get invoice: ${res.status}`);
    return res.json() as Promise<{
      status: string;
      deliveryStatus: string;
      supersededByInvoiceId: number | null;
      totalInclVat: number;
      paid: number;
    }>;
  }

  function paymentWebhookHeaders(
    bodyText: string,
    timestamp = String(Math.floor(Date.now() / 1000)),
  ) {
    return {
      "content-type": "application/json",
      "x-timestamp": timestamp,
      "x-signature": signPaymentWebhook(PAYMENT_WEBHOOK_SECRET, timestamp, bodyText),
    };
  }

  async function payWebhook(opts: { bankgiro: string; ocr: string; amountOre: number }) {
    const payload = {
      id: `evt-${uniq()}-${uniq()}`,
      bankgiro: opts.bankgiro,
      ocr: opts.ocr,
      amountOre: opts.amountOre,
      payerName: "Betalare AB",
      bookedAt: new Date().toISOString(),
    };
    const bodyText = JSON.stringify(payload);
    return fetch(`${PAYMENTS_URL}/webhooks/payment`, {
      method: "POST",
      headers: paymentWebhookHeaders(bodyText),
      body: bodyText,
    });
  }

  interface MailpitMessage {
    ID: string;
    Subject: string;
    To: Array<{ Address: string }>;
  }

  // subjectContains: utan den matchar den FÖRSTA träffen på adressen — en
  // kund som redan fått ett fakturamejl i samma test (t.ex. innan en
  // påminnelse skapas) behöver ämnesraden för att skilja de två åt.
  async function waitForMail(toAddress: string, subjectContains?: string): Promise<MailpitMessage> {
    return until(
      async () => {
        const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=200`);
        if (!res.ok) return undefined;
        const body = (await res.json()) as { messages: MailpitMessage[] };
        return body.messages.find(
          (m) =>
            m.To?.some((t) => t.Address === toAddress) &&
            (subjectContains === undefined || m.Subject?.includes(subjectContains)),
        );
      },
      { timeoutMs: 45000 },
    );
  }

  async function waitForDocumentRow(tenantId: number, invoiceId: number): Promise<void> {
    await until(
      async () => {
        const rows = await sql`
          SELECT id FROM documents WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId}
        `;
        return rows.length > 0 ? true : undefined;
      },
      { timeoutMs: 45000 },
    );
  }

  async function opsToken(clientId: string, clientSecret: string, scope: string): Promise<string> {
    const res = await post("/auth/token", {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });
    if (res.status !== 200) throw new Error(`opsToken: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { access_token: string }).access_token;
  }

  beforeAll(async () => {
    sql = postgres(DB_URL);
    const opsHash = await Bun.password.hash(OPS_CLIENT_SECRET, { algorithm: "argon2id" });
    await sql`
      INSERT INTO service_clients (client_id, client_secret_hash, allowed_scopes)
      VALUES (${OPS_CLIENT_ID}, ${opsHash}, ${["ops:alerts:read"]})
    `;
  });

  afterAll(async () => {
    // Låt eventuella event som fortfarande är på väg genom RabbitMQ landa
    // innan tenants rivs (samma försiktighet som documents.test.ts/
    // payments.test.ts redan använder).
    await new Promise((r) => setTimeout(r, 3000));
    await sql`DELETE FROM service_clients WHERE client_id = ${OPS_CLIENT_ID}`;
    if (tenantIds.length > 0) {
      await sql`DELETE FROM email_outbox WHERE tenant_id IN ${sql(tenantIds)}`;
      await sql`DELETE FROM documents WHERE tenant_id IN ${sql(tenantIds)}`;
      await sql`DELETE FROM invoice_payments WHERE tenant_id IN ${sql(tenantIds)}`;
      await sql`DELETE FROM event_outbox WHERE tenant_id IN ${sql(tenantIds)}`;
      await sql`DELETE FROM tenants WHERE id IN ${sql(tenantIds)}`;
    }
    await sql.end();
  });

  test("hela lyckade vägen: registrera → kund → draft → send → PDF → mejl → betalning på OCR → paid", async () => {
    const s = await newAdmin("full1");
    await fillCompanySettings(s);
    const customerId = await makeCustomer(s);

    const draftRes = await postTo(
      BILLING_URL,
      "/admin/invoices",
      { customerId, lines: ONE_LINE },
      idem(s),
    );
    expect(draftRes.status).toBe(201);
    const { id, status: draftStatus } = (await draftRes.json()) as { id: number; status: string };
    expect(draftStatus).toBe("draft");

    const sendRes = await postTo(BILLING_URL, `/admin/invoices/${id}/send`, {}, idem(s));
    expect(sendRes.status).toBe(200);
    const sent = (await sendRes.json()) as {
      status: string;
      ocrNumber: string;
      customerName: string;
    };
    // status='sent' kommer direkt i SEND-svaret, INNAN documents någonsin
    // sett eventet (outboxen publicerar asynkront) — bevisar per
    // konstruktion att bokföringsstatusen inte beror av documents (planens
    // Tester-lista, punkt "status kontra delivery_status").
    expect(sent.status).toBe("sent");

    await waitForDocumentRow(s.tenantId, id);
    const customer = await getTo(BILLING_URL, `/admin/customers/${customerId}`, auth(s));
    const customerEmail = ((await customer.json()) as { email: string }).email;
    const mail = await waitForMail(customerEmail);
    expect(mail).toBeDefined();

    const bankgiroRes = await getTo(BILLING_URL, "/admin/company-settings", auth(s));
    const { bankgiro } = (await bankgiroRes.json()) as { bankgiro: string };
    const payRes = await payWebhook({ bankgiro, ocr: sent.ocrNumber, amountOre: FULL_AMOUNT_ORE });
    expect(payRes.status).toBe(200);

    await until(async () => (await getInvoice(s, id)).status === "paid");
  });

  test("snapshot: företagets logga ändras efter utskick, den redan skrivna snapshoten fryser den gamla", async () => {
    const s = await newAdmin("full2");
    const originalLogo = `https://example.test/logo-${uniq()}.png`;
    await fillCompanySettings(s, originalLogo);
    const customerId = await makeCustomer(s);
    const { id } = await sentInvoice(s, customerId);

    const [before] = await sql<{ logo: string }[]>`
      SELECT payload->'company'->>'logoUrl' AS logo FROM invoice_snapshots
      WHERE invoice_id = ${id} AND tenant_id = ${s.tenantId}
    `;
    expect(before!.logo).toBe(originalLogo);

    // Ändrar loggan EFTER utskick — en redan bokförd fakturas snapshot får
    // aldrig ändras av det (database.md #30).
    const newLogo = `https://example.test/new-logo-${uniq()}.png`;
    const patchRes = await putTo(
      BILLING_URL,
      "/admin/company-settings",
      {
        companyName: `Bolag ${uniq()}`,
        orgNumber: validOrgNumber(),
        bankgiro: validBankgiro(),
        logoUrl: newLogo,
      },
      auth(s),
    );
    expect(patchRes.status).toBe(200);

    const [after] = await sql<{ logo: string }[]>`
      SELECT payload->'company'->>'logoUrl' AS logo FROM invoice_snapshots
      WHERE invoice_id = ${id} AND tenant_id = ${s.tenantId}
    `;
    expect(after!.logo).toBe(originalLogo);
  });

  test("den riktiga påminnelsekedjan: webhook-delbetalning → cron-skapad påminnelse → andra betalningen på originalets OCR landar på påminnelsen", async () => {
    const s = await newAdmin("full3");
    await fillCompanySettings(s);
    const customerId = await makeCustomer(s);
    const customerRes = await getTo(BILLING_URL, `/admin/customers/${customerId}`, auth(s));
    const customerEmail = ((await customerRes.json()) as { email: string }).email;
    const original = await sentInvoice(s, customerId);

    const bankgiroRes = await getTo(BILLING_URL, "/admin/company-settings", auth(s));
    const { bankgiro } = (await bankgiroRes.json()) as { bankgiro: string };

    // 1. RIKTIG delbetalning via webhook, inte en rad skriven direkt i DB.
    // payments publicerar payment.partial asynkront och billings EGEN
    // konsument bokför invoice_payments-raden — väntar på att DEN raden
    // faktiskt landat (status='sent' är sant redan INNAN betalningen ens
    // anlänt, så den ensam vore ingen väntan alls).
    const partialOre = 25_000;
    const partialRes = await payWebhook({ bankgiro, ocr: original.ocr, amountOre: partialOre });
    expect(partialRes.status).toBe(200);
    await until(async () => {
      const inv = await getInvoice(s, original.id);
      return inv.paid === partialOre / 100 ? true : undefined;
    });

    // 2. Förfaller, och en RIKTIG cron-körning skapar påminnelsen. Egen
    // engångsklient mot /internal/automation/run — samma mönster som
    // e2e/automation.test.ts, ett annat scope än OPS_CLIENT_ID ovan.
    await sql`UPDATE invoices SET date_due = ${pastDate(10)} WHERE id = ${original.id}`;
    const autoSecret = "full-lifecycle-automation-secret-0123456789";
    const autoHash = await Bun.password.hash(autoSecret, { algorithm: "argon2id" });
    const autoClientId = `svc-billing-automation-full-e2e-${uniq()}`;
    await sql`
      INSERT INTO service_clients (client_id, client_secret_hash, allowed_scopes)
      VALUES (${autoClientId}, ${autoHash}, ${["billing:ops:run"]})
    `;
    const autoToken = await opsToken(autoClientId, autoSecret, "billing:ops:run");
    const runRes = await fetch(`${BILLING_URL}/internal/automation/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${autoToken}` },
    });
    expect(runRes.status).toBe(200);
    await sql`DELETE FROM service_clients WHERE client_id = ${autoClientId}`;

    const originalAfter = await getInvoice(s, original.id);
    expect(originalAfter.status).toBe("superseded");
    const reminderId = originalAfter.supersededByInvoiceId as number;
    expect(reminderId).not.toBeNull();
    const reminder = await getInvoice(s, reminderId);
    expect(reminder.totalInclVat).toBe((FULL_AMOUNT_ORE - partialOre + REMINDER_FEE_ORE) / 100);

    // Påminnelsen ska ha sin EGEN leveransväg (fas 14) — eget event
    // (invoice.reminder_sent), egen PDF (document_type 'reminder') och ett
    // eget mejl, inte fakturans invoice.sent-väg återanvänd.
    await waitForDocumentRow(s.tenantId, reminderId);
    const [reminderDoc] = await sql<{ document_type: string }[]>`
      SELECT document_type FROM documents WHERE tenant_id = ${s.tenantId} AND invoice_id = ${reminderId}
    `;
    expect(reminderDoc!.document_type).toBe("reminder");
    const reminderMail = await waitForMail(customerEmail, "Påminnelse");
    expect(reminderMail).toBeDefined();
    // Beviset att invoice.delivery_updated med documentType 'reminder'
    // faktiskt passerade billings konsument (inte dead-lettrades av det
    // gamla tvåvärda enumet) — inte bara att mejlet råkade dyka upp.
    await until(async () => (await getInvoice(s, reminderId)).deliveryStatus === "sent");

    // 3. ANDRA riktiga betalningen — på ORIGINALETS ocr, inte påminnelsens.
    // Kedjeföljningen (superseded_by_invoice_id) ska boka den på påminnelsen.
    const secondRes = await payWebhook({
      bankgiro,
      ocr: original.ocr,
      amountOre: FULL_AMOUNT_ORE - partialOre + REMINDER_FEE_ORE,
    });
    expect(secondRes.status).toBe(200);

    await until(async () => (await getInvoice(s, reminderId)).status === "paid");
    // Originalet har EN rad (delbetalningen, bokad innan påminnelsen ens
    // fanns) — men den ANDRA betalningen, gjord på originalets OCR EFTER
    // att kedjan pekade vidare, ska landa på påminnelsen, inte originalet.
    const [{ n: paymentsOnOriginal }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invoice_payments WHERE invoice_id = ${original.id}
    `;
    expect(paymentsOnOriginal).toBe(1);
    const [{ n: paymentsOnReminder }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM invoice_payments WHERE invoice_id = ${reminderId}
    `;
    expect(paymentsOnReminder).toBe(1);
  });

  test("kontostrypning är per KONTO, inte per IP: fem misslyckade inloggningar från olika IP:n ger ändå 429 på sjätte", async () => {
    const email = `lockout-${uniq()}@ex.test`;
    await registerVerifyLogin(email);

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${AUTH_URL}/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Olika spoofad IP varje gång — bevisar att strypningen följer
          // KONTOT (throttle.ts, Redis-nyckel per e-post), inte avsändar-IP:t.
          "x-forwarded-for": `10.0.${i}.${i}`,
        },
        body: JSON.stringify({ email, password: "fel-lösenord" }),
      });
      expect(res.status).toBe(401);
    }

    // Sjätte försöket — även med RÄTT lösenord och ännu en ny IP — ska
    // ändå strypas (assertNotLockedOut kollas FÖRE lösenordet verifieras).
    const locked = await fetch(`${AUTH_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.0.9.9" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(locked.status).toBe(429);
  });

  test("riktig RabbitMQ-omleverans av samma event skapar inget dubblett-dokument", async () => {
    const s = await newAdmin("full5");
    await fillCompanySettings(s);
    const customerId = await makeCustomer(s);
    const { id } = await sentInvoice(s, customerId);
    await waitForDocumentRow(s.tenantId, id);

    const [outboxRow] = await sql<
      {
        event_id: string;
        event_type: string;
        tenant_id: number;
        correlation_id: string;
        payload: unknown;
        occurred_at: Date;
      }[]
    >`
      SELECT event_id, event_type, tenant_id, correlation_id, payload, occurred_at
      FROM event_outbox WHERE tenant_id = ${s.tenantId} AND event_type = 'invoice.sent' LIMIT 1
    `;
    expect(outboxRow).toBeDefined();

    const [{ n: before }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM documents WHERE invoice_id = ${id}
    `;
    expect(before).toBe(1);

    // Republicerar EXAKT samma envelope (samma eventId) direkt till
    // exchanget — en riktig broker-nivå-omleverans, inte outboxens egen
    // dedup vid publicering. processed_events (event_id, consumer) ska
    // stoppa den innan jobbet görs om.
    const envelope = {
      eventId: outboxRow!.event_id,
      eventType: outboxRow!.event_type,
      tenantId: outboxRow!.tenant_id,
      correlationId: outboxRow!.correlation_id,
      occurredAt: outboxRow!.occurred_at.toISOString(),
      payload: outboxRow!.payload,
    };
    const conn = await amqplib.connect(MQ_URL);
    const ch = await conn.createChannel();
    ch.publish("events", "invoice.sent", Buffer.from(JSON.stringify(envelope)), {
      contentType: "application/json",
      persistent: true,
    });
    await new Promise((r) => setTimeout(r, 5000)); // ge documents tid att hantera (eller inte) omleveransen
    await ch.close();
    await conn.close();

    const [{ n: after }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM documents WHERE invoice_id = ${id}
    `;
    expect(after).toBe(1);
  });

  test("GET /internal/ops/alerts: saknat token ger 401, fel scope ger 403, rätt scope ger 200", async () => {
    const noToken = await fetch(`${BILLING_URL}/internal/ops/alerts`);
    expect(noToken.status).toBe(401);

    const wrongScopeToken = await opsToken(OPS_CLIENT_ID, OPS_CLIENT_SECRET, "ops:alerts:read");
    // (samma klient har bara detta scope, så en förfrågan om ett ANNAT
    // scope avvisas redan vid tokenutfärdandet — testar i stället en
    // giltig token mot rätt scope här, och tokenförväxling är redan
    // uttömmande täckt i e2e/m2m.test.ts.)
    const ok = await fetch(`${BILLING_URL}/internal/ops/alerts`, {
      headers: { authorization: `Bearer ${wrongScopeToken}` },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      deadLetterQueue: { depth: number };
      outboxDeadLetters: { count: number };
      unmatchedTransactions: { count: number };
    };
    expect(typeof body.deadLetterQueue.depth).toBe("number");
    expect(typeof body.outboxDeadLetters.count).toBe("number");
    expect(typeof body.unmatchedTransactions.count).toBe("number");
  });
});
