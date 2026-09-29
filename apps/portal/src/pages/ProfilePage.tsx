import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function ProfilePage() {
  const { user } = useAuth();

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink-900">Profil</h1>
      <div className="max-w-md rounded-xl border border-ink-100 bg-white p-6 shadow-sm">
        <dl className="divide-y divide-ink-50 text-sm">
          {user?.customerName && (
            <div className="flex items-center justify-between py-3">
              <dt className="text-mist-500">Namn</dt>
              <dd className="font-medium text-ink-900">{user.customerName}</dd>
            </div>
          )}
          <div className="flex items-center justify-between py-3">
            <dt className="text-mist-500">Företag</dt>
            <dd className="font-medium text-ink-900">{user?.tenantName}</dd>
          </div>
          {/* BankID-kundidentiteter har email: null — inget fält alls då i stället för ett tomt. */}
          {user?.email && (
            <div className="flex items-center justify-between py-3">
              <dt className="text-mist-500">E-post</dt>
              <dd className="font-medium text-ink-900">{user.email}</dd>
            </div>
          )}
          <div className="flex items-center justify-between py-3">
            <dt className="text-mist-500">Inloggningssätt</dt>
            <dd className="font-medium text-ink-900">{user?.email ? "Lösenord" : "BankID"}</dd>
          </div>
        </dl>
      </div>

      {(user?.companies?.length ?? 0) > 1 && (
        <p className="mt-4 text-sm text-mist-500">
          Du är kund hos flera företag.{" "}
          <Link to="/companies" className="font-medium text-ink-700 hover:underline">
            Byt företag
          </Link>
          .
        </p>
      )}
    </div>
  );
}
