// Samma färgkarta som apps/backoffice/src/components/StatusBadge.tsx —
// portalen visar bara en delmängd av statusarna (aldrig 'draft'), men
// vokabuläret är gemensamt.
//
// "paid"/"delivered" använder Tailwinds vanliga emerald, inte varumärkets
// sienna-accent — semantisk status (bra/dåligt) ska hållas isär från
// varumärkesfärgen, annars läser "betald" inte längre som grönt/positivt.
const COLORS: Record<string, string> = {
  sent: "bg-ink-50 text-ink-700",
  paid: "bg-emerald-100 text-emerald-800",
  overdue: "bg-red-100 text-red-700",
  credited: "bg-mist-100 text-mist-600",
  superseded: "bg-mist-100 text-mist-400",
  settled: "bg-mist-100 text-mist-700",
  none: "bg-mist-100 text-mist-500",
  queued: "bg-amber-100 text-amber-700",
  delivered: "bg-emerald-100 text-emerald-800",
  bounced: "bg-red-100 text-red-700",
  failed: "bg-red-100 text-red-700",
};

export function StatusBadge({ value }: { value: string }) {
  const className = COLORS[value] ?? "bg-mist-100 text-mist-700";
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${className}`}>
      {value}
    </span>
  );
}
