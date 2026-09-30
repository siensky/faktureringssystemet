// Engångs-provisionering av S2S-klienter i `service_clients` (auth äger
// tabellen). Körs som en egen container EFTER migrate och FÖRE tjänsterna
// (docker-compose.yml), precis som rabbitmq-init.
//
// Varför ett eget steg och inte en migration: seed-data hör aldrig hemma i
// en migration (database.md #5). Varför inte bara i e2e-testerna: då kan
// documents inte hämta snapshoten vid ett vanligt `docker compose up`, och
// planens verifieringsrökprov går inte att köra.
//
// Vägrar köra utanför development/test (code-style.md #24) — ALLOWLIST,
// inte en denylist på "production": ett script som skapar kända konton
// med kända hemligheter är en bakdörr om det råkar köras i produktion, och
// en denylist missar det direkt om NODE_ENV är osatt, felstavat ("prod",
// "Production") eller bara glömt i en container. I produktion provisioneras
// klienter genom en riktig, granskad rutin.
//
// Idempotent: ON CONFLICT ... DO UPDATE, säkert att köra om vid varje
// `docker compose up`.

import postgres from "postgres";
import type { Sql } from "postgres";
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_TENANT_BANKGIRO,
  DEMO_TENANT_NAME,
  DEMO_TENANT_ORG_NUMBER,
} from "./demo-constants";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`seed: saknar miljövariabel ${name}`);
    process.exit(1);
  }
  return value;
}

async function hashSecret(secret: string): Promise<string> {
  // Samma algoritm som auth verifierar med — Bun.password (argon2id),
  // services/auth/src/passwords.ts.
  return Bun.password.hash(secret, { algorithm: "argon2id" });
}

interface ClientSpec {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  description: string;
}

const ALLOWED_ENVIRONMENTS = new Set(["development", "test"]);

// Demo-tenant + adminkonto, så det alltid finns en känd inloggning att
// testa lokalt med utan att först behöva registrera sig (root-README,
// "Running it locally"). Kunden och exempelfakturorna seedas separat i
// seed-demo-data.ts, som körs EFTER att auth/billing/payments är healthy —
// det här steget rör bara databasen och kan därför köras tidigt, precis
// som service_clients ovan.
async function seedDemoAdmin(sql: Sql): Promise<void> {
  const [tenant] = await sql<[{ id: number }]>`
    INSERT INTO tenants (name, org_number)
    VALUES (${DEMO_TENANT_NAME}, ${DEMO_TENANT_ORG_NUMBER})
    ON CONFLICT (org_number) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  await sql`
    INSERT INTO company_settings (tenant_id, company_name, org_number, bankgiro)
    VALUES (${tenant.id}, ${DEMO_TENANT_NAME}, ${DEMO_TENANT_ORG_NUMBER}, ${DEMO_TENANT_BANKGIRO})
    ON CONFLICT (tenant_id) DO UPDATE
    SET company_name = EXCLUDED.company_name,
        org_number = EXCLUDED.org_number,
        bankgiro = EXCLUDED.bankgiro
  `;

  const passwordHash = await hashSecret(DEMO_ADMIN_PASSWORD);
  const [existing] = await sql<{ id: number }[]>`
    SELECT id FROM users WHERE lower(email) = lower(${DEMO_ADMIN_EMAIL})
  `;
  if (existing) {
    await sql`
      UPDATE users
      SET password_hash = ${passwordHash}, tenant_id = ${tenant.id}, email_verified_at = now()
      WHERE id = ${existing.id}
    `;
  } else {
    await sql`
      INSERT INTO users (tenant_id, role, auth_method, email, password_hash, email_verified_at)
      VALUES (${tenant.id}, 'admin', 'password', ${DEMO_ADMIN_EMAIL}, ${passwordHash}, now())
    `;
  }
  console.log(`seed: ✓ demo-tenant "${DEMO_TENANT_NAME}" + admin ${DEMO_ADMIN_EMAIL}`);
}

async function main(): Promise<void> {
  const env = process.env.NODE_ENV;
  if (!env || !ALLOWED_ENVIRONMENTS.has(env)) {
    console.error(
      `seed: vägrar köra — NODE_ENV måste vara "development" eller "test" (var: ${env ?? "<osatt>"})`,
    );
    process.exit(1);
  }

  const databaseUrl = required("DATABASE_URL");

  const clients: ClientSpec[] = [
    {
      clientId: required("DOCUMENTS_CLIENT_ID"),
      clientSecret: required("DOCUMENTS_CLIENT_SECRET"),
      // Minsta möjliga scope (architecture.md #18): documents anropar bara
      // GET /internal/invoices/:id/snapshot.
      scopes: (process.env.DOCUMENTS_CLIENT_SCOPES ?? "billing:invoice:read")
        .split(/\s+/)
        .filter(Boolean),
      description: "documents-tjänsten: läser snapshot/kund/företag för PDF-rendering (fas 4)",
    },
    {
      clientId: required("PAYMENTS_CLIENT_ID"),
      clientSecret: required("PAYMENTS_CLIENT_SECRET"),
      // Minsta möjliga scope (architecture.md #18): bankgiro->tenant och
      // OCR/id->aktuell faktura, inget mer.
      scopes: (process.env.PAYMENTS_CLIENT_SCOPES ?? "billing:company:read billing:invoice:read")
        .split(/\s+/)
        .filter(Boolean),
      description: "payments-tjänsten: bankgiro->tenant och OCR/id->faktura för matchning (fas 5)",
    },
    {
      clientId: required("PAYMENTS_OPS_CLIENT_ID"),
      clientSecret: required("PAYMENTS_OPS_CLIENT_SECRET"),
      // Ett DRIFT-konto, inte en tjänst: BgMax-liknande filimport och
      // driftvyn för okänt bankgiro (GET /internal/ops/payments/
      // unknown-bankgiro) har ingen körande tjänst som naturligt äger
      // dem. Tidigare seedades ingen klient alls för de här scopen —
      // bara e2e-sviten provisionerade sin egen engångsklient, så det
      // fanns ingen väg för en riktig operatör att autentisera sig mot
      // dem i en vanlig docker-compose-uppstart (PR-granskning fas 5,
      // punkt 12).
      scopes: (process.env.PAYMENTS_OPS_CLIENT_SCOPES ?? "payments:ops:import payments:ops:read")
        .split(/\s+/)
        .filter(Boolean),
      description: "drift-konto: BgMax-filimport och driftvyn för okänt bankgiro (fas 5)",
    },
    {
      clientId: required("BILLING_OPS_CLIENT_ID"),
      clientSecret: required("BILLING_OPS_CLIENT_SECRET"),
      // Ett DRIFT-konto, som PAYMENTS_OPS_CLIENT_ID ovan: POST
      // /internal/automation/run (fas 6, manuell körning av det dagliga
      // jobbet) har ingen körande tjänst som naturligt äger den — bara en
      // operatör som vill trigga/felsöka jobbet utanför 03:00-schemat.
      scopes: (process.env.BILLING_OPS_CLIENT_SCOPES ?? "billing:ops:run")
        .split(/\s+/)
        .filter(Boolean),
      description: "drift-konto: manuell körning av det dagliga automatiseringsjobbet (fas 6)",
    },
    {
      clientId: required("BILLING_CLIENT_ID"),
      clientSecret: required("BILLING_CLIENT_SECRET"),
      // Minsta möjliga scope (architecture.md #18): GET /internal/ops/alerts
      // anropar payments unknown-bankgiro-driftvy (fas 7); GET /portal/
      // invoices/:id/pdf anropar documents PDF-URL (fas 9); POST /portal/
      // invoices/:id/pay anropar payments Stripe Checkout-sessioner
      // (fas 10). Samma klientidentitet, tre anropsmål.
      scopes: (
        process.env.BILLING_CLIENT_SCOPES ??
        "payments:ops:read documents:pdf:read payments:stripe:checkout"
      )
        .split(/\s+/)
        .filter(Boolean),
      description:
        "billing-tjänsten: payments unknown-bankgiro (fas 7), documents PDF-URL (fas 9), Stripe Checkout (fas 10)",
    },
    {
      clientId: required("AUTH_CLIENT_ID"),
      clientSecret: required("AUTH_CLIENT_SECRET"),
      // billing:customer:read (fas 9): validerar customerId INNAN en
      // users-rad skrivs vid kundinbjudan.
      // billing:customer:lookup (fas 12): tenant-övergripande uppslag på
      // pnr_hmac vid BankID-inloggning — egen scope, mer känslig förmåga
      // än att läsa en redan känd kund.
      // billing:portal:read (fas 12): en accountSummary-läsning per
      // länkat företag för kundens företagsöversikt.
      // OBS: samma default-sträng står ÄVEN i services/auth/src/config.ts
      // (AUTH_CLIENT_SCOPES) — de två kan inte importera varandra (skilda
      // paket, seed har inget beroende på @faktura/shared). Uppdaterar du
      // en, uppdatera den andra.
      scopes: (
        process.env.AUTH_CLIENT_SCOPES ??
        "billing:customer:read billing:customer:lookup billing:portal:read"
      )
        .split(/\s+/)
        .filter(Boolean),
      description:
        "auth-tjänsten: kundinbjudan (fas 9), BankID-igenkänning och företagsöversikt (fas 12)",
    },
  ];

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    for (const client of clients) {
      const hash = await hashSecret(client.clientSecret);
      await sql`
        INSERT INTO service_clients (client_id, client_secret_hash, allowed_scopes, description)
        VALUES (${client.clientId}, ${hash}, ${client.scopes}, ${client.description})
        ON CONFLICT (client_id) DO UPDATE
        SET client_secret_hash = EXCLUDED.client_secret_hash,
            allowed_scopes = EXCLUDED.allowed_scopes,
            description = EXCLUDED.description
      `;
      console.log(`seed: ✓ ${client.clientId} (${client.scopes.join(" ")})`);
    }
    await seedDemoAdmin(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  console.log("seed: klart.");
}

main().catch((error) => {
  console.error("seed: misslyckades", error);
  process.exit(1);
});
