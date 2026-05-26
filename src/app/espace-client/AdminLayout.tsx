import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Outlet } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ScrollToTop } from "../components/ScrollToTop";
import { ShieldAlert, Loader2, LogOut, Eye, EyeOff } from "lucide-react";
import { Toaster } from "sonner";
import { queryClient } from "./queryClient";
import { api } from "./api";
import { SkeletonStyles } from "./Skeleton";

const STORAGE_KEY = "ippoo:admin:session";
type AdminSession = { token: string; username: string; expiresAt: number };

type AdminAuthValue = {
  session: AdminSession | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
};
const AdminAuthCtx = createContext<AdminAuthValue | null>(null);
export function useAdminAuth() {
  const v = useContext(AdminAuthCtx);
  if (!v) throw new Error("useAdminAuth outside provider");
  return v;
}

function loadSession(): AdminSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AdminSession;
    if (!s.token || !s.expiresAt || Date.now() > s.expiresAt) return null;
    return s;
  } catch { return null; }
}

function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AdminSession | null>(() => loadSession());

  useEffect(() => {
    if (!session) return;
    const ms = Math.max(1000, session.expiresAt - Date.now());
    const t = window.setTimeout(() => {
      setSession(null);
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }, ms);
    return () => window.clearTimeout(t);
  }, [session?.expiresAt]);

  const login = async (username: string, password: string) => {
    const res = await api.adminLogin(username, password);
    const next: AdminSession = { token: res.token, username: res.username, expiresAt: res.expiresAt };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
    setSession(next);
  };
  const logout = () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    setSession(null);
  };

  return <AdminAuthCtx.Provider value={{ session, login, logout }}>{children}</AdminAuthCtx.Provider>;
}

function AdminLogin() {
  const { login } = useAdminAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur de connexion");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "linear-gradient(180deg,#0E1320 0%, #1a1f2e 100%)" }}>
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-3xl p-7 shadow-xl">
        <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#FF3B57] to-[#FF7A00] text-white flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h1 className="text-center" style={{ fontSize: "1.35rem", fontWeight: 900 }}>Back office IPPOO</h1>
        <p className="text-center text-[#666] mt-1 mb-6" style={{ fontSize: "0.82rem" }}>
          Accès réservé à l'équipe d'administration.
        </p>

        <label className="block mb-3">
          <span className="block mb-1 text-[#666]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>Identifiant</span>
          <input
            type="text" autoComplete="username" required
            value={username} onChange={(e) => setUsername(e.target.value)}
            className="w-full px-3 py-2.5 rounded-lg border border-black/10"
            style={{ fontSize: "0.9rem" }}
          />
        </label>
        <label className="block mb-4">
          <span className="block mb-1 text-[#666]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>Mot de passe</span>
          <div className="relative">
            <input
              type={show ? "text" : "password"} autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full pl-3 pr-10 py-2.5 rounded-lg border border-black/10"
              style={{ fontSize: "0.9rem" }}
            />
            <button type="button" onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-[#888]" aria-label="Afficher/masquer">
              {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </label>

        {error && (
          <p className="mb-3 px-3 py-2 rounded-lg bg-[#FFE5EB] text-[#C0263A]" style={{ fontSize: "0.8rem" }}>{error}</p>
        )}

        <button type="submit" disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-white disabled:opacity-50"
          style={{ background: "#0E1320", fontSize: "0.9rem", fontWeight: 800 }}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          Connexion
        </button>

        <p className="text-center text-[#888] mt-5" style={{ fontSize: "0.72rem" }}>
          Authentification isolée — aucun lien avec la base des clients.
        </p>
      </form>
    </div>
  );
}

function AdminShell() {
  const { session, logout } = useAdminAuth();
  if (!session) return <AdminLogin />;
  return (
    <div className="min-h-screen bg-[#F5F6FA]">
      <ScrollToTop />
      <header className="bg-[#0E1320] text-white px-4 sm:px-8 py-3 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg,#FF3B57,#FF7A00)" }}>
            <ShieldAlert className="w-4 h-4" />
          </div>
          <div>
            <p style={{ fontSize: "0.95rem", fontWeight: 900, letterSpacing: "-0.01em" }}>IPPOO · Back office</p>
            <p className="text-white/60" style={{ fontSize: "0.7rem" }}>{session.username}</p>
          </div>
        </div>
        <button onClick={logout}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15"
          style={{ fontSize: "0.78rem", fontWeight: 700 }}>
          <LogOut className="w-3.5 h-3.5" /> Déconnexion
        </button>
      </header>
      <main className="px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
        <Outlet />
      </main>
      <Toaster
        position="top-center"
        expand={false}
        gap={8}
        offset={16}
        visibleToasts={3}
        toastOptions={{
          unstyled: true,
          classNames: {
            toast: "ippoo-toast",
            title: "ippoo-toast-title",
            description: "ippoo-toast-desc",
            icon: "ippoo-toast-icon",
            closeButton: "ippoo-toast-close",
          },
        }}
      />
      <SkeletonStyles />
    </div>
  );
}

export function useAdminData<T>(fetcher: (adminToken: string) => Promise<T>) {
  const { session, logout } = useAdminAuth();
  const token = session?.token;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(!!token);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetcher(token);
      setData(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      if (/admin-token/i.test(msg)) logout();
    } finally {
      setLoading(false);
    }
  }, [token, fetcher, logout]);

  useEffect(() => { reload(); }, [reload]);

  return { data, loading, error, reload };
}

export function AdminLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AdminAuthProvider>
        <AdminShell />
      </AdminAuthProvider>
    </QueryClientProvider>
  );
}
