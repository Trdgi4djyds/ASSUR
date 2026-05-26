import { Hono } from "npm:hono";
import { cors } from "npm:hono/cors";
import { logger } from "npm:hono/logger";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "npm:@simplewebauthn/server@10";
import * as kv from "./kv_store.tsx";
import {
  parseBody,
  SignupSchema, ProfileUpdateSchema, ClaimCreateSchema, PaymentLegacySchema,
  PaymentInitiateSchema, BeneficiaryCreateSchema, MessageCreateSchema, MessageEditSchema,
  SubscribeSchema, SettingsUpdateSchema, ChangePasswordSchema, RenewContractSchema,
} from "./validators.ts";

const app = new Hono();
app.use("*", logger(console.log));
app.use(
  "/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "X-User-Token", "x-user-token", "X-Admin-Token", "x-admin-token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
  }),
);

const PREFIX = "/make-server-752d1a39";
const BUCKET = "make-752d1a39-claims";
const MSG_BUCKET = "make-752d1a39-messages";
const MSG_MAX_BYTES = 10 * 1024 * 1024;
const MSG_ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/pdf|audio\/(mpeg|mp4|webm|ogg|wav)|video\/(mp4|webm|quicktime)|text\/plain)$/i;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Realtime broadcast helper (server -> client) via Supabase Broadcast REST.
// Used to push chat events instantly without client polling.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
async function broadcast(topic: string, event: string, payload: unknown) {
  try {
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
    });
    if (!res.ok) console.log(`broadcast ${topic}/${event} failed: ${res.status}`);
  } catch (err) {
    console.log(`broadcast ${topic}/${event} error: ${err}`);
  }
}

// Idempotent bucket creation
(async () => {
  try {
    const { data: buckets } = await admin.storage.listBuckets();
    if (!buckets?.some((b) => b.name === BUCKET)) {
      await admin.storage.createBucket(BUCKET, { public: false });
      console.log(`Created storage bucket ${BUCKET}`);
    }
    if (!buckets?.some((b) => b.name === MSG_BUCKET)) {
      await admin.storage.createBucket(MSG_BUCKET, { public: false });
      console.log(`Created storage bucket ${MSG_BUCKET}`);
    }
  } catch (err) {
    console.log(`Bucket init error: ${err}`);
  }
})();

// Admin auth is COMPLETELY SEPARATE from user auth. Credentials live in
// env vars (ADMIN_USERNAME / ADMIN_PASSWORD). Successful login returns an
// HMAC-signed token sent back in the X-Admin-Token header. Admin identity
// is NEVER tied to the Supabase users table — strict isolation by design.
const ADMIN_USERNAME = (Deno.env.get("ADMIN_USERNAME") ?? "").trim();
const ADMIN_PASSWORD = (Deno.env.get("ADMIN_PASSWORD") ?? "").trim();
const ADMIN_TOKEN_TTL_SEC = 60 * 60 * 8; // 8h

async function requireAdminToken(c: any) {
  const token = c.req.header("X-Admin-Token") ?? c.req.header("x-admin-token");
  if (!token) return { admin: null, error: "missing-admin-token", status: 401 as const };
  const payload = await verifyToken<{ kind: string; username: string; exp: number }>(token);
  if (!payload || payload.kind !== "admin") return { admin: null, error: "invalid-admin-token", status: 401 as const };
  if (Date.now() / 1000 > payload.exp) return { admin: null, error: "expired-admin-token", status: 401 as const };
  return { admin: { username: payload.username }, error: null, status: 200 as const };
}

async function requireUser(c: any) {
  // Prefer X-User-Token (set by client) so the platform-level Authorization
  // header can stay as the anon key (required when asymmetric JWTs are on).
  const userToken =
    c.req.header("X-User-Token") ??
    c.req.header("x-user-token") ??
    c.req.header("Authorization")?.split(" ")[1];
  if (!userToken) return { user: null, error: "missing-token" };
  const { data, error } = await admin.auth.getUser(userToken);
  if (error || !data.user) return { user: null, error: error?.message ?? "invalid-token" };
  return { user: data.user, error: null };
}

const k = {
  profile: (uid: string) => `profile:${uid}`,
  contracts: (uid: string) => `contracts:${uid}`,
  claims: (uid: string) => `claims:${uid}`,
  payments: (uid: string) => `payments:${uid}`,
  beneficiaries: (uid: string) => `beneficiaries:${uid}`,
  documents: (uid: string) => `documents:${uid}`,
  notifications: (uid: string) => `notifications:${uid}`,
  messages: (uid: string) => `messages:${uid}`,
  settings: (uid: string) => `settings:${uid}`,
  audit: (uid: string) => `audit:${uid}`,
  rate: (key: string) => `rate:${key}`,
  referralCode: (uid: string) => `referral:code:${uid}`,
  referralByCode: (code: string) => `referral:bycode:${code}`,
  referralRedemptions: (uid: string) => `referral:redemptions:${uid}`,
  accountDeletion: (uid: string) => `account:deletion:${uid}`,
  memberByNumber: (mn: string) => `member:bynum:${mn}`,
  conversationMeta: (uid: string) => `conv:meta:${uid}`,
  emailToUid: (email: string) => `email:${email.toLowerCase()}`,
  webauthnCreds: (uid: string) => `webauthn:creds:${uid}`,
  webauthnChallenge: (key: string) => `webauthn:chal:${key}`,
  hmacSecret: () => `system:hmac:secret`,
  promos: () => `system:promos`,
  partners: () => `system:partners`,
  site: () => `system:site`,
  pushSubs: (uid: string) => `push:subs:${uid}`,
};

// --- HMAC signing for QR tokens ---
const enc = new TextEncoder();
const dec = new TextDecoder();
function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
let cachedHmacKey: CryptoKey | null = null;
async function getHmacKey(): Promise<CryptoKey> {
  if (cachedHmacKey) return cachedHmacKey;
  let secret = await kv.get(k.hmacSecret());
  if (!secret) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    secret = b64urlEncode(buf);
    await kv.set(k.hmacSecret(), secret);
  }
  cachedHmacKey = await crypto.subtle.importKey(
    "raw", b64urlDecode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
  );
  return cachedHmacKey;
}
async function signToken(payload: Record<string, any>): Promise<string> {
  const key = await getHmacKey();
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}
async function verifyToken<T = any>(token: string): Promise<T | null> {
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const key = await getHmacKey();
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), enc.encode(body));
    if (!ok) return null;
    return JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

// --- Unique immutable member number ---
function randomMemberNumber(): string {
  let n = "";
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  for (const b of buf) n += String(b % 10);
  return `${n.slice(0, 4)}-${n.slice(4, 8)}-${n.slice(8, 10)}`;
}
async function assignMemberNumber(uid: string): Promise<string> {
  for (let i = 0; i < 12; i++) {
    const candidate = randomMemberNumber();
    if (!(await kv.get(k.memberByNumber(candidate)))) {
      await kv.set(k.memberByNumber(candidate), uid);
      return candidate;
    }
  }
  throw new Error("Impossible d'attribuer un numéro de membre unique");
}

const WEBAUTHN_RP_NAME = "IPPOO Assurance";
function webauthnContext(c: any) {
  const originHeader = c.req.header("origin") ?? c.req.header("Origin") ?? "";
  const envOrigin = Deno.env.get("WEBAUTHN_ORIGIN");
  const envRpId = Deno.env.get("WEBAUTHN_RP_ID");
  let origin = envOrigin || originHeader || "https://localhost";
  let rpID = envRpId || "localhost";
  try {
    const u = new URL(origin);
    if (!envRpId) rpID = u.hostname;
  } catch {}
  return { origin, rpID };
}

async function audit(uid: string, action: string, meta: Record<string, any> = {}) {
  try {
    const list = (await kv.get(k.audit(uid))) ?? [];
    list.unshift({
      id: `a_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action,
      meta,
      at: new Date().toISOString(),
    });
    await kv.set(k.audit(uid), list.slice(0, 200));
  } catch (err) {
    console.log(`Audit log error for ${uid}/${action}: ${err}`);
  }
}

// Returns true when allowed; false when over limit. Window is rolling N seconds.
async function rateLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const existing = (await kv.get(k.rate(key))) ?? { count: 0, resetAt: now + windowSec * 1000 };
  if (now > existing.resetAt) {
    await kv.set(k.rate(key), { count: 1, resetAt: now + windowSec * 1000 });
    return true;
  }
  if (existing.count >= max) return false;
  await kv.set(k.rate(key), { count: existing.count + 1, resetAt: existing.resetAt });
  return true;
}

// Inline guard used at the top of sensitive routes. Returns a Response when
// over limit (so callers do `const limited = await guardRate(...); if (limited) return limited;`)
// or null when allowed.
async function guardRate(
  c: any,
  scope: string,
  id: string,
  max: number,
  windowSec: number,
  message = "Trop de requêtes, réessayez plus tard.",
): Promise<Response | null> {
  const allowed = await rateLimit(`${scope}:${id}`, max, windowSec);
  if (allowed) return null;
  return c.json({ error: message }, 429);
}

function makeReferralCode(name: string) {
  const base = (name || "IPPOO").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4).padEnd(4, "X");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}-${rand}`;
}

function notify(notifications: any[], title: string, body: string, type = "info", to?: string) {
  notifications.unshift({
    id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title,
    body,
    type,
    read: false,
    createdAt: new Date().toISOString(),
    ...(to ? { to } : {}),
  });
  return notifications.slice(0, 50);
}

function formatXOFInt(n: number) {
  return `${Math.round(n).toLocaleString("fr-FR")} F CFA`;
}

// Apply payment-confirmation side effects based on the payment's `purpose`.
// Called exactly once per successful payment (from webhook or sandbox confirm).
async function applyPaymentSideEffects(userId: string, payment: any) {
  const purpose = payment?.purpose ?? "cotisation";
  const notifs = ((await kv.get(k.notifications(userId))) ?? []) as any[];
  try {
    if (purpose === "renewal" && payment.contractId) {
      const contracts = ((await kv.get(k.contracts(userId))) ?? []) as any[];
      const idx = contracts.findIndex((ct: any) => ct.id === payment.contractId);
      if (idx !== -1) {
        const ct = contracts[idx];
        const baseEnd = Math.max(Date.now(), new Date(ct.endDate).getTime());
        const newEnd = new Date(baseEnd + 365 * 86400000).toISOString();
        contracts[idx] = { ...ct, status: "active", endDate: newEnd, renewalNoticeSent: false, nextBillingDate: nextBillingFromNow() };
        await kv.set(k.contracts(userId), contracts);
        notify(notifs, "Contrat renouvelé", `« ${ct.product} » est prolongé jusqu'au ${new Date(newEnd).toLocaleDateString("fr-FR")}.`, "success");
      }
    } else if (purpose === "card_activation") {
      let profile = (await kv.get(k.profile(userId))) ?? {};
      if (!profile.memberNumber) profile.memberNumber = await assignMemberNumber(userId);
      profile = { ...profile, cardActive: true, cardIssuedAt: new Date().toISOString() };
      await kv.set(k.profile(userId), profile);
      notify(notifs, "Carte membre activée", `Votre carte IPPOO n° ${profile.memberNumber} est désormais active.`, "success");
    } else if (purpose === "monthly_premium" && payment.contractId) {
      const contracts = ((await kv.get(k.contracts(userId))) ?? []) as any[];
      const idx = contracts.findIndex((ct: any) => ct.id === payment.contractId);
      if (idx !== -1) {
        contracts[idx] = { ...contracts[idx], lastPaidAt: new Date().toISOString(), nextBillingDate: nextBillingFromNow() };
        await kv.set(k.contracts(userId), contracts);
        notify(notifs, "Cotisation mensuelle reçue", `Paiement de ${payment.amount} FCFA confirmé pour « ${contracts[idx].product} ».`, "success");
      }
    } else {
      notify(notifs, "Cotisation reçue", `Paiement de ${payment.amount} FCFA confirmé.`, "success");
    }
    await kv.set(k.notifications(userId), notifs.slice(0, 200));
  } catch (err) {
    console.log(`[side-effect] purpose=${purpose} user=${userId} payment=${payment?.id}: ${err}`);
  }
}

function nextBillingFromNow(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

async function sendInvoiceEmail(userId: string, payment: any) {
  try {
    const apiKey = Deno.env.get("RESEND_API_KEY");
    if (!apiKey) {
      console.log(`[email] RESEND_API_KEY not set, skipping invoice email for ${payment.id}`);
      return;
    }
    const profile = (await kv.get(k.profile(userId))) as any;
    const email = profile?.email;
    if (!email) {
      console.log(`[email] no email on profile for ${userId}, skipping`);
      return;
    }
    let contract: any = null;
    if (payment.contractId) {
      const contracts = ((await kv.get(k.contracts(userId))) ?? []) as any[];
      contract = contracts.find((c) => c.id === payment.contractId) ?? null;
    }
    const invoiceNumber = `INV-${String(payment.id).slice(-8).toUpperCase()}`;
    const dateStr = new Date(payment.createdAt).toLocaleDateString("fr-FR");
    const lineLabel = contract ? `Cotisation – ${contract.product}` : (payment.label ?? "Cotisation IPPOO");
    const total = formatXOFInt(payment.amount ?? 0);
    const from = Deno.env.get("RESEND_FROM") ?? "IPPOO Assurance <no-reply@ippoo.app>";

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #eee">
        <div style="padding:28px 32px;background:linear-gradient(115deg,#6A1B9A 0%,#B71C7E 45%,#FF3B57 82%,#FF6A2D 100%);color:#fff">
          <div style="font-size:12px;letter-spacing:.08em;font-weight:700">IPPOO ASSURANCE</div>
          <div style="font-size:28px;font-weight:900;margin-top:6px">FACTURE</div>
          <div style="font-size:13px;opacity:.9;margin-top:4px">${invoiceNumber} · ${dateStr}</div>
        </div>
        <div style="padding:24px 32px;color:#0E1320">
          <p style="margin:0 0 6px;font-weight:700">Bonjour ${profile?.name ?? "membre IPPOO"},</p>
          <p style="margin:0 0 16px;color:#555;font-size:14px">Votre paiement a bien été confirmé. Voici le détail de votre facture.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="background:#0E1320;color:#fff">
              <td style="padding:10px 12px;text-align:left">Description</td>
              <td style="padding:10px 12px;text-align:right">Montant</td>
            </tr>
            <tr>
              <td style="padding:10px 12px;border-bottom:1px solid #eee">${lineLabel}</td>
              <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700">${total}</td>
            </tr>
            <tr>
              <td style="padding:14px 12px;font-weight:900">TOTAL</td>
              <td style="padding:14px 12px;font-weight:900;text-align:right;color:#FF3B57">${total}</td>
            </tr>
          </table>
          <p style="margin:18px 0 0;color:#666;font-size:13px">Référence paiement : ${payment.id}</p>
          <p style="margin:6px 0 0;color:#666;font-size:13px">Retrouvez votre facture dans votre espace client, onglet Documents.</p>
          <p style="margin:20px 0 0;color:#888;font-size:12px">IPPOO Assurance — La micro-assurance qui prend soin de vous au Bénin.</p>
        </div>
      </div>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `Facture ${invoiceNumber} — ${total}`,
        html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.log(`[email] Resend error ${res.status} for ${payment.id}: ${txt}`);
    }
  } catch (err) {
    console.log(`[email] sendInvoiceEmail failed: ${err}`);
  }
}

app.get(`${PREFIX}/health`, (c) => c.json({ status: "ok" }));

app.post(`${PREFIX}/signup`, async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const allowed = await rateLimit(`signup:${ip}`, 5, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, réessayez dans 10 min." }, 429);
    const parsed = await parseBody(c, SignupSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { email, password, name, phone, referralCode, profile: profileDetails } = parsed.data;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      user_metadata: { name, phone, profileType: profileDetails?.type ?? "particulier" },
      // Email server not configured — confirm automatically
      email_confirm: true,
    });
    if (error) {
      console.log(`Signup error for ${email}: ${error.message}`);
      const msg = /already been registered|already registered|user already exists/i.test(error.message)
        ? "Cet email est déjà associé à un compte IPPOO."
        : error.message;
      return c.json({ error: msg, code: "email_taken" }, 400);
    }
    const uid = data.user!.id;
    const now = new Date().toISOString();
    const memberNumber = await assignMemberNumber(uid);
    await kv.set(k.emailToUid(email), uid);
    await kv.set(k.profile(uid), {
      id: uid,
      email,
      name,
      phone: phone ?? "",
      memberNumber,
      createdAt: now,
      type: profileDetails?.type ?? "particulier",
      firstName: profileDetails?.firstName ?? null,
      lastName: profileDetails?.lastName ?? null,
      gender: profileDetails?.gender ?? null,
      birthDate: profileDetails?.birthDate ?? null,
      birthPlace: profileDetails?.birthPlace ?? null,
      profession: profileDetails?.profession ?? null,
      companyName: profileDetails?.companyName ?? null,
      ifu: profileDetails?.ifu ?? null,
      idType: profileDetails?.idType ?? null,
      idNumber: profileDetails?.idNumber ?? null,
      country: profileDetails?.country ?? "BJ",
      countryDial: profileDetails?.countryDial ?? "229",
      department: profileDetails?.department ?? null,
      city: profileDetails?.city ?? null,
      quartier: profileDetails?.quartier ?? null,
    });
    await kv.set(k.contracts(uid), []);
    await kv.set(k.claims(uid), []);
    await kv.set(k.payments(uid), []);
    await kv.set(k.beneficiaries(uid), []);
    await kv.set(k.documents(uid), []);
    await kv.set(k.notifications(uid), notify([], "Bienvenue chez IPPOO", "Votre espace est prêt. Souscrivez à une couverture pour démarrer.", "success"));
    await kv.set(k.messages(uid), []);
    await kv.set(k.settings(uid), { lang: "fr", notifySms: true, notifyEmail: true });
    // Referral: assign a unique code to the new user
    const code = makeReferralCode(name);
    await kv.set(k.referralCode(uid), code);
    await kv.set(k.referralByCode(code), uid);
    // Redeem incoming referral if provided
    if (referralCode && typeof referralCode === "string") {
      const refererUid = await kv.get(k.referralByCode(referralCode.toUpperCase().trim()));
      if (refererUid && refererUid !== uid) {
        const reds = (await kv.get(k.referralRedemptions(refererUid))) ?? [];
        reds.push({ uid, at: now });
        await kv.set(k.referralRedemptions(refererUid), reds);
        const refNotifs = (await kv.get(k.notifications(refererUid))) ?? [];
        await kv.set(
          k.notifications(refererUid),
          notify(refNotifs, "Parrainage validé", `Un nouveau filleul rejoint IPPOO grâce à votre code ${referralCode}.`, "success"),
        );
      }
    }
    await audit(uid, "signup", { email, ip });
    return c.json({ ok: true });
  } catch (err) {
    console.log(`Signup exception: ${err}`);
    return c.json({ error: `Erreur serveur lors de l'inscription: ${err}` }, 500);
  }
});

app.get(`${PREFIX}/me`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  let profile = await kv.get(k.profile(user.id));
  // Backfill memberNumber + email→uid mapping for legacy users
  if (profile && !profile.memberNumber) {
    profile = { ...profile, memberNumber: await assignMemberNumber(user.id) };
    await kv.set(k.profile(user.id), profile);
  }
  if (profile?.email) {
    const mapped = await kv.get(k.emailToUid(profile.email));
    if (!mapped) await kv.set(k.emailToUid(profile.email), user.id);
  }
  return c.json({ profile });
});

app.put(`${PREFIX}/me`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const parsed = await parseBody(c, ProfileUpdateSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const current = (await kv.get(k.profile(user.id))) ?? {};
    const next = { ...current, ...parsed.data, id: user.id };
    await kv.set(k.profile(user.id), next);
    return c.json({ profile: next });
  } catch (err) {
    console.log(`Profile update error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur de mise à jour du profil: ${err}` }, 500);
  }
});

app.get(`${PREFIX}/contracts`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const contracts = (await kv.get(k.contracts(user.id))) ?? [];
  return c.json({ contracts });
});

app.get(`${PREFIX}/claims`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const claims = (await kv.get(k.claims(user.id))) ?? [];
  return c.json({ claims });
});

app.post(`${PREFIX}/claims`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "claims", user.id, 20, 3600);
  if (limited) return limited;
  try {
    const parsed = await parseBody(c, ClaimCreateSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { contractId, type, description, amount } = parsed.data;
    const claim = {
      id: `s_${Date.now()}`,
      contractId: contractId ?? null,
      type,
      description,
      amount: typeof amount === "number" ? amount : 0,
      status: "en_cours",
      createdAt: new Date().toISOString(),
      attachments: [] as { path: string; name: string; size: number }[],
    };
    const claims = (await kv.get(k.claims(user.id))) ?? [];
    claims.unshift(claim);
    await kv.set(k.claims(user.id), claims);
    const notifs = (await kv.get(k.notifications(user.id))) ?? [];
    await kv.set(k.notifications(user.id), notify(notifs, "Sinistre déclaré", `Votre déclaration « ${type} » est en cours d'instruction.`, "info"));
    return c.json({ claim });
  } catch (err) {
    console.log(`Claim create error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur de création du sinistre: ${err}` }, 500);
  }
});

app.get(`${PREFIX}/payments`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const payments = (await kv.get(k.payments(user.id))) ?? [];
  return c.json({ payments });
});

// Initiate a Mobile Money payment via KkiaPay (Bénin). Returns a pending payment
// + the public key so the client can launch the widget. If no KKIAPAY_PUBLIC_KEY
// is configured, we fall back to a mock flow that can be confirmed by the client
// via /payments/confirm-mock (DEV/sandbox only).
app.post(`${PREFIX}/payments/initiate`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const parsed = await parseBody(c, PaymentInitiateSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { contractId, amount, phone, purpose, paymentId } = parsed.data;
    const allowed = await rateLimit(`pay-init:${user.id}`, 10, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, réessayez plus tard." }, 429);
    const publicKey = Deno.env.get("KKIAPAY_PUBLIC_KEY") ?? "";
    const mode: "kkiapay" | "mock" = publicKey ? "kkiapay" : "mock";
    const now = new Date().toISOString();
    const payments = (await kv.get(k.payments(user.id))) ?? [];
    let payment: any;
    if (paymentId) {
      const idx = payments.findIndex((p: any) => p.id === paymentId);
      if (idx === -1) return c.json({ error: "Paiement introuvable" }, 404);
      if (payments[idx].status === "confirme") return c.json({ error: "Déjà confirmé" }, 400);
      payments[idx] = { ...payments[idx], phone: phone ?? payments[idx].phone ?? null, mode, status: "en_attente" };
      payment = payments[idx];
    } else {
      payment = {
        id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        contractId: contractId ?? null,
        amount,
        currency: "XOF",
        method: "mobile_money",
        status: "en_attente" as const,
        phone: phone ?? null,
        mode,
        purpose: purpose ?? "cotisation",
        createdAt: now,
      };
      payments.unshift(payment);
    }
    await kv.set(k.payments(user.id), payments);
    await audit(user.id, "payment.initiated", { id: payment.id, amount, mode, purpose: payment.purpose });
    return c.json({
      payment,
      kkiapay: { publicKey, sandbox: !Deno.env.get("KKIAPAY_SECRET") },
    });
  } catch (err) {
    console.log(`Payment initiate error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur initialisation paiement: ${err}` }, 500);
  }
});

// KkiaPay webhook. Production: verify the X-Kkiapay-Secret header against the
// shared secret stored in env, then mark the matching payment confirmed.
app.post(`${PREFIX}/payments/webhook`, async (c) => {
  try {
    const secret = Deno.env.get("KKIAPAY_SECRET");
    const provided = c.req.header("X-Kkiapay-Secret") ?? c.req.header("x-kkiapay-secret") ?? "";
    if (!secret || provided !== secret) {
      return c.json({ error: "Signature invalide" }, 401);
    }
    const body = await c.req.json();
    // KkiaPay payload shape: { transactionId, state, amount, data: { paymentId, userId } }
    const { state, data, amount } = body ?? {};
    const paymentId = data?.paymentId;
    const userId = data?.userId;
    if (!paymentId || !userId) return c.json({ error: "Données manquantes" }, 400);
    const payments = ((await kv.get(k.payments(userId))) ?? []) as any[];
    const idx = payments.findIndex((p) => p.id === paymentId);
    if (idx === -1) return c.json({ error: "Paiement introuvable" }, 404);
    const next = state === "SUCCESS" ? "confirme" : "echec";
    payments[idx] = { ...payments[idx], status: next, confirmedAt: new Date().toISOString() };
    await kv.set(k.payments(userId), payments);
    if (next === "confirme") {
      await applyPaymentSideEffects(userId, payments[idx]);
      sendInvoiceEmail(userId, payments[idx]);
    }
    await audit(userId, `payment.${next}`, { id: paymentId, amount, purpose: payments[idx].purpose });
    return c.json({ ok: true });
  } catch (err) {
    console.log(`Payment webhook error: ${err}`);
    return c.json({ error: "Erreur webhook" }, 500);
  }
});

// Sandbox/mock confirmation. Only allowed when no KKIAPAY_SECRET is set,
// because in production KkiaPay must call /payments/webhook directly.
app.post(`${PREFIX}/payments/:id/confirm-mock`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  if (Deno.env.get("KKIAPAY_SECRET") || Deno.env.get("APP_ENV") === "production" || Deno.env.get("KKIAPAY_PUBLIC_KEY")) {
    return c.json({ error: "Mode mock désactivé : passez par KkiaPay." }, 403);
  }
  const id = c.req.param("id");
  const payments = ((await kv.get(k.payments(user.id))) ?? []) as any[];
  const idx = payments.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ error: "Paiement introuvable" }, 404);
  if (payments[idx].status === "confirme") return c.json({ payment: payments[idx] });
  payments[idx] = { ...payments[idx], status: "confirme", confirmedAt: new Date().toISOString() };
  await kv.set(k.payments(user.id), payments);
  await applyPaymentSideEffects(user.id, payments[idx]);
  await audit(user.id, "payment.confirme", { id, mode: "mock", purpose: payments[idx].purpose });
  sendInvoiceEmail(user.id, payments[idx]);
  return c.json({ payment: payments[idx] });
});

app.get(`${PREFIX}/payments/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const payments = ((await kv.get(k.payments(user.id))) ?? []) as any[];
  const payment = payments.find((p) => p.id === id);
  if (!payment) return c.json({ error: "Paiement introuvable" }, 404);
  return c.json({ payment });
});

app.post(`${PREFIX}/payments`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "pay-legacy", user.id, 10, 600);
  if (limited) return limited;
  try {
    const parsed = await parseBody(c, PaymentLegacySchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { contractId, amount, method } = parsed.data;
    const payment = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      contractId: contractId ?? null,
      amount,
      currency: "XOF",
      method: method ?? "mobile_money",
      status: "en_attente" as const,
      purpose: "cotisation" as const,
      createdAt: new Date().toISOString(),
    };
    const payments = (await kv.get(k.payments(user.id))) ?? [];
    payments.unshift(payment);
    await kv.set(k.payments(user.id), payments);
    return c.json({ payment });
  } catch (err) {
    console.log(`Payment create error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur de cotisation: ${err}` }, 500);
  }
});

// ---- BENEFICIARIES ----
app.get(`${PREFIX}/beneficiaries`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const beneficiaries = (await kv.get(k.beneficiaries(user.id))) ?? [];
  return c.json({ beneficiaries });
});

app.post(`${PREFIX}/beneficiaries`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "ben", user.id, 20, 3600);
  if (limited) return limited;
  try {
    const parsed = await parseBody(c, BeneficiaryCreateSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { name, relation, birthDate } = parsed.data;
    const beneficiary = {
      id: `b_${Date.now()}`,
      name,
      relation,
      birthDate: birthDate ?? null,
      createdAt: new Date().toISOString(),
    };
    const list = (await kv.get(k.beneficiaries(user.id))) ?? [];
    list.push(beneficiary);
    await kv.set(k.beneficiaries(user.id), list);
    return c.json({ beneficiary });
  } catch (err) {
    console.log(`Beneficiary create error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur d'ajout du bénéficiaire: ${err}` }, 500);
  }
});

// Upload an attachment for an existing claim (multipart form-data)
app.post(`${PREFIX}/claims/:id/attachments`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "att", user.id, 30, 3600);
  if (limited) return limited;
  const id = c.req.param("id");
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "Fichier manquant" }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: "Fichier trop volumineux (10 Mo max)" }, 400);
    const path = `${user.id}/${id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
    const { error: uploadErr } = await admin.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (uploadErr) return c.json({ error: `Erreur d'upload: ${uploadErr.message}` }, 500);
    const claims = (await kv.get(k.claims(user.id))) ?? [];
    const idx = claims.findIndex((cl: any) => cl.id === id);
    if (idx === -1) return c.json({ error: "Sinistre introuvable" }, 404);
    claims[idx].attachments = [...(claims[idx].attachments ?? []), { path, name: file.name, size: file.size }];
    await kv.set(k.claims(user.id), claims);
    return c.json({ ok: true, attachment: { path, name: file.name, size: file.size } });
  } catch (err) {
    console.log(`Attachment upload error: ${err}`);
    return c.json({ error: `Erreur d'upload: ${err}` }, 500);
  }
});

// Signed URL for an attachment (5 min)
app.get(`${PREFIX}/claims/attachments/url`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const path = c.req.query("path");
  if (!path || !path.startsWith(`${user.id}/`)) return c.json({ error: "Chemin invalide" }, 400);
  const { data, error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(path, 300);
  if (signErr) return c.json({ error: signErr.message }, 500);
  return c.json({ url: data.signedUrl });
});

app.delete(`${PREFIX}/beneficiaries/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const list = ((await kv.get(k.beneficiaries(user.id))) ?? []).filter((b: any) => b.id !== id);
  await kv.set(k.beneficiaries(user.id), list);
  return c.json({ ok: true });
});

// ---- DOCUMENTS ----
app.get(`${PREFIX}/documents`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const documents = (await kv.get(k.documents(user.id))) ?? [];
  return c.json({ documents });
});

// ---- NOTIFICATIONS ----
app.get(`${PREFIX}/notifications`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const notifications = (await kv.get(k.notifications(user.id))) ?? [];
  return c.json({ notifications });
});

app.post(`${PREFIX}/notifications/read`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const list = ((await kv.get(k.notifications(user.id))) ?? []).map((n: any) => ({ ...n, read: true }));
  await kv.set(k.notifications(user.id), list);
  return c.json({ ok: true });
});

// ---- MESSAGES ----
app.get(`${PREFIX}/messages`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const messages = (await kv.get(k.messages(user.id))) ?? [];
  return c.json({ messages });
});

const EDIT_WINDOW_MS = 5 * 60 * 1000;

// Edit own message (5 min window).
app.patch(`${PREFIX}/messages/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const parsed = await parseBody(c, MessageEditSchema);
  if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
  const list = ((await kv.get(k.messages(user.id))) ?? []) as any[];
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return c.json({ error: "Message introuvable" }, 404);
  const m = list[idx];
  if (m.from !== "user") return c.json({ error: "Édition refusée" }, 403);
  if (m.deletedAt) return c.json({ error: "Message supprimé" }, 410);
  if (Date.now() - new Date(m.createdAt).getTime() > EDIT_WINDOW_MS) return c.json({ error: "Fenêtre d'édition expirée" }, 409);
  const updated = { ...m, body: parsed.data.content.trim(), editedAt: new Date().toISOString() };
  list[idx] = updated;
  await kv.set(k.messages(user.id), list);
  await Promise.all([
    broadcast(`chat:${user.id}`, "message:update", { message: updated }),
    broadcast(`admin:chat`, "message:update", { userId: user.id, message: updated }),
  ]);
  return c.json({ message: updated });
});

// Soft-delete own message. Body cleared, attachment hidden.
app.delete(`${PREFIX}/messages/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const list = ((await kv.get(k.messages(user.id))) ?? []) as any[];
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return c.json({ error: "Message introuvable" }, 404);
  if (list[idx].from !== "user") return c.json({ error: "Suppression refusée" }, 403);
  const updated = { ...list[idx], body: "", deletedAt: new Date().toISOString(), attachment: undefined };
  list[idx] = updated;
  await kv.set(k.messages(user.id), list);
  await Promise.all([
    broadcast(`chat:${user.id}`, "message:update", { message: updated }),
    broadcast(`admin:chat`, "message:update", { userId: user.id, message: updated }),
  ]);
  return c.json({ message: updated });
});

// Admin edit/delete on advisor messages.
app.patch(`${PREFIX}/admin/messages/:uid/:id`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const id = c.req.param("id");
  const parsed = await parseBody(c, MessageEditSchema);
  if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
  const list = ((await kv.get(k.messages(uid))) ?? []) as any[];
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return c.json({ error: "Message introuvable" }, 404);
  if (list[idx].from !== "conseiller") return c.json({ error: "Édition refusée" }, 403);
  if (list[idx].deletedAt) return c.json({ error: "Message supprimé" }, 410);
  const updated = { ...list[idx], body: parsed.data.content.trim(), editedAt: new Date().toISOString() };
  list[idx] = updated;
  await kv.set(k.messages(uid), list);
  await audit(uid, "message.admin_edit", { by: r.admin.username, id });
  await Promise.all([
    broadcast(`chat:${uid}`, "message:update", { message: updated }),
    broadcast(`admin:chat`, "message:update", { userId: uid, message: updated }),
  ]);
  return c.json({ message: updated });
});

app.delete(`${PREFIX}/admin/messages/:uid/:id`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const id = c.req.param("id");
  const list = ((await kv.get(k.messages(uid))) ?? []) as any[];
  const idx = list.findIndex((m) => m.id === id);
  if (idx < 0) return c.json({ error: "Message introuvable" }, 404);
  if (list[idx].from !== "conseiller") return c.json({ error: "Suppression refusée" }, 403);
  const updated = { ...list[idx], body: "", deletedAt: new Date().toISOString(), attachment: undefined };
  list[idx] = updated;
  await kv.set(k.messages(uid), list);
  await audit(uid, "message.admin_delete", { by: r.admin.username, id });
  await Promise.all([
    broadcast(`chat:${uid}`, "message:update", { message: updated }),
    broadcast(`admin:chat`, "message:update", { userId: uid, message: updated }),
  ]);
  return c.json({ message: updated });
});

// Upload an attachment as a chat message. multipart/form-data: file=<File>, [caption]=string
app.post(`${PREFIX}/messages/attachment`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "msgatt", user.id, 20, 600);
  if (limited) return limited;
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    const caption = String(form.get("caption") ?? "").trim();
    if (!(file instanceof File)) return c.json({ error: "Fichier manquant" }, 400);
    if (file.size > MSG_MAX_BYTES) return c.json({ error: "Fichier trop volumineux (max 10 Mo)" }, 413);
    if (!MSG_ALLOWED_MIME.test(file.type)) return c.json({ error: `Type non autorisé: ${file.type}` }, 415);
    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${user.id}/${Date.now()}_${safeName}`;
    const { error: upErr } = await admin.storage.from(MSG_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) return c.json({ error: `Upload échoué: ${upErr.message}` }, 500);
    const profile = (await kv.get(k.profile(user.id))) ?? {};
    const userMsg = {
      id: `m_${Date.now()}`,
      from: "user",
      author: profile.name ?? "Vous",
      body: caption,
      createdAt: new Date().toISOString(),
      read: true,
      attachment: { name: file.name, mime: file.type, size: file.size, path },
    };
    const list = ((await kv.get(k.messages(user.id))) ?? []) as any[];
    list.push(userMsg);
    await kv.set(k.messages(user.id), list);
    await Promise.all([
      broadcast(`chat:${user.id}`, "message:new", { message: userMsg }),
      broadcast(`admin:chat`, "message:new", { userId: user.id, message: userMsg }),
    ]);
    return c.json({ message: userMsg });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.post(`${PREFIX}/admin/messages/:uid/attachment`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    const caption = String(form.get("caption") ?? "").trim();
    if (!(file instanceof File)) return c.json({ error: "Fichier manquant" }, 400);
    if (file.size > MSG_MAX_BYTES) return c.json({ error: "Fichier trop volumineux (max 10 Mo)" }, 413);
    if (!MSG_ALLOWED_MIME.test(file.type)) return c.json({ error: `Type non autorisé: ${file.type}` }, 415);
    const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
    const path = `${uid}/admin_${Date.now()}_${safeName}`;
    const { error: upErr } = await admin.storage.from(MSG_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) return c.json({ error: `Upload échoué: ${upErr.message}` }, 500);
    const msg = {
      id: `m_${Date.now()}`,
      from: "conseiller",
      author: `${r.admin.username} (IPPOO)`,
      body: caption,
      createdAt: new Date().toISOString(),
      read: false,
      attachment: { name: file.name, mime: file.type, size: file.size, path },
    };
    const list = ((await kv.get(k.messages(uid))) ?? []) as any[];
    list.push(msg);
    await kv.set(k.messages(uid), list);
    const notifs = ((await kv.get(k.notifications(uid))) ?? []) as any[];
    await kv.set(k.notifications(uid), notify(notifs, "Nouveau message conseiller", `Pièce jointe : ${file.name}`, "info"));
    await audit(uid, "message.admin_attachment", { by: r.admin.username, name: file.name, size: file.size });
    await Promise.all([
      broadcast(`chat:${uid}`, "message:new", { message: msg }),
      broadcast(`admin:chat`, "message:new", { userId: uid, message: msg }),
    ]);
    return c.json({ message: msg });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// Signed URL for a message attachment. User can fetch their own; admin can fetch any.
app.get(`${PREFIX}/messages/attachment-url`, async (c) => {
  const path = c.req.query("path") ?? "";
  if (!path) return c.json({ error: "path manquant" }, 400);
  const adminTok = c.req.header("X-Admin-Token") ?? c.req.header("x-admin-token");
  if (adminTok) {
    const r = await requireAdminToken(c);
    if (!r.admin) return c.json({ error: r.error }, r.status);
  } else {
    const { user, error } = await requireUser(c);
    if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
    if (!path.startsWith(`${user.id}/`)) return c.json({ error: "Accès refusé" }, 403);
  }
  const { data, error: sErr } = await admin.storage.from(MSG_BUCKET).createSignedUrl(path, 300);
  if (sErr || !data) return c.json({ error: sErr?.message ?? "Erreur signature" }, 500);
  return c.json({ url: data.signedUrl, expiresIn: 300 });
});

// Client marks all advisor messages as read. Broadcasts to admin so the
// unread badge drops instantly.
app.post(`${PREFIX}/messages/read`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const list = ((await kv.get(k.messages(user.id))) ?? []) as any[];
  let changed = 0;
  const marked = list.map((m) => {
    if (m.from === "conseiller" && !m.read) { changed++; return { ...m, read: true, readAt: new Date().toISOString() }; }
    return m;
  });
  if (changed > 0) {
    await kv.set(k.messages(user.id), marked);
    await broadcast(`admin:chat`, "message:read", { userId: user.id, count: changed, at: new Date().toISOString() });
  }
  return c.json({ ok: true, marked: changed });
});

// Admin marks the thread as read (or any single message). Broadcasts to the
// user's channel so the ✓✓ indicator lights up live on their messages.
app.post(`${PREFIX}/admin/messages/:uid/read`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const list = ((await kv.get(k.messages(uid))) ?? []) as any[];
  let changed = 0;
  const marked = list.map((m) => {
    if (m.from === "user" && !m.read) { changed++; return { ...m, read: true, readAt: new Date().toISOString() }; }
    return m;
  });
  if (changed > 0) {
    await kv.set(k.messages(uid), marked);
    await broadcast(`chat:${uid}`, "message:read", { count: changed, at: new Date().toISOString() });
  }
  return c.json({ ok: true, marked: changed });
});

app.post(`${PREFIX}/messages`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "msg", user.id, 30, 600);
  if (limited) return limited;
  try {
    const parsed = await parseBody(c, MessageCreateSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const content = parsed.data.content.trim();
    if (!content) return c.json({ error: "Message vide" }, 400);
    const profile = (await kv.get(k.profile(user.id))) ?? {};
    const now = new Date().toISOString();
    const replyToId = typeof (parsed.data as any).replyToId === "string" ? (parsed.data as any).replyToId : undefined;
    const userMsg: any = {
      id: `m_${Date.now()}`,
      from: "user",
      author: profile.name ?? "Vous",
      body: content.trim(),
      createdAt: now,
      read: true,
    };
    if (replyToId) userMsg.replyToId = replyToId;
    const list = (await kv.get(k.messages(user.id))) ?? [];
    list.push(userMsg);
    await kv.set(k.messages(user.id), list);
    // Push to the user's own channel (other client tabs) AND to the admin queue.
    await Promise.all([
      broadcast(`chat:${user.id}`, "message:new", { message: userMsg }),
      broadcast(`admin:chat`, "message:new", { userId: user.id, message: userMsg }),
    ]);
    return c.json({ messages: [userMsg] });
  } catch (err) {
    console.log(`Message create error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur lors de l'envoi: ${err}` }, 500);
  }
});

// ---- SUBSCRIBE TO NEW CONTRACT ----
app.post(`${PREFIX}/subscribe`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "sub", user.id, 10, 3600);
  if (limited) return limited;
  try {
    const parsed = await parseBody(c, SubscribeSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { product, frequency } = parsed.data;
    const now = new Date().toISOString();
    const contract = {
      id: `c_${Date.now()}`,
      product,
      status: "active",
      startDate: now,
      endDate: new Date(Date.now() + 365 * 86400000).toISOString(),
      premium: BILLING.dailyPerProduct * BILLING.daysPerMonth,
      currency: "XOF",
      frequency: frequency ?? "mensuel",
      autoDebit: true,
      nextBillingDate: nextBillingFromNow(),
    };
    const contracts = (await kv.get(k.contracts(user.id))) ?? [];
    contracts.unshift(contract);
    await kv.set(k.contracts(user.id), contracts);
    const notifications = (await kv.get(k.notifications(user.id))) ?? [];
    await kv.set(
      k.notifications(user.id),
      notify(notifications, "Souscription confirmée", `Votre contrat « ${product} » est actif.`, "success", "/espace-client/contrats"),
    );
    return c.json({ contract });
  } catch (err) {
    console.log(`Subscribe error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur de souscription: ${err}` }, 500);
  }
});

// ---- SETTINGS ----
app.get(`${PREFIX}/settings`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const settings = (await kv.get(k.settings(user.id))) ?? { lang: "fr", notifySms: true, notifyEmail: true };
  return c.json({ settings });
});

app.put(`${PREFIX}/settings`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const updates = await c.req.json();
    const current = (await kv.get(k.settings(user.id))) ?? {};
    const next = { ...current, ...updates };
    await kv.set(k.settings(user.id), next);
    return c.json({ settings: next });
  } catch (err) {
    console.log(`Settings update error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur sauvegarde paramètres: ${err}` }, 500);
  }
});

// ---- CHANGE PASSWORD ----
app.post(`${PREFIX}/change-password`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const allowed = await rateLimit(`pw:${user.id}`, 5, 3600);
    if (!allowed) return c.json({ error: "Trop de changements, réessayez dans 1 h." }, 429);
    const parsed = await parseBody(c, ChangePasswordSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { newPassword } = parsed.data;
    const { error: updateErr } = await admin.auth.admin.updateUserById(user.id, { password: newPassword });
    if (updateErr) {
      console.log(`Password change error for ${user.id}: ${updateErr.message}`);
      await audit(user.id, "password.change.failed", { reason: updateErr.message });
      return c.json({ error: updateErr.message }, 400);
    }
    await audit(user.id, "password.change", {});
    return c.json({ ok: true });
  } catch (err) {
    console.log(`Password change exception for ${user.id}: ${err}`);
    return c.json({ error: `Erreur changement mot de passe: ${err}` }, 500);
  }
});

// Check upcoming contract renewals and push notifications (idempotent via renewalNoticeSent flag)
app.post(`${PREFIX}/contracts/check-renewals`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const contracts = (await kv.get(k.contracts(user.id))) ?? [];
    const notifs = (await kv.get(k.notifications(user.id))) ?? [];
    const now = Date.now();
    const WINDOW = 30 * 86400000;
    let changed = false;
    let pushed = 0;
    const updated = contracts.map((ct: any) => {
      if (ct.status !== "active" || !ct.endDate) return ct;
      const end = new Date(ct.endDate).getTime();
      const days = Math.ceil((end - now) / 86400000);
      if (days <= 30 && days >= 0 && !ct.renewalNoticeSent) {
        notify(
          notifs,
          "Échéance proche",
          `Votre contrat « ${ct.product} » arrive à échéance dans ${days} jour${days > 1 ? "s" : ""}.`,
          "warn",
        );
        pushed++;
        changed = true;
        return { ...ct, renewalNoticeSent: true };
      }
      if (days > WINDOW / 86400000 && ct.renewalNoticeSent) {
        return { ...ct, renewalNoticeSent: false };
      }
      return ct;
    });
    if (changed) {
      await kv.set(k.contracts(user.id), updated);
      await kv.set(k.notifications(user.id), notifs.slice(0, 50));
    }
    return c.json({ pushed });
  } catch (err) {
    console.log(`Renewal check error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur de vérification des échéances: ${err}` }, 500);
  }
});

// 1-click renewal: extends contract by 12 months + records payment
app.post(`${PREFIX}/contracts/:id/renew`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "renew", user.id, 10, 3600);
  if (limited) return limited;
  const id = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const phone = typeof body.phone === "string" ? body.phone : null;
    const contracts = (await kv.get(k.contracts(user.id))) ?? [];
    const ct = contracts.find((c: any) => c.id === id);
    if (!ct) return c.json({ error: "Contrat introuvable" }, 404);
    const publicKey = Deno.env.get("KKIAPAY_PUBLIC_KEY") ?? "";
    const mode: "kkiapay" | "mock" = publicKey ? "kkiapay" : "mock";
    const payment = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      contractId: ct.id,
      amount: ct.premium,
      currency: ct.currency ?? "XOF",
      method: "mobile_money",
      status: "en_attente" as const,
      purpose: "renewal" as const,
      phone,
      mode,
      createdAt: new Date().toISOString(),
    };
    const payments = (await kv.get(k.payments(user.id))) ?? [];
    payments.unshift(payment);
    await kv.set(k.payments(user.id), payments);
    await audit(user.id, "renewal.initiated", { id, premium: ct.premium, paymentId: payment.id });
    return c.json({
      payment,
      kkiapay: { publicKey, sandbox: !Deno.env.get("KKIAPAY_SECRET") },
    });
  } catch (err) {
    console.log(`Renewal error for ${user.id}/${id}: ${err}`);
    return c.json({ error: `Erreur de renouvellement: ${err}` }, 500);
  }
});

// ---- REFERRAL ----
app.get(`${PREFIX}/referral`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  let code = await kv.get(k.referralCode(user.id));
  if (!code) {
    const profile = (await kv.get(k.profile(user.id))) ?? {};
    code = makeReferralCode(profile.name ?? "IPPOO");
    await kv.set(k.referralCode(user.id), code);
    await kv.set(k.referralByCode(code), user.id);
  }
  const redemptions = (await kv.get(k.referralRedemptions(user.id))) ?? [];
  return c.json({ code, count: redemptions.length });
});

// ---- AUDIT LOG ----
app.get(`${PREFIX}/audit`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const entries = (await kv.get(k.audit(user.id))) ?? [];
  return c.json({ entries });
});

// ---- ACCOUNT DELETION (RGPD, soft-delete with 30-day grace) ----
app.post(`${PREFIX}/account/delete`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "acct-del", user.id, 5, 3600);
  if (limited) return limited;
  const scheduledFor = new Date(Date.now() + 30 * 86400000).toISOString();
  await kv.set(k.accountDeletion(user.id), { requestedAt: new Date().toISOString(), scheduledFor });
  await audit(user.id, "account.delete.request", { scheduledFor });
  const notifications = (await kv.get(k.notifications(user.id))) ?? [];
  notify(notifications, "Suppression de compte programmée", `Votre compte sera supprimé le ${new Date(scheduledFor).toLocaleDateString("fr-FR")}. Connectez-vous pour annuler.`, "warn");
  await kv.set(k.notifications(user.id), notifications.slice(0, 100));
  return c.json({ ok: true, scheduledFor });
});

app.delete(`${PREFIX}/account/delete`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  await kv.del(k.accountDeletion(user.id));
  await audit(user.id, "account.delete.cancel", {});
  return c.json({ ok: true });
});

// RGPD data portability: returns a JSON dump of all user data so the user
// can keep a copy before requesting deletion.
app.get(`${PREFIX}/account/export`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const [profile, contracts, claims, payments, beneficiaries, documents, notifications, messages, settings, auditEntries, referralCode] =
    await Promise.all([
      kv.get(k.profile(user.id)),
      kv.get(k.contracts(user.id)),
      kv.get(k.claims(user.id)),
      kv.get(k.payments(user.id)),
      kv.get(k.beneficiaries(user.id)),
      kv.get(k.documents(user.id)),
      kv.get(k.notifications(user.id)),
      kv.get(k.messages(user.id)),
      kv.get(k.settings(user.id)),
      kv.get(k.audit(user.id)),
      kv.get(k.referralCode(user.id)),
    ]);
  await audit(user.id, "account.export", {});
  return c.json({
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    profile,
    contracts,
    claims,
    payments,
    beneficiaries,
    documents,
    notifications,
    messages,
    settings,
    audit: auditEntries,
    referralCode,
  });
});

// Hard-delete: wipes all KV keys, storage files, and the auth user. Used by
// the admin sweep route (after the 30-day grace period) and the user-driven
// immediate-delete route.
async function hardDeleteUser(uid: string): Promise<void> {
  const profile = await kv.get(k.profile(uid));
  const keys = [
    k.profile(uid), k.contracts(uid), k.claims(uid), k.payments(uid),
    k.beneficiaries(uid), k.documents(uid), k.notifications(uid), k.messages(uid),
    k.settings(uid), k.audit(uid), k.referralCode(uid), k.accountDeletion(uid),
    k.webauthnCreds(uid), k.webauthnChallenge(`reg:${uid}`),
  ];
  if (profile?.email) keys.push(k.emailToUid(profile.email));
  if (profile?.memberNumber) keys.push(k.memberByNumber(profile.memberNumber));
  if (profile?.referralCode) keys.push(k.referralByCode(profile.referralCode));
  try { await kv.mdel(keys); } catch (err) { console.log(`hardDelete kv error ${uid}: ${err}`); }
  try {
    const { data: files } = await admin.storage.from(BUCKET).list(uid, { limit: 1000 });
    if (files && files.length) {
      const paths: string[] = [];
      for (const f of files) {
        if (f.name) {
          const { data: sub } = await admin.storage.from(BUCKET).list(`${uid}/${f.name}`, { limit: 1000 });
          for (const sf of sub ?? []) paths.push(`${uid}/${f.name}/${sf.name}`);
        }
      }
      if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    }
  } catch (err) { console.log(`hardDelete storage error ${uid}: ${err}`); }
  try { await admin.auth.admin.deleteUser(uid); } catch (err) { console.log(`hardDelete auth error ${uid}: ${err}`); }
}

// User-driven immediate purge (skips the 30-day grace; consent already given).
app.post(`${PREFIX}/account/delete-now`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "acct-del-now", user.id, 2, 86400);
  if (limited) return limited;
  await hardDeleteUser(user.id);
  return c.json({ ok: true });
});

// Admin sweep: deletes accounts whose scheduledFor is past. Can be called by
// a cron job or manually by an admin from the admin portal.
app.post(`${PREFIX}/admin/account/sweep`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "account:deletion:%");
    if (error) return c.json({ error: error.message }, 500);
    const now = Date.now();
    const deleted: string[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("account:deletion:".length);
      const scheduledFor = (row.value as any)?.scheduledFor;
      if (!scheduledFor) continue;
      if (new Date(scheduledFor).getTime() <= now) {
        await hardDeleteUser(uid);
        deleted.push(uid);
      }
    }
    return c.json({ deleted: deleted.length, ids: deleted });
  } catch (err) {
    console.log(`Account sweep error: ${err}`);
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- BILLING & MEMBER CARD ----
const BILLING = {
  dailyPerProduct: 500,
  daysPerMonth: 31,
  accountFee: 1000,
  cardFee: 500,
};

function computeBilling(contracts: any[], profile: any) {
  const perProduct = BILLING.dailyPerProduct * BILLING.daysPerMonth;
  const active = (contracts ?? []).filter((c) => c.status === "active");
  const items: any[] = active.map((c) => ({
    kind: "insurance",
    label: `Assurance — ${c.product}`,
    contractId: c.id,
    perDay: BILLING.dailyPerProduct,
    days: BILLING.daysPerMonth,
    amount: perProduct,
  }));
  items.push({ kind: "account_fee", label: "Frais de gestion de compte", amount: BILLING.accountFee });
  if (profile?.cardActive) {
    items.push({ kind: "card_fee", label: "Carte membre IPPOO", amount: BILLING.cardFee });
  }
  const total = items.reduce((s, it) => s + it.amount, 0);
  return {
    items,
    total,
    perInsurance: perProduct,
    accountFee: BILLING.accountFee,
    cardFee: BILLING.cardFee,
    activeCount: active.length,
    cycle: "mensuel",
  };
}

app.get(`${PREFIX}/billing`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const contracts = (await kv.get(k.contracts(user.id))) ?? [];
  const profile = await kv.get(k.profile(user.id));
  return c.json(computeBilling(contracts, profile));
});

app.post(`${PREFIX}/member-card/activate`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "card", user.id, 5, 3600);
  if (limited) return limited;
  try {
    const contracts = (await kv.get(k.contracts(user.id))) ?? [];
    const hasActive = contracts.some((ct: any) => ct.status === "active");
    if (!hasActive) {
      return c.json({ error: "Vous devez d'abord souscrire à au moins une assurance." }, 400);
    }
    const profile = await kv.get(k.profile(user.id));
    if (!profile) return c.json({ error: "Profil introuvable" }, 404);
    if (profile.cardActive) return c.json({ profile, payment: null });
    const body = await c.req.json().catch(() => ({}));
    const phone = typeof body?.phone === "string" ? body.phone : null;
    const publicKey = Deno.env.get("KKIAPAY_PUBLIC_KEY") ?? "";
    const mode: "kkiapay" | "mock" = publicKey ? "kkiapay" : "mock";
    const payment = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      contractId: null,
      amount: BILLING.cardFee,
      currency: "XOF",
      method: "mobile_money",
      status: "en_attente" as const,
      purpose: "card_activation" as const,
      label: "Activation carte membre IPPOO",
      phone,
      mode,
      createdAt: new Date().toISOString(),
    };
    const payments = (await kv.get(k.payments(user.id))) ?? [];
    payments.unshift(payment);
    await kv.set(k.payments(user.id), payments);
    await audit(user.id, "member-card.activate.initiated", { paymentId: payment.id });
    return c.json({
      profile,
      payment,
      kkiapay: { publicKey, sandbox: !Deno.env.get("KKIAPAY_SECRET") },
    });
  } catch (err) {
    console.log(`Card activation error for ${user.id}: ${err}`);
    return c.json({ error: `Erreur d'activation: ${err}` }, 500);
  }
});

// ---- QR LOGIN: issue & verify signed QR tokens ----
app.get(`${PREFIX}/me/qr-token`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const profile = await kv.get(k.profile(user.id));
  if (!profile?.memberNumber) return c.json({ error: "Profil incomplet" }, 400);
  if (!profile.cardActive) return c.json({ error: "Carte membre non activée", code: "card_inactive" }, 403);
  const contracts = (await kv.get(k.contracts(user.id))) ?? [];
  if (!contracts.some((ct: any) => ct.status === "active")) {
    return c.json({ error: "Aucune souscription active", code: "no_subscription" }, 403);
  }
  const token = await signToken({
    v: 1,
    sub: user.id,
    mn: profile.memberNumber,
    iat: Math.floor(Date.now() / 1000),
  });
  return c.json({ token, memberNumber: profile.memberNumber });
});

// Exchange QR token → magic link (client completes via supabase.auth.verifyOtp)
app.post(`${PREFIX}/auth/qr-login`, async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const allowed = await rateLimit(`qrlogin:${ip}`, 10, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, patientez." }, 429);
    const { token } = (await c.req.json()) ?? {};
    if (!token || typeof token !== "string") return c.json({ error: "Token manquant" }, 400);
    const payload = await verifyToken<{ sub: string; mn: string }>(token);
    if (!payload?.sub) return c.json({ error: "QR invalide ou falsifié" }, 401);
    const profile = await kv.get(k.profile(payload.sub));
    if (!profile?.email || profile.memberNumber !== payload.mn) {
      return c.json({ error: "Identifiants membres invalides" }, 401);
    }
    const { data, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink", email: profile.email,
    });
    if (linkErr) return c.json({ error: linkErr.message }, 500);
    await audit(payload.sub, "auth.qr.login", { ip });
    return c.json({
      email: profile.email,
      tokenHash: data.properties?.hashed_token,
      actionLink: data.properties?.action_link,
    });
  } catch (err) {
    console.log(`QR login error: ${err}`);
    return c.json({ error: `Erreur QR: ${err}` }, 500);
  }
});

// ---- WEBAUTHN (biometric) ----
app.post(`${PREFIX}/auth/webauthn/register/options`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const profile = await kv.get(k.profile(user.id));
  const existing = (await kv.get(k.webauthnCreds(user.id))) ?? [];
  const { rpID } = webauthnContext(c);
  const opts = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME,
    rpID,
    userID: enc.encode(user.id),
    userName: profile?.email ?? user.email ?? user.id,
    userDisplayName: profile?.name ?? "Membre IPPOO",
    attestationType: "none",
    authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
    excludeCredentials: existing.map((c: any) => ({ id: c.id, type: "public-key" })),
  });
  await kv.set(k.webauthnChallenge(`reg:${user.id}`), { challenge: opts.challenge, at: Date.now() });
  return c.json(opts);
});

app.post(`${PREFIX}/auth/webauthn/register/verify`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "biorev", user.id, 10, 600);
  if (limited) return limited;
  try {
    const body = await c.req.json();
    const stored = await kv.get(k.webauthnChallenge(`reg:${user.id}`));
    if (!stored?.challenge) return c.json({ error: "Aucun défi en cours" }, 400);
    const { origin, rpID } = webauthnContext(c);
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "Vérification échouée" }, 400);
    }
    const { credential } = verification.registrationInfo as any;
    const creds = (await kv.get(k.webauthnCreds(user.id))) ?? [];
    creds.push({
      id: credential.id,
      publicKey: b64urlEncode(credential.publicKey),
      counter: credential.counter ?? 0,
      transports: body.response?.response?.transports ?? [],
      createdAt: new Date().toISOString(),
    });
    await kv.set(k.webauthnCreds(user.id), creds);
    await audit(user.id, "auth.webauthn.register", {});
    return c.json({ ok: true });
  } catch (err) {
    console.log(`WebAuthn register verify error: ${err}`);
    return c.json({ error: `Erreur d'enregistrement biométrique: ${err}` }, 500);
  }
});

app.post(`${PREFIX}/auth/webauthn/login/options`, async (c) => {
  try {
    const { email } = (await c.req.json()) ?? {};
    if (!email) return c.json({ error: "Email requis" }, 400);
    const uid = await kv.get(k.emailToUid(email));
    if (!uid) return c.json({ error: "Aucun compte trouvé" }, 404);
    const creds = (await kv.get(k.webauthnCreds(uid))) ?? [];
    if (!creds.length) return c.json({ error: "Aucune empreinte enregistrée" }, 404);
    const { rpID } = webauthnContext(c);
    const opts = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((c: any) => ({ id: c.id, type: "public-key", transports: c.transports })),
      userVerification: "preferred",
    });
    await kv.set(k.webauthnChallenge(`auth:${uid}`), { challenge: opts.challenge, at: Date.now() });
    return c.json({ ...opts, _uid: uid });
  } catch (err) {
    console.log(`WebAuthn auth options error: ${err}`);
    return c.json({ error: `Erreur: ${err}` }, 500);
  }
});

app.post(`${PREFIX}/auth/webauthn/login/verify`, async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const allowed = await rateLimit(`biolog:${ip}`, 10, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, patientez." }, 429);
    const { email, response } = (await c.req.json()) ?? {};
    const uid = await kv.get(k.emailToUid(email));
    if (!uid) return c.json({ error: "Compte introuvable" }, 404);
    const stored = await kv.get(k.webauthnChallenge(`auth:${uid}`));
    if (!stored?.challenge) return c.json({ error: "Aucun défi en cours" }, 400);
    const creds = (await kv.get(k.webauthnCreds(uid))) ?? [];
    const cred = creds.find((c: any) => c.id === response.id);
    if (!cred) return c.json({ error: "Empreinte inconnue" }, 404);
    const { origin, rpID } = webauthnContext(c);
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: cred.id,
        publicKey: b64urlDecode(cred.publicKey),
        counter: cred.counter,
        transports: cred.transports,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) return c.json({ error: "Empreinte rejetée" }, 401);
    cred.counter = verification.authenticationInfo.newCounter;
    await kv.set(k.webauthnCreds(uid), creds);
    const profile = await kv.get(k.profile(uid));
    const { data, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink", email: profile.email,
    });
    if (linkErr) return c.json({ error: linkErr.message }, 500);
    await audit(uid, "auth.webauthn.login", { ip });
    return c.json({
      email: profile.email,
      tokenHash: data.properties?.hashed_token,
    });
  } catch (err) {
    console.log(`WebAuthn auth verify error: ${err}`);
    return c.json({ error: `Erreur de vérification biométrique: ${err}` }, 500);
  }
});

app.get(`${PREFIX}/auth/webauthn/status`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const creds = (await kv.get(k.webauthnCreds(user.id))) ?? [];
  return c.json({ count: creds.length, devices: creds.map((c: any) => ({ id: c.id, createdAt: c.createdAt })) });
});

app.delete(`${PREFIX}/auth/webauthn/:credId`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const credId = c.req.param("credId");
  const creds = ((await kv.get(k.webauthnCreds(user.id))) ?? []).filter((c: any) => c.id !== credId);
  await kv.set(k.webauthnCreds(user.id), creds);
  await audit(user.id, "auth.webauthn.remove", { credId });
  return c.json({ ok: true });
});

// ---- ADMIN ----
// Admin auth is fully isolated from user auth: credentials in env vars
// (ADMIN_USERNAME / ADMIN_PASSWORD), HMAC-signed session token, X-Admin-Token
// header. The Supabase users table is NEVER consulted for admin access.

app.post(`${PREFIX}/admin/login`, async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const limited = await guardRate(c, `admin-login:${ip}`, 5, 600);
  if (limited) return limited;
  try {
    const body = await c.req.json().catch(() => ({}));
    const username = (body.username ?? "").toString().trim();
    const password = (body.password ?? "").toString();
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
      return c.json({ error: "Back office non configuré: définissez ADMIN_USERNAME et ADMIN_PASSWORD." }, 503);
    }
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return c.json({ error: "Identifiants invalides" }, 401);
    }
    const exp = Math.floor(Date.now() / 1000) + ADMIN_TOKEN_TTL_SEC;
    const token = await signToken({ kind: "admin", username, iat: Math.floor(Date.now() / 1000), exp });
    return c.json({ token, username, expiresAt: exp * 1000 });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/check`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ admin: false, error: r.error }, r.status);
  return c.json({ admin: true, username: r.admin.username });
});

app.get(`${PREFIX}/admin/claims`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "claims:%");
    if (error) return c.json({ error: error.message }, 500);
    const flat: any[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("claims:".length);
      const profile = (await kv.get(k.profile(uid))) ?? {};
      for (const cl of (row.value ?? []) as any[]) {
        flat.push({
          ...cl,
          userId: uid,
          userEmail: profile.email ?? "",
          userName: profile.name ?? "",
          memberNumber: profile.memberNumber ?? "",
        });
      }
    }
    flat.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return c.json({ claims: flat });
  } catch (err) {
    console.log(`Admin claims list error: ${err}`);
    return c.json({ error: `${err}` }, 500);
  }
});

app.post(`${PREFIX}/admin/claims/:userId/:claimId/status`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const userId = c.req.param("userId");
  const claimId = c.req.param("claimId");
  try {
    const body = await c.req.json().catch(() => ({}));
    const status = body.status as string;
    const note = (body.note as string) ?? "";
    if (!["en_cours", "valide", "rejete", "regle"].includes(status)) {
      return c.json({ error: "Statut invalide" }, 400);
    }
    const claims = (await kv.get(k.claims(userId))) ?? [];
    const idx = claims.findIndex((cl: any) => cl.id === claimId);
    if (idx === -1) return c.json({ error: "Sinistre introuvable" }, 404);
    claims[idx] = { ...claims[idx], status, adminNote: note, decidedAt: new Date().toISOString(), decidedBy: r.admin.username };
    await kv.set(k.claims(userId), claims);
    const notifs = (await kv.get(k.notifications(userId))) ?? [];
    const label = status === "valide" ? "validé" : status === "rejete" ? "rejeté" : status === "regle" ? "réglé" : "mis à jour";
    await kv.set(
      k.notifications(userId),
      notify(notifs, "Sinistre " + label, `Votre sinistre « ${claims[idx].type} » a été ${label}.`, status === "rejete" ? "warn" : "success"),
    );
    await audit(userId, "admin.claim.status", { claimId, status, by: r.admin.username });
    return c.json({ claim: claims[idx] });
  } catch (err) {
    console.log(`Admin claim update error: ${err}`);
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/stats`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const [profilesRes, claimsRes, paymentsRes] = await Promise.all([
      admin.from("kv_store_752d1a39").select("value", { count: "exact", head: true }).like("key", "profile:%"),
      admin.from("kv_store_752d1a39").select("key, value").like("key", "claims:%"),
      admin.from("kv_store_752d1a39").select("key, value").like("key", "payments:%"),
    ]);
    let pendingClaims = 0, totalClaims = 0;
    for (const row of claimsRes.data ?? []) for (const cl of (row.value ?? []) as any[]) {
      totalClaims++;
      if (cl.status === "en_cours") pendingClaims++;
    }
    let confirmedTotal = 0;
    for (const row of paymentsRes.data ?? []) for (const p of (row.value ?? []) as any[]) {
      if (p.status === "confirme") confirmedTotal += p.amount ?? 0;
    }
    return c.json({
      users: profilesRes.count ?? 0,
      claims: { total: totalClaims, pending: pendingClaims },
      revenue: confirmedTotal,
    });
  } catch (err) {
    console.log(`Admin stats error: ${err}`);
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- ADMIN: MEMBERS ----
app.get(`${PREFIX}/admin/members`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "profile:%");
    if (error) return c.json({ error: error.message }, 500);
    const members: any[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("profile:".length);
      const p = (row.value ?? {}) as any;
      const [contracts, claims, payments] = await Promise.all([
        kv.get(k.contracts(uid)).then((v) => (v ?? []) as any[]),
        kv.get(k.claims(uid)).then((v) => (v ?? []) as any[]),
        kv.get(k.payments(uid)).then((v) => (v ?? []) as any[]),
      ]);
      const activeContracts = contracts.filter((c: any) => c.status === "active").length;
      const pendingClaims = claims.filter((c: any) => c.status === "en_cours").length;
      const revenue = payments
        .filter((p: any) => p.status === "confirme")
        .reduce((s: number, p: any) => s + (p.amount ?? 0), 0);
      members.push({
        id: uid,
        email: p.email ?? "",
        name: p.name ?? "",
        phone: p.phone ?? "",
        memberNumber: p.memberNumber ?? "",
        createdAt: p.createdAt ?? null,
        suspended: !!p.suspended,
        activeContracts,
        pendingClaims,
        revenue,
      });
    }
    members.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return c.json({ members });
  } catch (err) {
    console.log(`Admin members list error: ${err}`);
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/member/:uid`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const [profile, contracts, claims, payments, beneficiaries, notifications, settings] = await Promise.all([
      kv.get(k.profile(uid)),
      kv.get(k.contracts(uid)),
      kv.get(k.claims(uid)),
      kv.get(k.payments(uid)),
      kv.get(k.beneficiaries(uid)),
      kv.get(k.notifications(uid)),
      kv.get(k.settings(uid)),
    ]);
    if (!profile) return c.json({ error: "Membre introuvable" }, 404);
    return c.json({
      profile,
      contracts: contracts ?? [],
      claims: claims ?? [],
      payments: payments ?? [],
      beneficiaries: beneficiaries ?? [],
      notifications: notifications ?? [],
      settings: settings ?? null,
    });
  } catch (err) {
    console.log(`Admin member detail error: ${err}`);
    return c.json({ error: `${err}` }, 500);
  }
});

app.post(`${PREFIX}/admin/member/:uid/suspend`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const body = await c.req.json().catch(() => ({}));
    const suspended = !!body.suspended;
    const p = (await kv.get(k.profile(uid))) ?? {};
    p.suspended = suspended;
    await kv.set(k.profile(uid), p);
    await audit(uid, "admin.member.suspend", { suspended, by: r.admin.username });
    return c.json({ ok: true, suspended });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- ADMIN: CONTRACTS (flat) ----
app.get(`${PREFIX}/admin/contracts`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "contracts:%");
    if (error) return c.json({ error: error.message }, 500);
    const flat: any[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("contracts:".length);
      const profile = (await kv.get(k.profile(uid))) ?? {};
      for (const ct of (row.value ?? []) as any[]) {
        flat.push({
          ...ct,
          userId: uid,
          userEmail: profile.email ?? "",
          userName: profile.name ?? "",
        });
      }
    }
    flat.sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
    return c.json({ contracts: flat });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- ADMIN: PAYMENTS (flat) ----
app.get(`${PREFIX}/admin/payments`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "payments:%");
    if (error) return c.json({ error: error.message }, 500);
    const flat: any[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("payments:".length);
      const profile = (await kv.get(k.profile(uid))) ?? {};
      for (const p of (row.value ?? []) as any[]) {
        flat.push({
          ...p,
          userId: uid,
          userEmail: profile.email ?? "",
          userName: profile.name ?? "",
        });
      }
    }
    flat.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return c.json({ payments: flat });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- ADMIN: BROADCAST ----
app.post(`${PREFIX}/admin/broadcast`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const body = await c.req.json();
    const title = (body.title ?? "").toString().trim();
    const text = (body.body ?? "").toString().trim();
    const type = ["info", "success", "warn"].includes(body.type) ? body.type : "info";
    if (!title || !text) return c.json({ error: "Titre et message requis" }, 400);
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key")
      .like("key", "profile:%");
    if (error) return c.json({ error: error.message }, 500);
    let count = 0;
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("profile:".length);
      const notifs = (await kv.get(k.notifications(uid))) ?? [];
      await kv.set(k.notifications(uid), notify(notifs, title, text, type));
      count++;
    }
    await audit(`admin:${r.admin.username}`, "admin.broadcast", { title, count });
    return c.json({ ok: true, recipients: count });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- SITE CONTENT (public read + admin update) ----
const DEFAULT_SITE = {
  brandName: "IPPOO ASSURANCE",
  tagline: "La micro-assurance qui prend soin de vous au Bénin",
  heroTitle: "Protégez ce qui compte vraiment",
  heroSubtitle: "Souscrivez en 2 minutes à une couverture sur mesure, payable en Mobile Money à partir de 500 FCFA par jour.",
  aboutShort: "IPPOO ASSURANCE est une mutuelle de micro-assurance enregistrée au Bénin, dédiée aux familles, commerçants et professionnels.",
  contactEmail: "ippooz.up.2@gmail.com",
  contactPhone: "+229 01 41 52 10 92",
  contactAddress: "Parakou, Borgou, Bénin",
  whatsapp: "+229 01 41 52 10 92",
  facebook: "",
  instagram: "",
  linkedin: "",
};

app.get(`${PREFIX}/site`, async (c) => {
  const site = (await kv.get(k.site())) ?? DEFAULT_SITE;
  return c.json({ site: { ...DEFAULT_SITE, ...site } });
});

app.put(`${PREFIX}/admin/site`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.ok) return c.json({ error: r.error }, 401);
  try {
    const body = await c.req.json();
    const current = (await kv.get(k.site())) ?? DEFAULT_SITE;
    const allow = [
      "brandName", "tagline", "heroTitle", "heroSubtitle", "aboutShort",
      "contactEmail", "contactPhone", "contactAddress", "whatsapp",
      "facebook", "instagram", "linkedin",
    ];
    const next: Record<string, string> = { ...current };
    for (const key of allow) {
      if (typeof body?.[key] === "string") next[key] = body[key].slice(0, 600);
    }
    await kv.set(k.site(), next);
    await audit(`admin:${r.admin.username}`, "admin.site.update", { count: Object.keys(body ?? {}).length });
    return c.json({ ok: true, site: next });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- PARTNERS (public read + admin CRUD) ----
const DEFAULT_PARTNERS = [
  { id: "p1", name: "Clinique Atinkanmey", kind: "clinique", address: "Carré 1234, Atinkanmey", city: "Cotonou", phone: "+229 21 30 12 34", lat: 6.3654, lng: 2.4183, hours: "24/7" },
  { id: "p2", name: "Pharmacie Camp Guézo", kind: "pharmacie", address: "Boulevard Saint-Michel", city: "Cotonou", phone: "+229 21 31 45 67", lat: 6.3725, lng: 2.4248, hours: "8h–22h" },
  { id: "p3", name: "Hôpital de la Mère et de l'Enfant", kind: "hopital", address: "Lagune de Cotonou", city: "Cotonou", phone: "+229 21 33 22 11", lat: 6.3568, lng: 2.4290, hours: "24/7" },
  { id: "p4", name: "Pharmacie Sainte-Rita", kind: "pharmacie", address: "Avenue Steinmetz", city: "Cotonou", phone: "+229 21 32 78 90", lat: 6.3601, lng: 2.4079, hours: "7h–23h" },
  { id: "p5", name: "Clinique Mahouna", kind: "clinique", address: "Quartier Akpakpa", city: "Cotonou", phone: "+229 21 33 56 78", lat: 6.3712, lng: 2.4501, hours: "24/7" },
  { id: "p6", name: "Pharmacie Notre-Dame", kind: "pharmacie", address: "Place Catchi", city: "Porto-Novo", phone: "+229 20 21 33 44", lat: 6.4969, lng: 2.6289, hours: "8h–21h" },
  { id: "p7", name: "Centre Hospitalier Porto-Novo", kind: "hopital", address: "Avenue Jean-Bayol", city: "Porto-Novo", phone: "+229 20 21 56 78", lat: 6.4895, lng: 2.6080, hours: "24/7" },
  { id: "p8", name: "Pharmacie Jéricho", kind: "pharmacie", address: "Quartier Jéricho", city: "Cotonou", phone: "+229 21 30 88 99", lat: 6.3611, lng: 2.3950, hours: "7h–22h" },
  { id: "p9", name: "Clinique Bouge", kind: "clinique", address: "Route de l'aéroport", city: "Cotonou", phone: "+229 21 30 44 55", lat: 6.3528, lng: 2.3848, hours: "24/7" },
  { id: "p10", name: "Pharmacie Tokpa", kind: "pharmacie", address: "Marché Dantokpa", city: "Cotonou", phone: "+229 21 32 11 22", lat: 6.3680, lng: 2.4350, hours: "6h–20h" },
];

app.get(`${PREFIX}/partners`, async (c) => {
  const partners = (await kv.get(k.partners())) ?? DEFAULT_PARTNERS;
  return c.json({ partners });
});

app.put(`${PREFIX}/admin/partners`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.ok) return c.json({ error: r.error }, 401);
  try {
    const body = await c.req.json();
    const raw = Array.isArray(body?.partners) ? body.partners : [];
    const partners = raw.slice(0, 200).map((p: any, i: number) => ({
      id: typeof p.id === "string" && p.id ? p.id.slice(0, 40) : `pt_${Date.now()}_${i}`,
      name: String(p.name ?? "").slice(0, 160),
      kind: ["clinique", "pharmacie", "hopital"].includes(p.kind) ? p.kind : "clinique",
      address: String(p.address ?? "").slice(0, 200),
      city: String(p.city ?? "").slice(0, 80),
      phone: String(p.phone ?? "").slice(0, 40),
      lat: Number(p.lat) || 0,
      lng: Number(p.lng) || 0,
      hours: String(p.hours ?? "").slice(0, 40),
    })).filter((p: any) => p.name);
    await kv.set(k.partners(), partners);
    await audit(`admin:${r.admin.username}`, "admin.partners.update", { count: partners.length });
    return c.json({ ok: true, partners });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- PROMOS (public read + admin CRUD) ----
app.get(`${PREFIX}/promos`, async (c) => {
  const promos = (await kv.get(k.promos())) ?? [];
  return c.json({ promos });
});

app.put(`${PREFIX}/admin/promos`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.ok) return c.json({ error: r.error }, 401);
  try {
    const body = await c.req.json();
    const raw = Array.isArray(body?.promos) ? body.promos : [];
    const promos = raw
      .filter((p: any) => p && typeof p.image === "string" && p.image.length > 0)
      .slice(0, 20)
      .map((p: any, i: number) => ({
        id: typeof p.id === "string" && p.id ? p.id.slice(0, 40) : `promo_${Date.now()}_${i}`,
        image: String(p.image).slice(0, 2000),
        alt: typeof p.alt === "string" ? p.alt.slice(0, 160) : "Annonce IPPOO",
        to: typeof p.to === "string" ? p.to.slice(0, 200) : "",
        active: p.active !== false,
      }));
    await kv.set(k.promos(), promos);
    await audit(`admin:${r.admin.username}`, "admin.promos.update", { count: promos.length });
    return c.json({ ok: true, promos });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- ADMIN: RECENT AUDIT ----
app.get(`${PREFIX}/admin/audit/recent`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "audit:%");
    if (error) return c.json({ error: error.message }, 500);
    const flat: any[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("audit:".length);
      const profile = (await kv.get(k.profile(uid))) ?? {};
      for (const e of (row.value ?? []) as any[]) {
        flat.push({ ...e, userId: uid, userEmail: profile.email ?? "", userName: profile.name ?? "" });
      }
    }
    flat.sort((a, b) => (a.at < b.at ? 1 : -1));
    return c.json({ entries: flat.slice(0, 200) });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- AUTO-DEBIT: monthly billing cycle ----
// Iterates over all users and, for every active contract whose nextBillingDate
// has elapsed and autoDebit is enabled, creates a pending monthly_premium
// payment and notifies the member to pay it via KkiaPay. Idempotent — won't
// re-create a payment for a cycle that already has one in en_attente or
// confirme for the current month.
async function runMonthlyBillingCycle(triggeredBy: string) {
  const { data, error } = await admin
    .from("kv_store_752d1a39")
    .select("key, value")
    .like("key", "contracts:%");
  if (error) throw new Error(error.message);
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let generated = 0;
  let skipped = 0;
  for (const row of data ?? []) {
    const uid = (row.key as string).slice("contracts:".length);
    const contracts = ((row.value ?? []) as any[]).slice();
    let changed = false;
    const payments = ((await kv.get(k.payments(uid))) ?? []) as any[];
    const notifs = ((await kv.get(k.notifications(uid))) ?? []) as any[];
    for (let i = 0; i < contracts.length; i++) {
      const ct = contracts[i];
      if (ct.status !== "active") continue;
      if (ct.autoDebit === false) { skipped++; continue; }
      const due = ct.nextBillingDate ? new Date(ct.nextBillingDate).getTime() : 0;
      if (due > now.getTime()) continue;
      const already = payments.some((p) =>
        p.contractId === ct.id &&
        p.purpose === "monthly_premium" &&
        (p.cycleKey === monthKey || (p.status === "confirme" && (p.confirmedAt ?? p.createdAt ?? "").startsWith(monthKey)))
      );
      if (already) { skipped++; continue; }
      const payment = {
        id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        contractId: ct.id,
        amount: ct.premium,
        currency: ct.currency ?? "XOF",
        method: "mobile_money",
        status: "en_attente" as const,
        purpose: "monthly_premium" as const,
        cycleKey: monthKey,
        mode: Deno.env.get("KKIAPAY_PUBLIC_KEY") ? "kkiapay" : "mock",
        createdAt: new Date().toISOString(),
      };
      payments.unshift(payment);
      notify(notifs, "Cotisation mensuelle à régler", `Votre prélèvement de ${ct.premium} FCFA pour « ${ct.product} » est à régler.`, "warn");
      contracts[i] = { ...ct, nextBillingDate: nextBillingFromNow() };
      changed = true;
      generated++;
    }
    if (changed) {
      await kv.set(k.payments(uid), payments);
      await kv.set(k.notifications(uid), notifs.slice(0, 200));
      await kv.set(k.contracts(uid), contracts);
    }
  }
  console.log(`[billing] cycle ${monthKey} by=${triggeredBy} generated=${generated} skipped=${skipped}`);
  return { cycleKey: monthKey, generated, skipped };
}

app.post(`${PREFIX}/admin/billing/run`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const res = await runMonthlyBillingCycle(r.admin.username);
    return c.json({ ok: true, ...res });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// Cron entrypoint protected by CRON_SECRET. Hook to Supabase Scheduled
// Functions / external cron to fire on the 1st of each month at 09:00 UTC+1.
app.post(`${PREFIX}/billing/cron`, async (c) => {
  const provided = c.req.header("X-Cron-Secret") ?? c.req.header("x-cron-secret") ?? "";
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || provided !== secret) return c.json({ error: "Cron non autorisé" }, 401);
  try {
    const res = await runMonthlyBillingCycle("cron");
    return c.json({ ok: true, ...res });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- CONTRACT: toggle autoDebit ----
app.patch(`${PREFIX}/contracts/:id/auto-debit`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const enabled = !!body?.enabled;
    const contracts = ((await kv.get(k.contracts(user.id))) ?? []) as any[];
    const idx = contracts.findIndex((ct: any) => ct.id === id);
    if (idx === -1) return c.json({ error: "Contrat introuvable" }, 404);
    contracts[idx] = { ...contracts[idx], autoDebit: enabled, nextBillingDate: enabled ? (contracts[idx].nextBillingDate ?? nextBillingFromNow()) : null };
    await kv.set(k.contracts(user.id), contracts);
    await audit(user.id, "contract.autoDebit", { id, enabled });
    return c.json({ contract: contracts[idx] });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ---- ADMIN: MESSAGES (list conversations + reply) ----
app.get(`${PREFIX}/admin/messages`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const statusFilter = (c.req.query("status") ?? "").trim();
  const mineOnly = c.req.query("mine") === "1";
  try {
    const { data, error } = await admin
      .from("kv_store_752d1a39")
      .select("key, value")
      .like("key", "messages:%");
    if (error) return c.json({ error: error.message }, 500);
    const convos: any[] = [];
    for (const row of data ?? []) {
      const uid = (row.key as string).slice("messages:".length);
      const list = (row.value ?? []) as any[];
      if (list.length === 0) continue;
      const profile = (await kv.get(k.profile(uid))) ?? {};
      const meta = (await kv.get(k.conversationMeta(uid))) ?? { status: "ouvert", assignee: null };
      const last = list[list.length - 1];
      const unread = list.filter((m) => m.from === "user" && !m.read).length;
      const hay = `${profile.email ?? ""} ${profile.name ?? ""} ${profile.memberNumber ?? ""} ${last?.body ?? ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (statusFilter && (meta.status ?? "ouvert") !== statusFilter) continue;
      if (mineOnly && meta.assignee !== r.admin.username) continue;
      convos.push({
        userId: uid,
        userEmail: profile.email ?? "",
        userName: profile.name ?? "",
        memberNumber: profile.memberNumber ?? "",
        lastMessage: last?.body ?? (last?.attachment ? `📎 ${last.attachment.name}` : ""),
        lastAt: last?.createdAt ?? "",
        lastFrom: last?.from ?? "user",
        unread,
        total: list.length,
        status: meta.status ?? "ouvert",
        assignee: meta.assignee ?? null,
        tags: meta.tags ?? [],
      });
    }
    convos.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return c.json({ conversations: convos });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// Update conversation meta (status / assignee / tags).
app.patch(`${PREFIX}/admin/messages/:uid/meta`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const body = await c.req.json();
    const current = (await kv.get(k.conversationMeta(uid))) ?? { status: "ouvert", assignee: null, tags: [] };
    const next = { ...current };
    if (body?.status && ["ouvert", "en_cours", "resolu"].includes(body.status)) next.status = body.status;
    if (body?.assignee !== undefined) next.assignee = body.assignee ? String(body.assignee).slice(0, 80) : null;
    if (Array.isArray(body?.tags)) next.tags = body.tags.slice(0, 8).map((t: any) => String(t).slice(0, 40));
    next.updatedAt = new Date().toISOString();
    await kv.set(k.conversationMeta(uid), next);
    await audit(uid, "conversation.meta", { by: r.admin.username, ...next });
    await broadcast(`admin:chat`, "meta:update", { userId: uid, meta: next });
    return c.json({ meta: next });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/messages/:uid`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const list = (await kv.get(k.messages(uid))) ?? [];
  let changed = 0;
  const marked = (list as any[]).map((m) => {
    if (m.from === "user" && !m.read) { changed++; return { ...m, read: true, readAt: new Date().toISOString() }; }
    return m;
  });
  if (changed > 0) {
    await kv.set(k.messages(uid), marked);
    await broadcast(`chat:${uid}`, "message:read", { count: changed, at: new Date().toISOString() });
  }
  return c.json({ messages: marked });
});

app.post(`${PREFIX}/admin/messages/:uid`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const body = await c.req.json();
    const content = String(body?.content ?? "").trim();
    if (!content) return c.json({ error: "Message vide" }, 400);
    const replyToId = typeof body?.replyToId === "string" ? body.replyToId : undefined;
    const msg: any = {
      id: `m_${Date.now()}`,
      from: "conseiller",
      author: `${r.admin.username} (IPPOO)`,
      body: content,
      createdAt: new Date().toISOString(),
      read: false,
    };
    if (replyToId) msg.replyToId = replyToId;
    const list = ((await kv.get(k.messages(uid))) ?? []) as any[];
    list.push(msg);
    await kv.set(k.messages(uid), list);
    const notifs = ((await kv.get(k.notifications(uid))) ?? []) as any[];
    await kv.set(k.notifications(uid), notify(notifs, "Nouveau message conseiller", content.slice(0, 120), "info"));
    await audit(uid, "message.admin_reply", { by: r.admin.username, length: content.length });
    await Promise.all([
      broadcast(`chat:${uid}`, "message:new", { message: msg }),
      broadcast(`admin:chat`, "message:new", { userId: uid, message: msg }),
    ]);
    return c.json({ message: msg });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// === Web Push (VAPID) ===
// Configure VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (mailto:contact@…)
// env vars to enable real push delivery. Without them, /push/vapid-public
// returns null and subscribe routes still store subscriptions (so the UI
// state stays correct), but pushUsers() will short-circuit.
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC") ?? null;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE") ?? null;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:contact@ippoo.example";

app.get(`${PREFIX}/push/vapid-public`, (c) => c.json({ publicKey: VAPID_PUBLIC }));

app.post(`${PREFIX}/push/subscribe`, async (c) => {
  const r = await requireUser(c);
  if (!r.user) return c.json({ error: r.error }, 401);
  try {
    const body = await c.req.json();
    const sub = body?.subscription;
    if (!sub?.endpoint) return c.json({ error: "subscription invalide" }, 400);
    const list = ((await kv.get(k.pushSubs(r.user.id))) ?? []) as any[];
    const next = list.filter((s) => s.endpoint !== sub.endpoint).concat([{ ...sub, createdAt: new Date().toISOString() }]);
    await kv.set(k.pushSubs(r.user.id), next.slice(-5));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.post(`${PREFIX}/push/unsubscribe`, async (c) => {
  const r = await requireUser(c);
  if (!r.user) return c.json({ error: r.error }, 401);
  try {
    const body = await c.req.json();
    const endpoint = String(body?.endpoint ?? "");
    const list = ((await kv.get(k.pushSubs(r.user.id))) ?? []) as any[];
    await kv.set(k.pushSubs(r.user.id), list.filter((s) => s.endpoint !== endpoint));
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

/** Send a push notification to one or many users. No-op when VAPID env unset. */
async function pushUsers(uids: string[], payload: { title: string; body: string; url?: string; tag?: string }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, skipped: uids.length, reason: "no-vapid" };
  let webpush: any;
  try {
    webpush = await import("npm:web-push@3.6.7");
    webpush.default.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (err) {
    console.error("web-push import failed", err);
    return { sent: 0, skipped: uids.length, reason: "import-failed" };
  }
  let sent = 0;
  let failed = 0;
  for (const uid of uids) {
    const subs = ((await kv.get(k.pushSubs(uid))) ?? []) as any[];
    for (const s of subs) {
      try {
        await webpush.default.sendNotification(s, JSON.stringify(payload));
        sent++;
      } catch (err: any) {
        failed++;
        // Stale subscription — drop on 404/410
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          const cur = ((await kv.get(k.pushSubs(uid))) ?? []) as any[];
          await kv.set(k.pushSubs(uid), cur.filter((x) => x.endpoint !== s.endpoint));
        }
      }
    }
  }
  return { sent, failed };
}
// Expose for callers within this module (notify helpers etc.)
(globalThis as any).__ippoo_pushUsers = pushUsers;

// === Wallet integrations ===
// Google Wallet — issues a signed JWT Save-to-Wallet link.
// Requires: GOOGLE_WALLET_ISSUER_ID, GOOGLE_WALLET_CLASS_ID,
// GOOGLE_WALLET_SA_EMAIL, GOOGLE_WALLET_SA_KEY (PEM private key).
const GW_ISSUER = Deno.env.get("GOOGLE_WALLET_ISSUER_ID") ?? null;
const GW_CLASS = Deno.env.get("GOOGLE_WALLET_CLASS_ID") ?? null;
const GW_SA_EMAIL = Deno.env.get("GOOGLE_WALLET_SA_EMAIL") ?? null;
const GW_SA_KEY = Deno.env.get("GOOGLE_WALLET_SA_KEY") ?? null;

async function importPemRsaKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = b64urlDecode(body.replace(/\+/g, "-").replace(/\//g, "_"));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

app.get(`${PREFIX}/wallet/google`, async (c) => {
  const r = await requireUser(c);
  if (!r.user) return c.json({ error: r.error }, 401);
  const configured = !!(GW_ISSUER && GW_CLASS && GW_SA_EMAIL && GW_SA_KEY);
  if (!configured) return c.json({ saveUrl: null, configured: false });
  try {
    const profile = (await kv.get(k.profile(r.user.id))) as any;
    const objectId = `${GW_ISSUER}.member-${r.user.id}`;
    const payload = {
      iss: GW_SA_EMAIL,
      aud: "google",
      typ: "savetowallet",
      iat: Math.floor(Date.now() / 1000),
      payload: {
        genericObjects: [{
          id: objectId,
          classId: GW_CLASS,
          state: "ACTIVE",
          cardTitle: { defaultValue: { language: "fr", value: "IPPOO Assurance" } },
          header: { defaultValue: { language: "fr", value: profile?.name ?? "Membre IPPOO" } },
          subheader: { defaultValue: { language: "fr", value: "Carte Membre" } },
          textModulesData: [{ header: "N° Membre", body: profile?.memberNumber ?? "—" }],
          barcode: { type: "QR_CODE", value: profile?.memberNumber ?? r.user.id, alternateText: profile?.memberNumber ?? "" },
        }],
      },
    };
    const header = { alg: "RS256", typ: "JWT" };
    const h64 = b64urlEncode(enc.encode(JSON.stringify(header)));
    const p64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
    const signingInput = `${h64}.${p64}`;
    const key = await importPemRsaKey(GW_SA_KEY!);
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
    const jwt = `${signingInput}.${b64urlEncode(sig)}`;
    return c.json({ saveUrl: `https://pay.google.com/gp/v/save/${jwt}`, configured: true });
  } catch (err) {
    return c.json({ saveUrl: null, configured: true, error: `${err}` }, 500);
  }
});

// Apple Wallet — signed .pkpass requires Apple Developer Pass Type ID cert.
// Without APPLE_PASS_CERT + APPLE_PASS_KEY, we return 503 with a clear msg.
app.get(`${PREFIX}/wallet/apple`, (c) => {
  return c.json(
    { error: "Apple Wallet non configuré (Pass Type ID requis)", configured: false },
    503,
  );
});

// Catch-all to surface unmatched paths with helpful detail (instead of bare 404)
app.all("*", (c) => {
  return c.json(
    { error: `Route inconnue: ${c.req.method} ${new URL(c.req.url).pathname}` },
    404,
  );
});

// rev: 2026-05-26-08 (messagerie: server-side Realtime broadcast on user send + admin reply)
Deno.serve(app.fetch);
