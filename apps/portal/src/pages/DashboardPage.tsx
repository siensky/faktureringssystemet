import type { RecurrenceInterval } from "@faktura/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
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

// Landningssidan efter inloggning (ersätter InvoicesPage i den rollen —
// den fullständiga fakturalistan bor nu på /invoices). Bygger uteslutande
// på data som redan hämtas för InvoicesPage (samma tre anrop), bara
// grupperad om till förfallna/kommande/historik i stället för en enda
// lång tabell — inget nytt API-anrop, ingen ändring i backend.
export function DashboardPage() {
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

  const overdue = (invoices ?? [])
    .filter((i) => i.status === "overdue")
    .sort((a, b) => a.dateDue.localeCompare(b.dateDue));
  const upcoming = (invoices ?? [])
    .filter((i) => i.status === "sent")
    .sort((a, b) => a.dateDue.localeCompare(b.dateDue));
  const history = (invoices ?? [])
    .filter((i) => i.status === "paid" || i.status === "settled" || i.status === "credited")
    .sort((a, b) => b.dateIssued.localeCompare(a.dateIssued))
    .slice(0, 5);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink-900">Översikt</h1>

      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        <div className="flex items-center gap-4 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-ink-900">
            <span className="text-base font-bold text-sienna-300">kr</span>
          </div>
          <div>
            <div className="text-sm text-mist-500">Utestående skuld</div>
            <div className="text-2xl font-semibold text-ink-900">
              {formatSEK(summary?.outstanding ?? 0)}
            </div>
            <div className="text-sm text-mist-500">
              {(summary?.outstandingInvoiceCount ?? 0) === 1
                ? "1 obetald faktura"
                : `${summary?.outstandingInvoiceCount ?? 0} obetalda fakturor`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 flex-none items-center justify-center rounded-full bg-red-50">
            <span className="text-base font-bold text-red-600">!</span>
          </div>
          <div>
            <div className="text-sm text-mist-500">Förfallna fakturor</div>
            <div className="text-2xl font-semibold text-ink-900">{overdue.length}</div>
            <div className="text-sm text-mist-500">
              {overdue.length === 0 ? "Allt i sin ordning" : "Kräver din uppmärksamhet"}
            </div>
          </div>
        </div>
      </div>

      {isLoading && <p className="text-mist-400">Laddar…</p>}

      {!isLoading && overdue.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-ink-900">Förfallna</h2>
          <InvoiceList invoices={overdue} />
        </section>
      )}

      {!isLoading && (
        <section className="mb-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <h2 className="text-sm font-semibold text-ink-900">Kommande</h2>
            <Link
              to="/invoices"
              className="text-sm font-medium whitespace-nowrap text-ink-700 hover:underline"
            >
              Alla fakturor →
            </Link>
          </div>
          {upcoming.length === 0 && templates?.length === 0 && (
            <p className="rounded-xl border border-ink-100 bg-white p-5 text-sm text-mist-400 shadow-sm">
              Inga kommande fakturor just nu.
            </p>
          )}
          {upcoming.length > 0 && <InvoiceList invoices={upcoming} />}
          {templates && templates.length > 0 && (
            <div className="mt-3 rounded-xl border border-ink-100 bg-white p-5 shadow-sm">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-mist-500">
                Återkommande
              </h3>
              <ul className="divide-y divide-ink-50">
                {templates.map((template) => (
                  <li key={template.id} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-mist-600">
                      {formatSEK(template.totalInclVat)} {INTERVAL_LABELS[template.interval]}
                    </span>
                    <span className="text-mist-500">
                      Nästa {toDateOnly(template.nextGenerationDate)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {!isLoading && history.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-900">Senaste historik</h2>
          <InvoiceList invoices={history} />
        </section>
      )}
    </div>
  );
}

function InvoiceList({
  invoices,
}: {
  invoices: Array<{
    id: number;
    invoiceNumber: number | null;
    status: string;
    dateDue: string;
    totalInclVat: number;
  }>;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-ink-100 bg-white shadow-sm">
      <table className="w-full text-sm">
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id}>
              <td className="w-0 px-4 py-3 whitespace-nowrap">
                <Link
                  to={`/invoices/${invoice.id}`}
                  className="font-medium text-ink-900 underline decoration-mist-300 decoration-1 underline-offset-4 hover:decoration-ink-900"
                >
                  {invoice.invoiceNumber}
                </Link>
              </td>
              <td className="px-4 py-3">
                <StatusBadge value={invoice.status} />
              </td>
              <td className="px-4 py-3 text-mist-600">{toDateOnly(invoice.dateDue)}</td>
              <td className="px-4 py-3 text-right font-medium text-ink-900">
                {formatSEK(invoice.totalInclVat)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
