import type { CompanyLinkDto } from "@faktura/contracts";
import type { TokenPairResponse } from "./auth";
import { apiRequest } from "./client";

export interface BankIdInitResult {
  orderRef: string;
  autoStartToken: string;
  qrStartToken: string;
  qrStartSecret: string;
  /** ISO-sträng — JSON bär inga Date-objekt. */
  qrStartedAt: string;
}

export type BankIdCollectResult =
  | { status: "pending" | "failed"; hintCode?: string }
  // Identifierad, men inte länkad till något företag än — inget sessions-
  // token utfärdas (services/auth/src/bankid/services.ts). Portalen visar
  // ett tomt "inga utgifter än"-läge direkt ur det här svaret.
  | { status: "no_company"; companies: [] }
  | (TokenPairResponse & { status: "complete"; companies: CompanyLinkDto[] });

/** Ingen personalNumber — QR/samma-enhet-flödet (services/auth/src/bankid/schema.ts). */
export function init(): Promise<BankIdInitResult> {
  return apiRequest("/auth/bankid/init", { method: "POST", body: {} });
}

export function collect(orderRef: string): Promise<BankIdCollectResult> {
  return apiRequest("/auth/bankid/collect", { method: "POST", body: { orderRef } });
}

/** Kräver att man redan är inloggad — servern verifierar tenantId mot user_company_links. */
export function switchCompany(tenantId: number): Promise<TokenPairResponse> {
  return apiRequest("/auth/companies/switch", { method: "POST", body: { tenantId } });
}
