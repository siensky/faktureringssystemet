// Delade konstanter mellan seed.ts (tenant/admin, körs direkt efter migrate)
// och seed-demo-data.ts (kund/fakturor, körs efter att auth/billing/payments
// rapporterat healthy). Ett enda ställe att döpa om ifrån — annars kan de
// två stegen glida isär (t.ex. adminkontot i seed.ts pekar på en annan
// org_number än kunden i seed-demo-data.ts letar upp).
//
// Inga hemligheter här — bara kända, dokumenterade testuppgifter för lokal
// utveckling (samma resonemang som seed.ts #10-15: en allowlist på
// development/test, aldrig i produktion).

export const DEMO_TENANT_NAME = "Snickeri AB";
export const DEMO_TENANT_ORG_NUMBER = "5560123456";
export const DEMO_TENANT_BANKGIRO = "9000001";

export const DEMO_ADMIN_EMAIL = "admin@demo.test";
export const DEMO_ADMIN_PASSWORD = "DemoLosenord123!";

export const DEMO_CUSTOMER_NAME = "Frida Nilsson AB";
export const DEMO_CUSTOMER_ORG_NUMBER = "5560987652";
export const DEMO_CUSTOMER_EMAIL = "kund@demo.test";
export const DEMO_CUSTOMER_PASSWORD = "DemoLosenord123!";
