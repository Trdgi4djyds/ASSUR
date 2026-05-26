import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { projectId, publicAnonKey } from "../../../utils/supabase/info";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(`https://${projectId}.supabase.co`, publicAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}

export const API_BASE = `https://${projectId}.supabase.co/functions/v1/make-server-752d1a39`;

export async function apiFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null; adminToken?: string | null } = {},
): Promise<T> {
  const { method = "GET", body, token, adminToken } = opts;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${publicAnonKey}`,
  };
  if (token) headers["X-User-Token"] = token;
  if (adminToken) headers["X-Admin-Token"] = adminToken;
  const url = `${API_BASE}${path}`;
  console.debug(`[apiFetch v2] ${method} ${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      mode: "cors",
      credentials: "omit",
    });
  } catch (networkErr) {
    const detail = networkErr instanceof Error ? networkErr.message : String(networkErr);
    console.error(`[apiFetch v2] Network failure ${method} ${url}: ${detail}`);
    throw new Error(`[v2] Réseau KO sur ${method} ${path}: ${detail}`);
  }
  let text = "";
  try {
    text = await res.text();
  } catch (readErr) {
    const detail = readErr instanceof Error ? readErr.message : String(readErr);
    console.error(`Failed reading response body for ${method} ${API_BASE}${path}: ${detail}`);
    throw new Error(`Réponse illisible du serveur (${method} ${path}): ${detail}`);
  }
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const message = (data && data.error) || `HTTP ${res.status}`;
    if (res.status === 401 && token && /auth session missing|invalid-token|expired|missing-token/i.test(message)) {
      try { await getSupabase().auth.signOut(); } catch { /* ignore */ }
    } else {
      console.error(`API ${method} ${path} failed (${res.status}): ${message}`, data);
    }
    throw new Error(message);
  }
  return data as T;
}
