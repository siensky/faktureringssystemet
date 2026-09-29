import { useNavigate } from "react-router-dom";

// Landningssida efter en lyckad BankID-signering som INTE gav något
// sessions-token — identiteten finns nu (services/auth/src/bankid/
// services.ts skapar den alltid), men är inte länkad till något företag
// än. Ingen RequireAuth/Layout här: det finns uppriktigt ingen tenant att
// vara inloggad "i". Den dagen ett företag lägger till personen som kund
// och hen loggar in med BankID igen hittar samma identitet den nya
// länken automatiskt, och en riktig session utfärdas.
export function NoCompanyPage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-cream-50 to-cream-100 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-8 text-center shadow-lg shadow-ink-900/5">
        <div className="mx-auto mb-6 flex h-10 w-10 items-center justify-center rounded-xl bg-ink-900">
          <span className="text-sm font-bold text-sienna-300">F</span>
        </div>
        <h1 className="mb-2 text-xl font-semibold tracking-tight text-ink-900">
          Inga utgifter just nu
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-mist-500">
          Du är identifierad med BankID, men inget företag i systemet har registrerat dig som kund
          än. Så fort ett företag lägger till dig dyker dina fakturor upp automatiskt nästa gång du
          loggar in — du behöver inte göra något mer nu.
        </p>
        <button
          type="button"
          onClick={() => navigate("/login/bankid")}
          className="w-full rounded-md bg-ink-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-ink-800"
        >
          Tillbaka till inloggningen
        </button>
      </div>
    </div>
  );
}
