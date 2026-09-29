import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

// Permanent vänstermeny, alltid öppen (inte en hamburgare som fälls ut) —
// samma grundtanke som en klassisk app-shell (Claude, Linear m.fl.): en
// smal, statisk kolumn för de få huvudvyerna, huvudytan används bara för
// innehållet. Delar visuell identitet med apps/backoffice/src/components/
// Sidebar.tsx (samma NAV_LINK_BASE-mönster), men de två är fristående
// filer — portalen och backoffice har olika navigeringspunkter och delar
// ingen kodbas för UI-komponenter.
const NAV_LINK_BASE =
  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition";
const NAV_LINK_INACTIVE = "text-mist-300 hover:bg-ink-800 hover:text-white";
const NAV_LINK_ACTIVE = "bg-ink-800 text-white";

function NavIcon({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="flex h-5 w-5 flex-none items-center justify-center">
      {children}
    </span>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const showBackToCompanies = (user?.companies?.length ?? 0) > 1;

  return (
    <aside className="flex h-screen w-60 flex-none flex-col bg-ink-900 text-white">
      <div className="flex items-center gap-2.5 px-5 py-6">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-white/10 text-sm font-bold text-sienna-300">
          {user?.tenantName?.charAt(0).toUpperCase() ?? "F"}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-white">
            {user?.tenantName ?? "Mina sidor"}
          </div>
          <div className="text-xs text-mist-400">Kundportal</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        <NavLink
          to="/dashboard"
          className={({ isActive }) =>
            `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`
          }
        >
          <NavIcon>◱</NavIcon>
          Översikt
        </NavLink>
        <NavLink
          to="/invoices"
          className={({ isActive }) =>
            `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`
          }
        >
          <NavIcon>▤</NavIcon>
          Fakturor
        </NavLink>
        <NavLink
          to="/profile"
          className={({ isActive }) =>
            `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`
          }
        >
          <NavIcon>◍</NavIcon>
          Profil
        </NavLink>
        {showBackToCompanies && (
          <NavLink
            to="/companies"
            className={({ isActive }) =>
              `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`
            }
          >
            <NavIcon>⇄</NavIcon>
            Byt företag
          </NavLink>
        )}
      </nav>

      <div className="border-t border-white/10 px-3 py-4">
        {user?.email && (
          <div className="mb-2 truncate px-3 text-xs text-mist-400">{user.email}</div>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-mist-300 transition hover:bg-ink-800 hover:text-white"
        >
          <NavIcon>⏻</NavIcon>
          Logga ut
        </button>
      </div>
    </aside>
  );
}
