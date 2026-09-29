import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

// Permanent vänstermeny i stället för den tidigare toppheadern (se
// Sidebar.tsx) — "Byt företag" och "Logga ut" bor nu där, inte här.
export function Layout() {
  return (
    <div className="flex min-h-screen bg-cream-50 text-ink-900">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-10 sm:px-10">
        <div className="mx-auto max-w-4xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
