import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { AcceptInvitePage } from "./pages/AcceptInvitePage";
import { BankIdLoginPage } from "./pages/BankIdLoginPage";
import { CompaniesPage } from "./pages/CompaniesPage";
import { DashboardPage } from "./pages/DashboardPage";
import { InvoiceDetailPage } from "./pages/InvoiceDetailPage";
import { InvoicesPage } from "./pages/InvoicesPage";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { NoCompanyPage } from "./pages/NoCompanyPage";
import { ProfilePage } from "./pages/ProfilePage";

export function App() {
  return (
    <Routes>
      {/* Publik startsida — inte bakom RequireAuth. Redirectar SJÄLV till
          /dashboard om besökaren redan är inloggad (LandingPage.tsx), så
          "/" fungerar som ingång oavsett inloggningsstatus. */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/login/bankid" element={<BankIdLoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      {/* Ingen session utfärdas hit (services/auth/src/bankid/services.ts,
          status "no_company") — därför utanför RequireAuth. */}
      <Route path="/no-company" element={<NoCompanyPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          {/* Bara meningsfull för en BankID-kundidentitet med länkade
              företag — en lösenordskund kan öppna den, men ser bara sitt
              eget (aktuella) företag i listan via /auth/companies/overview. */}
          <Route path="/companies" element={<CompaniesPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
