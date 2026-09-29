import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(email, password);
      navigate("/invoices", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Något gick fel");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-cream-50 to-cream-100 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-ink-100 bg-white p-8 shadow-lg shadow-ink-900/5"
      >
        <div className="mb-6 flex h-10 w-10 items-center justify-center rounded-xl bg-ink-900">
          <span className="text-sm font-bold text-sienna-300">F</span>
        </div>
        <h1 className="mb-6 text-xl font-semibold tracking-tight text-ink-900">
          Backoffice — logga in
        </h1>
        {error && <p className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <label className="mb-3 block text-sm font-medium text-ink-700">
          E-post
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-md border border-ink-100 px-3 py-2 text-sm text-ink-900 focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-400"
          />
        </label>
        <label className="mb-6 block text-sm font-medium text-ink-700">
          Lösenord
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-md border border-ink-100 px-3 py-2 text-sm text-ink-900 focus:border-ink-400 focus:outline-none focus:ring-1 focus:ring-ink-400"
          />
        </label>
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-md bg-ink-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-ink-800 disabled:opacity-50"
        >
          {isSubmitting ? "Loggar in…" : "Logga in"}
        </button>
      </form>
    </div>
  );
}
