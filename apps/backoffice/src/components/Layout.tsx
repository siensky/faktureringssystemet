import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";

// Permanent vänstermeny i stället för den tidigare toppheadern — se
// Sidebar.tsx. Sidornas eget innehåll (InvoicesPage m.fl.) är oförändrat,
// bara skalet runt dem.
export function Layout() {
  return (
    <div className="flex min-h-screen bg-cream-50 text-ink-900">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto px-8 py-8 sm:px-10">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
