import type { RecurrenceInterval } from "@faktura/contracts";
import { useQuery } from "@tanstack/react-query";
import { type MouseEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import * as templatesApi from "../api/invoice-templates";
import * as invoicesApi from "../api/invoices";
import { StatusBadge } from "../components/StatusBadge";
import { toDateOnly } from "../lib/date";
import { formatSEK } from "../lib/money";

const INTERVAL_LABELS: Record<RecurrenceInterval, string> = {
  monthly: "månadsvis",
  quarterly: "kvartalsvis",
  yearly: "årsvis",
};

// Ingen länk renderas i förväg — en signerad URL är en bärartoken
// (domain.md #19) och hämtas färsk först när kunden faktiskt klickar,
// precis som samma knapp på InvoiceDetailPage. stopPropagation: knappen
// sitter inne i en hel klickbar rad (se InvoicesPage nedan) och ska inte
// trigga radens egen navigering till detaljsidan.
function PdfButton({ invoiceId }: { invoiceId: number }) {
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openPdf(event: MouseEvent) {
    event.stopPropagation();
    setError(null);
    setIsOpening(true);
    try {
      const { url } = await invoicesApi.getInvoicePdfUrl(invoiceId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? "PDF:en är inte klar än."
          : "Kunde inte hämta PDF:en.",
      );
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={(event) => void openPdf(event)}
        disabled={isOpening}
        className="rounded-md border border-ink-100 px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:border-ink-300 hover:bg-ink-50 disabled:opacity-50"
      >
        {isOpening ? "Öppnar…" : "PDF"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}

export function InvoicesPage() {
  const navigate = useNavigate();
  const { data: summary } = useQuery({
    queryKey: ["account-summary"],
    queryFn: invoicesApi.getAccountSummary,
  });
  const { data: invoices, isLoading } = useQuery({
    queryKey: ["invoices"],
    queryFn: invoicesApi.listInvoices,
  });
  const { data: templates } = useQuery({
    queryKey: ["invoice-templates"],
    queryFn: templatesApi.listInvoiceTemplates,
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink-900">Mina fakturor</h1>

      {summary && (
        <div className="mb-6 flex items-center gap-4 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-ink-900">
            <span className="text-base font-bold text-sienna-300">kr</span>
          </div>
          <div>
            <div className="text-sm text-mist-500">Utestående skuld</div>
            <div className="text-2xl font-semibold text-ink-900">
              {formatSEK(summary.outstanding)}
            </div>
            <div className="text-sm text-mist-500">
              {summary.outstandingInvoiceCount === 1
                ? "1 obetald faktura"
                : `${summary.outstandingInvoiceCount} obetalda fakturor`}
            </div>
          </div>
        </div>
      )}

      {templates && templates.length > 0 && (
        <div className="mb-6 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-ink-900">Återkommande fakturor</h2>
          <ul className="divide-y divide-ink-50">
            {templates.map((template) => (
              <li key={template.id} className="flex items-center justify-between py-2 text-sm">
                <span className="text-mist-600">
                  {formatSEK(template.totalInclVat)} {INTERVAL_LABELS[template.interval]}
                </span>
                <span className="text-mist-500">
                  Nästa faktura {toDateOnly(template.nextGenerationDate)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-ink-100 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-ink-100 text-left text-mist-500">
            <tr>
              <th className="px-4 py-3 font-medium">Fakturanr</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Förfaller</th>
              <th className="px-4 py-3 text-right font-medium">Belopp</th>
              <th className="px-4 py-3 text-right font-medium" />
              <th className="w-8 px-2 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-mist-400">
                  Laddar…
                </td>
              </tr>
            )}
            {!isLoading && invoices?.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-mist-400">
                  Inga fakturor än.
                </td>
              </tr>
            )}
            {invoices?.map((invoice) => (
              <tr
                key={invoice.id}
                tabIndex={0}
                onClick={() => navigate(`/invoices/${invoice.id}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") navigate(`/invoices/${invoice.id}`);
                }}
                className="group cursor-pointer border-b border-ink-50 transition last:border-0 hover:bg-sienna-50/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-400"
              >
                <td className="px-4 py-4">
                  <span className="font-medium text-ink-900 underline decoration-mist-300 decoration-1 underline-offset-4 group-hover:decoration-ink-900">
                    {invoice.invoiceNumber}
                  </span>
                </td>
                <td className="px-4 py-4">
                  <StatusBadge value={invoice.status} />
                </td>
                <td className="px-4 py-4 text-mist-600">{toDateOnly(invoice.dateDue)}</td>
                <td className="px-4 py-4 text-right font-medium text-ink-900">
                  {formatSEK(invoice.totalInclVat)}
                </td>
                <td className="px-4 py-4 text-right">
                  <PdfButton invoiceId={invoice.id} />
                </td>
                <td className="px-2 py-4 text-mist-300 transition group-hover:translate-x-0.5 group-hover:text-sienna-600">
                  →
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
