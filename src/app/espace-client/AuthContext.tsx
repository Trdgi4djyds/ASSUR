import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabase, apiFetch } from "./supabaseClient";

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; name: string; phone?: string; profile?: Record<string, any> }) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const supabase = getSupabase();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null);
      setLoading(false);
    }).catch((err) => {
      console.error("Auth getSession error in AuthProvider initial load:", err);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => { sub.subscription.unsubscribe(); };
  }, [supabase]);

  // Session timeout: sign out after 30 min of inactivity
  useEffect(() => {
    if (!session) return;
    const TIMEOUT = 30 * 60 * 1000;
    let timer: number;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        console.log("Auto sign-out after 30 min inactivity");
        supabase.auth.signOut().catch((err) => console.error("Auto signOut failed:", err));
      }, TIMEOUT);
    };
    const events = ["mousemove", "keydown", "touchstart", "click", "scroll"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [session, supabase]);

  const value = useMemo<AuthContextValue>(() => ({
    user: session?.user ?? null,
    session,
    loading,
    async signIn(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.error(`signIn error for ${email}:`, error.message);
        throw new Error(error.message);
      }
    },
    async signUp({ email, password, name, phone, profile }) {
      await apiFetch("/signup", { method: "POST", body: { email, password, name, phone, profile } });
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        console.error(`Post-signup auto signIn failed for ${email}:`, error.message);
        throw new Error(error.message);
      }
    },
    async signOut() {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error("signOut error:", error.message);
        throw new Error(error.message);
      }
    },
  }), [session, loading, supabase]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être appelé dans AuthProvider");
  return ctx;
}
