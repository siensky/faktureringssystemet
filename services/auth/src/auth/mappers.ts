// Översättning mellan interna värden och API-form. I auth-modulen är
// svaren små; det mesta är token-par och generiska kvitton.

import type { CurrentUserDto } from "@faktura/contracts";
import type { TokenPair, UserRole } from "./types";

export function toTokenPairResponse(pair: TokenPair) {
  return {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: pair.expiresIn,
    tokenType: "Bearer" as const,
  };
}

export function toCurrentUserView(
  row: {
    id: number;
    tenant_id: number;
    role: UserRole;
    email: string | null;
    customer_id: number | null;
    tenant_name: string;
  },
  companies?: { tenant_id: number; tenant_name: string; customer_id: number }[],
  customerName?: string | null,
): CurrentUserDto {
  return {
    userId: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    email: row.email,
    role: row.role,
    customerId: row.customer_id,
    customerName: customerName ?? null,
    ...(companies && {
      companies: companies.map((c) => ({
        tenantId: c.tenant_id,
        tenantName: c.tenant_name,
        customerId: c.customer_id,
      })),
    }),
  };
}

/** Generiskt kvitto — används där svaret inte får skvallra om utfallet. */
export const OK = { status: "ok" as const };
