// Engångscontainer: skapar en exempelkund med tre fakturor i olika
// tillstånd (betald, skickad, försenad+påminnelse) i det demo-tenant som
// seed.ts redan satt upp — och en lösenordsinloggning åt kunden, så
// root-READMEs "Running it locally" har en riktig kund att logga in som.
//
// Går via TJÄNSTERNAS EGNA HTTP-API:er, inte omskriven affärslogik i SQL:
// moms, fakturanummer/OCR, betalningsmatchning och påminnelsegenerering
// finns redan, korrekta och testade, i billing/payments. Att räkna om dem
// här hade varit precis den sortens duplicering architecture.md #27
// förbjuder ("Kopiera inte en hjälpfunktion") — och en tyst källa till fel
// exempeldata om de två uträkningarna någonsin skulle glida isär.
//
// Körs EFTER att auth/billing/payments rapporterat healthy
// (docker-compose.yml), till skillnad från seed (som bara väntar på
// migrate) — den här datan kräver att tjänsternas API:er faktiskt svarar.
// Går direkt mot varje tjänsts containernamn på Docker-nätverket, inte via
// nginx: /internal/automation/run är explicit blockerad där
// (infra/nginx/nginx.conf), så genväg för alla anrop är enklare än att
// blanda två vägar.
//
// Idempotent på två sätt: dels ett tidigt avbrott om demo-kunden redan har
// fakturor, dels en FAST Idempotency-Key per skapande-anrop (billings eget
// idempotenslager, services/billing/src/idempotency.ts) som gör en
// omkörning ofarlig även om den tidiga kollen missas.

import { createHmac } from "node:crypto";
import postgres from "postgres";
import type { Sql } from "postgres";
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_CUSTOMER_EMAIL,
  DEMO_CUSTOMER_NAME,
  DEMO_CUSTOMER_ORG_NUMBER,
  DEMO_CUSTOMER_PASSWORD,
  DEMO_TENANT_BANKGIRO,
  DEMO_TENANT_ORG_NUMBER,
} from "./demo-constants";

const ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`seed-demo-data: saknar miljövariabel ${name}`);
    process.exit(1);
  }
  return value;
}

function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (res.status >= 400) {
    throw new Error(`${url} -> ${res.status}: ${text}`);
  }
  return { status: res.status, body: parsed };
}

interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceOre: number;
  vatRate: 25;
}

async function main(): Promise<void> {
  const env = process.env.NODE_ENV;
  if (!env || !ALLOWED_ENVIRONMENTS.has(env)) {
    console.error(
      `seed-demo-data: vägrar köra — NODE_ENV måste vara "development" eller "test" (var: ${env ?? "<osatt>"})`,
    );
    process.exit(1);
  }

  const databaseUrl = required("DATABASE_URL");
  const authBaseUrl = required("AUTH_BASE_URL");
  const billingBaseUrl = required("BILLING_BASE_URL");
  const paymentsBaseUrl = required("PAYMENTS_BASE_URL");
  const paymentWebhookSecret = required("PAYMENT_WEBHOOK_SECRET");
  const billingOpsClientId = required("BILLING_OPS_CLIENT_ID");
  const billingOpsClientSecret = required("BILLING_OPS_CLIENT_SECRET");

  const sql: Sql = postgres(databaseUrl, { max: 1 });
  try {
    const [tenant] = await sql<[{ id: number }]>`
      SELECT id FROM tenants WHERE org_number = ${DEMO_TENANT_ORG_NUMBER}
    `;
    if (!tenant) {
      throw new Error(
        "seed-demo-data: demo-tenanten finns inte — seed (seed.ts) måste köras innan detta steg",
      );
    }

    // Adminlogin: e-post + lösenord räcker (POST /auth/login), samma
    // Bun.password.hash-algoritm som seed.ts satte kontot upp med.
    const login = await postJson(
      `${authBaseUrl}/auth/login`,
      {
        email: DEMO_ADMIN_EMAIL,
        password: DEMO_ADMIN_PASSWORD,
      },
      {},
    );
    const adminToken: string = login.body.accessToken;
    const adminHeaders = { authorization: `Bearer ${adminToken}` };

    let customerId: number;
    const [existingCustomer] = await sql<{ id: number }[]>`
      SELECT id FROM customers WHERE tenant_id = ${tenant.id} AND org_number = ${DEMO_CUSTOMER_ORG_NUMBER}
    `;
    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const created = await postJson(
        `${billingBaseUrl}/admin/customers`,
        {
          customerType: "company",
          name: DEMO_CUSTOMER_NAME,
          email: DEMO_CUSTOMER_EMAIL,
          orgNumber: DEMO_CUSTOMER_ORG_NUMBER,
        },
        { ...adminHeaders, "idempotency-key": "seed-demo-customer" },
      );
      customerId = created.body.id;
      console.log(`seed-demo-data: ✓ kund "${DEMO_CUSTOMER_NAME}" (id ${customerId})`);
    }

    // Kundens portalinloggning (lösenordsbaserad) — skapas direkt i
    // databasen som en riktig users-rad i stället för att gå via
    // kundinbjudan/e-postflödet (ingen e-post skickas någonstans lokalt,
    // se README): samma slutresultat en accepterad inbjudan hade gett.
    const customerPasswordHash = await Bun.password.hash(DEMO_CUSTOMER_PASSWORD, {
      algorithm: "argon2id",
    });
    // Slås upp på customer_id, inte e-post: users_customer_id_unique
    // (migrations/0009_portal.js) tillåter högst EN lösenordsinloggning
    // per kund — kundraden kan redan ha en (t.ex. från tidigare manuellt
    // skapad testdata i samma databas), oavsett vilken e-post den bär.
    const [existingLogin] = await sql<{ id: number }[]>`
      SELECT id FROM users WHERE customer_id = ${customerId} AND auth_method = 'password'
    `;
    if (existingLogin) {
      await sql`
        UPDATE users
        SET password_hash = ${customerPasswordHash}, tenant_id = ${tenant.id},
            customer_id = ${customerId}, email_verified_at = now()
        WHERE id = ${existingLogin.id}
      `;
    } else {
      await sql`
        INSERT INTO users (tenant_id, role, auth_method, customer_id, email, password_hash, email_verified_at)
        VALUES (${tenant.id}, 'customer', 'password', ${customerId}, ${DEMO_CUSTOMER_EMAIL}, ${customerPasswordHash}, now())
      `;
    }
    console.log(`seed-demo-data: ✓ kundinloggning ${DEMO_CUSTOMER_EMAIL}`);

    const [existingInvoice] = await sql<{ id: number }[]>`
      SELECT id FROM invoices WHERE customer_id = ${customerId} LIMIT 1
    `;
    if (existingInvoice) {
      console.log("seed-demo-data: exempelfakturor finns redan, hoppar över.");
      return;
    }

    const createInvoice = async (
      key: string,
      lines: InvoiceLine[],
      dateIssued?: string,
      dateDue?: string,
    ) => {
      const body: Record<string, unknown> = { customerId, lines };
      if (dateIssued) body.dateIssued = dateIssued;
      if (dateDue) body.dateDue = dateDue;
      const created = await postJson(`${billingBaseUrl}/admin/invoices`, body, {
        ...adminHeaders,
        "idempotency-key": key,
      });
      return created.body as { id: number };
    };

    const sendInvoice = async (key: string, id: number) => {
      const res = await fetch(`${billingBaseUrl}/admin/invoices/${id}/send`, {
        method: "POST",
        headers: { ...adminHeaders, "idempotency-key": key },
      });
      const text = await res.text();
      if (res.status >= 400) throw new Error(`send ${id} -> ${res.status}: ${text}`);
      return JSON.parse(text) as { ocrNumber: string; totalInclVat: number };
    };

    // Faktura A: betald. Skickas och betalas sedan i sin helhet via en
    // riktig signerad betalnings-webhook — exakt så en bank rapporterar
    // en inbetalning i produktion (services/payments/src/webhooks).
    const invoiceA = await createInvoice("seed-demo-invoice-a", [
      {
        description: "Snickeriarbete – köksrenovering",
        quantity: 1,
        unitPriceOre: 4500000,
        vatRate: 25,
      },
    ]);
    const sentA = await sendInvoice("seed-demo-invoice-a-send", invoiceA.id);

    const webhookBody = {
      id: "seed-demo-payment-a",
      bankgiro: DEMO_TENANT_BANKGIRO,
      ocr: sentA.ocrNumber,
      amountOre: Math.round(sentA.totalInclVat * 100),
      payerName: DEMO_CUSTOMER_NAME,
      bookedAt: new Date().toISOString(),
    };
    const rawBody = JSON.stringify(webhookBody);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", paymentWebhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");
    const webhookRes = await fetch(`${paymentsBaseUrl}/webhooks/payment`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": signature,
        "x-timestamp": timestamp,
      },
      body: rawBody,
    });
    if (webhookRes.status >= 400) {
      throw new Error(`webhook payment a -> ${webhookRes.status}: ${await webhookRes.text()}`);
    }
    console.log(`seed-demo-data: ✓ faktura ${sentA.ocrNumber} skickad och betald`);

    // Faktura B: skickad, ännu obetald ("kommande").
    const invoiceB = await createInvoice("seed-demo-invoice-b", [
      {
        description: "Materialkostnad – virke och beslag",
        quantity: 1,
        unitPriceOre: 800000,
        vatRate: 25,
      },
    ]);
    const sentB = await sendInvoice("seed-demo-invoice-b-send", invoiceB.id);
    console.log(`seed-demo-data: ✓ faktura ${sentB.ocrNumber} skickad, obetald`);

    // Faktura C: bakåtdaterad så den redan är förfallen vid utskick —
    // /internal/automation/run nedan flaggar den som försenad och skapar
    // en påminnelse, precis som det nattliga jobbet gör i produktion.
    const invoiceC = await createInvoice(
      "seed-demo-invoice-c",
      [
        {
          description: "Snickeriarbete – garderob",
          quantity: 1,
          unitPriceOre: 1200000,
          vatRate: 25,
        },
      ],
      isoDate(-45),
      isoDate(-15),
    );
    const sentC = await sendInvoice("seed-demo-invoice-c-send", invoiceC.id);
    console.log(`seed-demo-data: ✓ faktura ${sentC.ocrNumber} skickad, redan förfallen`);

    const tokenRes = await postJson(
      `${authBaseUrl}/auth/token`,
      {
        grant_type: "client_credentials",
        client_id: billingOpsClientId,
        client_secret: billingOpsClientSecret,
        scope: "billing:ops:run",
      },
      {},
    );
    const opsToken: string = tokenRes.body.access_token;
    const runRes = await fetch(`${billingBaseUrl}/internal/automation/run`, {
      method: "POST",
      headers: { authorization: `Bearer ${opsToken}` },
    });
    if (runRes.status >= 400) {
      throw new Error(`automation/run -> ${runRes.status}: ${await runRes.text()}`);
    }
    console.log(
      "seed-demo-data: ✓ automationskörning — faktura C markerad försenad + påminnelse skapad",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log("seed-demo-data: klart.");
}

main().catch((error) => {
  console.error("seed-demo-data: misslyckades", error);
  process.exit(1);
});
