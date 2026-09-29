import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

// Permanent vänstermeny, alltid öppen — samma mönster som
// apps/portal/src/components/Sidebar.tsx (se den filens kommentar), egen
// fristående fil eftersom de två apparna har olika navigeringspunkter.
const NAV_ITEMS = [
  { to: "/invoices", label: "Fakturor", icon: "▤" },
  { to: "/invoice-templates", label: "Återkommande", icon: "↻" },
  { to: "/customers", label: "Kunder", icon: "◍" },
  { to: "/deliveries", label: "Leveranser", icon: "✉" },
  { to: "/payments/unmatched", label: "Betalningar", icon: "kr" },
];

const NAV_LINK_BASE =
  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition";
const NAV_LINK_INACTIVE = "text-mist-300 hover:bg-ink-800 hover:text-white";
const NAV_LINK_ACTIVE = "bg-ink-800 text-white";

export function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="flex h-screen w-60 flex-none flex-col bg-ink-900 text-white">
      <div className="flex items-center gap-2.5 px-5 py-6">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-white/10 text-sm font-bold text-sienna-300">
          {user?.tenantName?.charAt(0).toUpperCase() ?? "F"}
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-white">
            {user?.tenantName ?? "Backoffice"}
          </div>
          <div className="text-xs text-mist-400">Backoffice</div>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `${NAV_LINK_BASE} ${isActive ? NAV_LINK_ACTIVE : NAV_LINK_INACTIVE}`
            }
          >
            <span aria-hidden="true" className="flex h-5 w-5 flex-none items-center justify-center">
              {item.icon}
            </span>
            {item.label}
          </NavLink>
        ))}
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
          <span aria-hidden="true" className="flex h-5 w-5 flex-none items-center justify-center">
            ⏻
          </span>
          Logga ut
        </button>
      </div>
    </aside>
  );
}
