import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import * as companiesApi from "../api/companies";
import { useAuth } from "../auth/AuthContext";
import { formatSEK } from "../lib/money";

export function CompaniesPage() {
  const { switchCompany } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ["companies", "overview"],
    queryFn: () => companiesApi.getOverview(),
  });
  const [switchError, setSwitchError] = useState<string | null>(null);

  async function openCompany(tenantId: number) {
    setSwitchError(null);
    try {
      await switchCompany(tenantId);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      // T.ex. att länken hann tas bort mellan att listan hämtades och
      // klicket (kodgranskning fas 12) — utan detta blev det en tyst,
      // ohanterad promise-rejection och inget svar till användaren alls.
      setSwitchError(err instanceof Error ? err.message : "Kunde inte byta företag");
    }
  }

  return (
    <div className="mx-auto min-h-screen max-w-2xl bg-gradient-to-b from-cream-50 to-cream-100 px-6 py-12">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink-900">Dina företag</h1>

      {isLoading && <p className="text-mist-500">Laddar…</p>}
      {error && (
        <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
          Kunde inte hämta dina företag.
        </p>
      )}
      {switchError && (
        <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{switchError}</p>
      )}

      {data && data.companies.length === 0 && (
        <p className="text-mist-500">Inga företag kopplade till det här BankID:t.</p>
      )}

      <div className="space-y-3">
        {data?.companies.map((company) => (
          <button
            key={company.tenantId}
            type="button"
            onClick={() => void openCompany(company.tenantId)}
            className="group flex w-full items-center justify-between rounded-xl border border-ink-100 bg-white p-5 text-left shadow-sm transition hover:border-sienna-400 hover:shadow-md"
          >
            <div className="flex items-center gap-4">
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-ink-900 text-sm font-bold text-sienna-300">
                {company.tenantName.charAt(0).toUpperCase()}
              </span>
              <div>
                <p className="font-medium text-ink-900">{company.tenantName}</p>
                <p className="text-sm text-mist-500">
                  {company.outstandingInvoiceCount === 0
                    ? "Inga obetalda fakturor"
                    : `${company.outstandingInvoiceCount} obetald${company.outstandingInvoiceCount === 1 ? "" : "a"} faktura${company.outstandingInvoiceCount === 1 ? "" : "r"}`}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-medium text-ink-900">{formatSEK(company.outstanding)}</p>
              <p className="text-sm text-mist-400 transition group-hover:text-sienna-600">
                Öppna →
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
