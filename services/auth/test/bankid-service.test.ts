import { describe, expect, test } from "bun:test";
import type { PortalAccountSummaryDto } from "@faktura/contracts";
import type { BankIdProvider, InitResult } from "../src/bankid/provider";
import type { BankIdRepository, CompanyLink } from "../src/bankid/repository";
import type { CustomerCompanyMatch } from "../src/billing-client";

// services.ts importerar (via billing-client.ts) den riktiga config.ts, som
// kraschar vid import utan alla obligatoriska miljövariabler (code-style.md
// #28). Sätts INNAN den dynamiska importen nedan, så modulen aldrig laddas
// med en tom miljö — samma behov som config-guard.test.ts löser med en
// subprocess, men här räcker dummyvärden eftersom vi aldrig nätverkar ut
// (providern nedan är en fejk och config-objektet som skickas in i
// createBankIdService är ett eget, separat fejk-objekt).
for (const [key, value] of Object.entries({
  DATABASE_URL: "postgres://x/y",
  RABBITMQ_URL: "amqp://x",
  REDIS_URL: "redis://x",
  JWT_USER_SECRET: "u",
  JWT_SERVICE_SECRET: "s",
  AUTH_TOKEN_PEPPER: "p",
  PNR_HMAC_KEY: "deadbeef".repeat(8),
  BILLING_BASE_URL: "http://billing",
  AUTH_BASE_URL: "http://auth",
  AUTH_CLIENT_ID: "svc-auth",
  AUTH_CLIENT_SECRET: "c",
})) {
  process.env[key] = value;
}
const { createBankIdService } = await import("../src/bankid/services");

// Minimal Redis-fake — bara det assertInitRate (throttle.ts) använder.
class FakeRedis {
  private counters = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const n = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, n);
    return n;
  }
  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }
}

const FAKE_RESULT: InitResult = {
  orderRef: "order-1",
  autoStartToken: "auto-1",
  qrStartToken: "qr-tok",
  qrStartSecret: "qr-secret",
  qrStartedAt: new Date(),
};

// sessionIssuer.issue() (session.ts) skriver en rad i user_tokens direkt via
// sql — behövs för collect()/switchCompany(), som alltid utfärdar en session
// vid lyckat utfall. Returvärdet läses aldrig, bara att anropet inte kastar.
function makeFakeSql() {
  const fn = async (..._args: unknown[]) => [] as unknown[];
  (fn as unknown as { begin: unknown }).begin = async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({});
  return fn as never;
}

const FAKE_CONFIG = {
  pnrHmacKey: "deadbeef".repeat(8),
  jwtUserSecret: "test-jwt-secret-at-least-this-long",
  refreshTtlSeconds: 3600,
  // hashToken (session.ts) kräver 32 byte (64 hex-tecken), samma format som
  // pnrHmacKey ovan — se packages/shared/src/crypto/index.ts:keyFromHex.
  tokenPepper: "cafebabe".repeat(8),
} as never;

interface FakeRepoOptions {
  tenantStatuses?: Record<number, string>;
  identityId?: number;
  companyLinksAfterSync?: CompanyLink[];
  findLinkResult?: { tenant_id: number; customer_id: number };
}

function makeFakeRepo(options: FakeRepoOptions = {}) {
  const calls = {
    syncCompanyLinks: [] as { userId: number; matches: CustomerCompanyMatch[] }[],
    touchLink: [] as { userId: number; tenantId: number }[],
    findOrCreate: 0,
  };
  const repo: BankIdRepository = {
    async getTenantStatus(tenantId: number) {
      return options.tenantStatuses?.[tenantId] ?? "active";
    },
    async findOrCreateBankIdCustomerIdentity() {
      calls.findOrCreate += 1;
      return { id: options.identityId ?? 999 };
    },
    async syncCompanyLinks(_tx, userId, matches) {
      calls.syncCompanyLinks.push({ userId, matches });
    },
    async listCompanyLinks() {
      return options.companyLinksAfterSync ?? [];
    },
    async touchLink(userId, tenantId) {
      calls.touchLink.push({ userId, tenantId });
    },
    async findLink() {
      return options.findLinkResult;
    },
  };
  return { repo, calls };
}

const NO_OP_PROVIDER: BankIdProvider = {
  init: async () => FAKE_RESULT,
  collect: async () => ({ status: "pending" }),
  cancel: async () => {},
};

function completeProvider(personalNumber: string): BankIdProvider {
  return {
    init: async () => FAKE_RESULT,
    collect: async () => ({
      status: "complete",
      completionData: { personalNumber, name: "Test Testsson" },
    }),
    cancel: async () => {},
  };
}

describe("bankid/services.ts init() — personalNumber är valfritt", () => {
  test("utan personnummer (QR-flödet) kraschar inte på pnr-nyckeln, providern får undefined", async () => {
    let receivedInput: { personalNumber?: string; endUserIp: string } | undefined;
    const provider: BankIdProvider = {
      init: async (input) => {
        receivedInput = input;
        return FAKE_RESULT;
      },
      collect: async () => ({ status: "pending" }),
      cancel: async () => {},
    };
    const service = createBankIdService({
      sql: {} as never,
      redis: new FakeRedis() as never,
      config: { pnrHmacKey: "deadbeef".repeat(8) } as never,
      provider,
    });

    const result = await service.init(undefined, "1.2.3.4");

    expect(result.orderRef).toBe("order-1");
    expect(receivedInput?.personalNumber).toBeUndefined();
    expect(receivedInput?.endUserIp).toBe("1.2.3.4");
  });

  test("med personnummer skickas det vidare till providern som vanligt", async () => {
    let receivedInput: { personalNumber?: string; endUserIp: string } | undefined;
    const provider: BankIdProvider = {
      init: async (input) => {
        receivedInput = input;
        return FAKE_RESULT;
      },
      collect: async () => ({ status: "pending" }),
      cancel: async () => {},
    };
    const service = createBankIdService({
      sql: {} as never,
      redis: new FakeRedis() as never,
      config: { pnrHmacKey: "deadbeef".repeat(8) } as never,
      provider,
    });

    await service.init("199001011234", "1.2.3.4");

    expect(receivedInput?.personalNumber).toBe("199001011234");
  });
});

describe("bankid/services.ts collect() — tenant-övergripande igenkänning (fas 12)", () => {
  test("inga matchningar -> identiteten skapas ändå, men no_company utan sessions-token", async () => {
    const { repo, calls } = makeFakeRepo();
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: completeProvider("199001011234"),
      repo,
      findCustomersByPnrHmac: async () => [],
    });

    const result = await service.collect("order-1", "corr-1");

    expect(result).toEqual({ status: "no_company", companies: [] });
    // Identiteten skapas ALLTID vid en lyckad signering (domain.md #22,
    // omskriven) — bara sessions-utfärdandet är villkorat av en länk.
    expect(calls.findOrCreate).toBe(1);
    expect(calls.syncCompanyLinks).toEqual([{ userId: 999, matches: [] }]);
    expect(calls.touchLink).toEqual([]);
  });

  test("matchningar finns men alla tenants avstängda -> no_company, ingen länk kvar efter synk", async () => {
    const { repo, calls } = makeFakeRepo({
      tenantStatuses: { 1: "suspended", 2: "suspended" },
    });
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: completeProvider("199001011234"),
      repo,
      findCustomersByPnrHmac: async () => [
        { tenantId: 1, customerId: 10 },
        { tenantId: 2, customerId: 20 },
      ],
    });

    const result = await service.collect("order-1", "corr-1");

    expect(result).toEqual({ status: "no_company", companies: [] });
    expect(calls.findOrCreate).toBe(1);
    // Avstängda tenants filtrerades bort INNAN syncCompanyLinks — den ser
    // aldrig de suspenderade matchningarna, precis som innan.
    expect(calls.syncCompanyLinks).toEqual([{ userId: 999, matches: [] }]);
    expect(calls.touchLink).toEqual([]);
  });

  test("filtrerar bort avstängda tenants men behåller aktiva, utfärdar session för den aktiva länken", async () => {
    const { repo, calls } = makeFakeRepo({
      tenantStatuses: { 1: "active", 2: "suspended" },
      identityId: 42,
      companyLinksAfterSync: [{ tenant_id: 1, customer_id: 10, tenant_name: "Aktivt bolag" }],
    });
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: completeProvider("199001011234"),
      repo,
      findCustomersByPnrHmac: async () => [
        { tenantId: 1, customerId: 10 },
        { tenantId: 2, customerId: 20 },
      ],
    });

    const result = await service.collect("order-1", "corr-1");

    expect(result.status).toBe("complete");
    expect(calls.syncCompanyLinks).toHaveLength(1);
    // Bara den aktiva tenanten skickas vidare till syncCompanyLinks — den
    // avstängda filtreras bort INNAN identiteten ens skapas.
    expect(calls.syncCompanyLinks[0]?.matches).toEqual([{ tenantId: 1, customerId: 10 }]);
    expect(calls.touchLink).toEqual([{ userId: 42, tenantId: 1 }]);
    if (result.status === "complete") {
      expect(result.companies).toEqual([
        { tenantId: 1, tenantName: "Aktivt bolag", customerId: 10 },
      ]);
      expect(result.accessToken).toBeTruthy();
    }
  });
});

describe("bankid/services.ts switchCompany() — verifierar alltid mot user_company_links", () => {
  test("ingen länk till den begärda tenanten -> Forbidden", async () => {
    const { repo } = makeFakeRepo({ findLinkResult: undefined });
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: NO_OP_PROVIDER,
      repo,
    });

    await expect(service.switchCompany(1, 999)).rejects.toThrow(
      "Inget företag kopplat till det här kontot",
    );
  });

  test("länk finns men tenanten är avstängd -> Forbidden", async () => {
    const { repo } = makeFakeRepo({
      findLinkResult: { tenant_id: 5, customer_id: 50 },
      tenantStatuses: { 5: "suspended" },
    });
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: NO_OP_PROVIDER,
      repo,
    });

    await expect(service.switchCompany(1, 5)).rejects.toThrow("Kontot är avstängt");
  });

  test("länk finns och tenanten är aktiv -> ny session, touchLink anropas", async () => {
    const { repo, calls } = makeFakeRepo({
      findLinkResult: { tenant_id: 5, customer_id: 50 },
    });
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: NO_OP_PROVIDER,
      repo,
    });

    const tokens = await service.switchCompany(1, 5);

    expect(tokens.accessToken).toBeTruthy();
    expect(calls.touchLink).toEqual([{ userId: 1, tenantId: 5 }]);
  });
});

describe("bankid/services.ts overview() — allSettled, ett trasigt företag döljer inte de andra", () => {
  test("tom länklista -> tom lista, inga anrop mot billing", async () => {
    const { repo } = makeFakeRepo({ companyLinksAfterSync: [] });
    let billingCalls = 0;
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: NO_OP_PROVIDER,
      repo,
      getPortalAccountSummary: async () => {
        billingCalls += 1;
        return { outstanding: 0, outstandingInvoiceCount: 0 } satisfies PortalAccountSummaryDto;
      },
    });

    const result = await service.overview(1, "corr-1");

    expect(result.companies).toEqual([]);
    expect(billingCalls).toBe(0);
  });

  test("ett företags accountSummary misslyckas -> de andra returneras ändå, felet loggas", async () => {
    const { repo } = makeFakeRepo({
      companyLinksAfterSync: [
        { tenant_id: 1, customer_id: 10, tenant_name: "Bolag A" },
        { tenant_id: 2, customer_id: 20, tenant_name: "Bolag B (trasigt)" },
      ],
    });
    const warnings: unknown[] = [];
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: NO_OP_PROVIDER,
      repo,
      logger: { warn: (...args: unknown[]) => warnings.push(args) } as never,
      getPortalAccountSummary: async (_redis, tenantId) => {
        if (tenantId === 2) throw new Error("billing svarade 500");
        return { outstanding: 100, outstandingInvoiceCount: 1 } satisfies PortalAccountSummaryDto;
      },
    });

    const result = await service.overview(1, "corr-1");

    expect(result.companies).toEqual([
      {
        tenantId: 1,
        tenantName: "Bolag A",
        customerId: 10,
        outstanding: 100,
        outstandingInvoiceCount: 1,
      },
    ]);
    expect(warnings).toHaveLength(1);
  });

  test("alla företag lyckas -> alla aggregeras", async () => {
    const { repo } = makeFakeRepo({
      companyLinksAfterSync: [
        { tenant_id: 1, customer_id: 10, tenant_name: "Bolag A" },
        { tenant_id: 2, customer_id: 20, tenant_name: "Bolag B" },
      ],
    });
    const service = createBankIdService({
      sql: makeFakeSql(),
      redis: new FakeRedis() as never,
      config: FAKE_CONFIG,
      provider: NO_OP_PROVIDER,
      repo,
      getPortalAccountSummary: async (_redis, tenantId) =>
        ({
          outstanding: tenantId * 100,
          outstandingInvoiceCount: tenantId,
        }) satisfies PortalAccountSummaryDto,
    });

    const result = await service.overview(1, "corr-1");

    expect(result.companies.map((c) => c.tenantId).sort()).toEqual([1, 2]);
  });
});
