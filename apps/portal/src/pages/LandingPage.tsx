import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const FEATURES = [
  {
    title: "Skicka fakturor",
    body: "Moms, belopp och OCR-nummer räknas fram automatiskt. Skickad är skickad — ändras aldrig i efterhand.",
  },
  {
    title: "Betalningar matchas själva",
    body: "Inkommande bankbetalningar kopplas till rätt faktura via OCR-referensen, utan manuellt arbete för det vanliga fallet.",
  },
  {
    title: "Påminnelser sköter sig",
    body: "Förfallna fakturor bevakas automatiskt och en påminnelse med avgift skickas ut, utan att någon behöver hålla koll.",
  },
  {
    title: "Kundportal med BankID",
    body: "Era kunder loggar in med BankID eller lösenord, ser sina fakturor och betalar direkt — separat från er egen backoffice.",
  },
];

// Publik startsida, innan inloggning — ligger på "/", utanför RequireAuth
// (App.tsx). Redirectar SJÄLV vidare till /dashboard om besökaren redan
// är inloggad, se effekten nedan.
export function LandingPage() {
  const { status } = useAuth();
  const navigate = useNavigate();

  // Redan inloggad och hamnar ändå på "/": in i appen direkt i stället
  // för att visa marknadsföringssidan för någon som redan är kund.
  useEffect(() => {
    if (status === "authenticated") navigate("/dashboard", { replace: true });
  }, [status, navigate]);

  return (
    <div className="min-h-screen bg-cream-50 text-ink-900">
      <header className="border-b border-ink-100 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-900 text-sm font-bold text-sienna-300">
              F
            </span>
            <span className="text-base font-semibold tracking-tight text-ink-900">Faktura</span>
          </div>
          <nav className="hidden items-center gap-8 text-sm font-medium text-mist-600 sm:flex">
            <a href="#produkt" className="transition hover:text-ink-900">
              Produkten
            </a>
            <a href="#kunder" className="transition hover:text-ink-900">
              För era kunder
            </a>
          </nav>
          <Link
            to="/login"
            className="rounded-md bg-sienna-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sienna-600"
          >
            Logga in
          </Link>
        </div>
      </header>

      <section className="bg-ink-900">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 lg:grid-cols-2 lg:py-32">
          <div>
            <p className="mb-4 text-sm font-semibold tracking-wide text-sienna-300 uppercase">
              Fakturering för svenska företag
            </p>
            <h1 className="mb-6 text-4xl leading-tight font-semibold tracking-tight text-white sm:text-5xl">
              Fakturering som sköter sig själv
            </h1>
            <p className="mb-8 max-w-md text-lg leading-relaxed text-mist-300">
              Skicka fakturor, låt betalningar matchas automatiskt och sluta jaga förfallna belopp
              för hand. Byggt för företag som vill ägna tiden åt annat än bokföring.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <Link
                to="/login"
                className="rounded-md bg-sienna-500 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-sienna-600"
              >
                Logga in på ditt konto
              </Link>
              <a
                href="#produkt"
                className="text-sm font-medium text-mist-300 underline-offset-4 transition hover:text-white hover:underline"
              >
                Se hur det fungerar →
              </a>
            </div>
          </div>

          {/* Dekorativ fakturamockup — inte en riktig faktura, bara en
              illustration av produkten för hero-ytan. */}
          <div className="rounded-2xl border border-white/10 bg-ink-800/60 p-6 shadow-2xl backdrop-blur-sm">
            <div className="rounded-xl bg-white p-6 shadow-lg">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium tracking-wide text-mist-400 uppercase">
                    Faktura #1042
                  </div>
                  <div className="text-lg font-semibold text-ink-900">Byggfirman Nord AB</div>
                </div>
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                  betald
                </span>
              </div>
              <div className="space-y-2 border-t border-ink-50 pt-4 text-sm">
                <div className="flex justify-between text-mist-500">
                  <span>Snickeriarbete, kök</span>
                  <span>32 000,00 kr</span>
                </div>
                <div className="flex justify-between text-mist-500">
                  <span>Material</span>
                  <span>11 500,00 kr</span>
                </div>
              </div>
              <div className="mt-4 flex justify-between border-t border-ink-100 pt-4 text-base font-semibold text-ink-900">
                <span>Totalt</span>
                <span>54 375,00 kr</span>
              </div>
            </div>
            <p className="mt-4 text-center text-xs text-mist-400">
              Matchad mot inbetalning automatiskt via OCR — inget manuellt arbete
            </p>
          </div>
        </div>
      </section>

      <section id="produkt" className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="mb-2 text-sm font-semibold tracking-wide text-sienna-600 uppercase">
          Vad appen gör
        </h2>
        <p className="mb-12 max-w-xl text-2xl font-semibold tracking-tight text-ink-900">
          Allt från fakturan skickas till pengarna är bokförda, på ett ställe.
        </p>
        <div className="grid gap-6 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-ink-100 bg-white p-6 shadow-sm"
            >
              <h3 className="mb-2 text-base font-semibold text-ink-900">{feature.title}</h3>
              <p className="text-sm leading-relaxed text-mist-500">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="kunder" className="border-t border-ink-100 bg-white">
        <div className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <h2 className="mb-4 text-2xl font-semibold tracking-tight text-ink-900">
                En egen portal för era kunder
              </h2>
              <p className="mb-6 leading-relaxed text-mist-500">
                Era kunder loggar in med BankID eller lösenord i en portal som är helt separat från
                er backoffice, ser vad de är skyldiga, och betalar direkt via Stripe. En
                privatperson som handlar hos flera av era kollegor i systemet loggar in en gång och
                ser allt.
              </p>
              <Link
                to="/login"
                className="inline-block rounded-md border border-ink-200 px-5 py-2.5 text-sm font-medium text-ink-700 transition hover:border-ink-400 hover:bg-ink-50"
              >
                Logga in
              </Link>
            </div>
            <div className="rounded-xl border border-ink-100 bg-cream-50 p-6">
              <div className="mb-4 flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink-900 text-sm font-bold text-sienna-300">
                  E
                </span>
                <div>
                  <div className="text-sm font-semibold text-ink-900">Erik Lindqvist</div>
                  <div className="text-xs text-mist-400">Inloggad med BankID</div>
                </div>
              </div>
              <div className="rounded-lg bg-white p-4 shadow-sm">
                <div className="text-xs text-mist-400">Utestående skuld</div>
                <div className="text-xl font-semibold text-ink-900">11 875,00 kr</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-100 bg-cream-50">
        <div className="mx-auto max-w-6xl px-6 py-8 text-sm text-mist-400">Faktura</div>
      </footer>
    </div>
  );
}
