// S2S-klient mot billing (bankgiro->tenant, OCR/id->aktuell faktura) och
// auth (tjänste-token). Tjänste-token hämtas via OAuth2 client_credentials
// och cachas i Redis tills strax före utgång — getServiceToken i
// @faktura/shared, samma mönster som documents billing_client.py
// (kommentaren där syftar redan på den här TS-implementationen).
//
// X-Tenant-Id sätts från den tenant matchningsmotorn själv slagit upp
// (architecture.md #17 — en autentiserad tjänst får hävda tenant) — utom
// på resolveTenantByBankgiro, där det ÄR det anropet som ska avgöra
// tenanten.

import { getServiceToken } from "@faktura/shared";
import type Redis from "ioredis";
import { config } from "./config";

// Samma gräns som documents billing_client.py sätter på sina GET-anrop mot
// billing (httpx timeout=10.0) — den TS-skrivna klienten hade tidigare
// ingen alls, så ett hängande/trögt billing kunde blockera ett S2S-anrop
// på obestämd tid i stället för att ge upp och låta anroparen (matchning,
// se matching/service.ts) gå vidare till sin egen felhantering.
const BILLING_REQUEST_TIMEOUT_MS = 10_000;

export interface InvoiceResolution {
  currentInvoiceId: number;
  customerId: number;
  status: string;
  currency: string;
  totalInclVatOre: number;
  paidOre: number;
  remainingOre: number;
}

export class BillingAccessDeniedError extends Error {
  constructor(public readonly statusCode: number) {
    super(`billing nekade åtkomst (${statusCode})`);
    this.name = "BillingAccessDeniedError";
  }
}

export class BillingClient {
  constructor(private readonly redis: Redis) {}

  private async serviceToken(forceFresh: boolean): Promise<string> {
    if (forceFresh) {
      // getServiceToken cachar på (clientId, scope) — samma nyckel som
      // en normal hämtning. Ett explicit cache-bortkast görs inte här:
      // en 401 följt av en ny getServiceToken-runda inom samma sekund
      // skulle ändå bara returnera samma (nu ogiltiga) cachade värde.
      // I stället låter vi Redis-TTL:n (satt utifrån tokenets egen
      // expires_in) vara sanningen — se retry-kommentaren i get().
      await this.redis.del(
        `svc-token:${config.paymentsClientId}:${[...config.paymentsClientScopes].sort().join(" ")}`,
      );
    }
    return getServiceToken({
      authBaseUrl: config.authBaseUrl,
      clientId: config.paymentsClientId,
      clientSecret: config.paymentsClientSecret,
      redis: this.redis,
      scopes: config.paymentsClientScopes,
    });
  }

  private async get(
    path: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    const token = await this.serviceToken(false);
    let res = await fetch(`${config.billingBaseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
      signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
    });
    if (res.status === 401) {
      // architecture.md #19: 401 = ogiltigt/utgånget token — transient,
      // läker av ett enda nytt försök med ett färskt token (samma mönster
      // som documents billing_client.py).
      const fresh = await this.serviceToken(true);
      res = await fetch(`${config.billingBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${fresh}`, ...headers },
        signal: AbortSignal.timeout(BILLING_REQUEST_TIMEOUT_MS),
      });
    }
    const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body };
  }

  /**
   * Bankgiro -> tenant. undefined om inget bankgiro matchar (404) —
   * matchningsmotorn tolkar det som unknown_bankgiro, inte som ett fel.
   */
  async resolveTenantByBankgiro(
    bankgiro: string,
    correlationId: string,
  ): Promise<number | undefined> {
    const { status, body } = await this.get(
      `/internal/company-settings/by-bankgiro?bankgiro=${encodeURIComponent(bankgiro)}`,
      { "x-correlation-id": correlationId },
    );
    if (status === 404) return undefined;
    if (status === 403) throw new BillingAccessDeniedError(status);
    if (status !== 200) throw new Error(`by-bankgiro: billing svarade ${status}`);
    return (body as { tenantId: number }).tenantId;
  }

  /**
   * OCR -> aktuell faktura (kedjeföljning redan gjord av billing).
   * undefined om OCR:et inte matchar någon faktura för tenanten (404).
   */
  async resolveInvoiceByOcr(
    tenantId: number,
    ocr: string,
    correlationId: string,
  ): Promise<(InvoiceResolution & { matchedInvoiceId: number }) | undefined> {
    const { status, body } = await this.get(
      `/internal/invoices/by-ocr?ocr=${encodeURIComponent(ocr)}`,
      {
        "x-tenant-id": String(tenantId),
        "x-correlation-id": correlationId,
      },
    );
    if (status === 404) return undefined;
    if (status === 403) throw new BillingAccessDeniedError(status);
    if (status !== 200) throw new Error(`by-ocr: billing svarade ${status}`);
    return body as InvoiceResolution & { matchedInvoiceId: number };
  }

  /**
   * id -> aktuell faktura, med samma kedjeföljning. Används av den
   * manuella matchningen (admin anger ett invoiceId, verifieras mot en
   * LEVANDE remainingOre — domain.md #27). undefined om fakturan inte
   * finns för tenanten (404, inklusive tenant-gränsen — architecture.md,
   * "404 över tenant-gränsen, aldrig 403").
   */
  async resolveInvoiceById(
    tenantId: number,
    invoiceId: number,
    correlationId: string,
  ): Promise<InvoiceResolution | undefined> {
    const { status, body } = await this.get(`/internal/invoices/${invoiceId}/current`, {
      "x-tenant-id": String(tenantId),
      "x-correlation-id": correlationId,
    });
    if (status === 404) return undefined;
    if (status === 403) throw new BillingAccessDeniedError(status);
    if (status !== 200) throw new Error(`invoices/:id/current: billing svarade ${status}`);
    return body as InvoiceResolution;
  }
}
