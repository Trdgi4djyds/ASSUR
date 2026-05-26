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

const ADMIN_USERNAME = (Deno.env.get("ADMIN_USERNAME") ?? "").trim();
const ADMIN_PASSWORD = (Deno.env.get("ADMIN_PASSWORD") ?? "").trim();
const ADMIN_TOKEN_TTL_SEC = 60 * 60 * 8; // 8h

async function requireAdminToken(c: any) {
  const token = c.req.header("X-Admin-Token") ?? c.req.header("x-admin-token");
  if (!token) return { admin: null, error: "missing-admin-token", status: 401 as const };
  const payload = await verifyToken<{ kind: string; username: string; exp: number }>(token);
  if (!payload || payload.kind !== "admin") return { admin: null, error: "invalid-admin-token", status: 401 as const };
  if (Date.now() / 1000 > payload.exp) return { admin: null, error: "expired-admin-token", status: 401 as const };
  return { admin: { username: payload.username }, error: null, status: 200 as const, ok: true };
}

async function requireUser(c: any) {
  const userToken =
    c.req.header("X-User-Token") ??
    c.req.header("x-user-token") ??
    c.req.header("Authorization")?.split(" ")[1];
  if (!userToken) return { user: null, error: "missing-token" };
  const { data, error } = await admin.auth.getUser(userToken);
  if (error || !data.user) return { user: null, error: error?.message ?? "invalid-token" };
  return { user: data.user, error: null };
}

// --- HMAC signing for QR tokens & Admin tokens ---
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
  const { data } = await admin.from("hmac_secrets").select("value").eq("key", "system:hmac:secret").maybeSingle();
  let secret = data?.value;
  if (!secret) {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    secret = b64urlEncode(buf);
    await admin.from("hmac_secrets").upsert({ key: "system:hmac:secret", value: secret });
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
    const { data } = await admin.from("profiles").select("id").eq("member_number", candidate).maybeSingle();
    if (!data) {
      await admin.from("profiles").update({ member_number: candidate }).eq("id", uid);
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

async function auditLog(uid: string, action: string, meta: Record<string, any> = {}) {
  try {
    await admin.from("audit_log").insert({ user_id: uid, action, meta });
  } catch (err) {
    console.log(`Audit log error for ${uid}/${action}: ${err}`);
  }
}

// Rate limiting using system_config table (JSON-based rolling window)
async function rateLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const now = Date.now();
  const { data } = await admin.from("system_config").select("value").eq("key", `rate:${key}`).maybeSingle();
  const existing = (data?.value as any) ?? { count: 0, resetAt: now + windowSec * 1000 };
  if (now > existing.resetAt) {
    await admin.from("system_config").upsert({ key: `rate:${key}`, value: { count: 1, resetAt: now + windowSec * 1000 } });
    return true;
  }
  if (existing.count >= max) return false;
  await admin.from("system_config").upsert({ key: `rate:${key}`, value: { count: existing.count + 1, resetAt: existing.resetAt } });
  return true;
}

async function guardRate(
  c: any, scope: string, id: string, max: number, windowSec: number,
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

function formatXOFInt(n: number) {
  return `${Math.round(n).toLocaleString("fr-FR")} F CFA`;
}

// Helper to add a notification for a user
async function addNotification(uid: string, title: string, body: string, type = "info") {
  try {
    await admin.from("notifications").insert({
      user_id: uid, title, body, type, read: false,
    });
  } catch (err) {
    console.log(`Notification insert error for ${uid}: ${err}`);
  }
}

// Map DB profile row to frontend-expected camelCase
function mapProfile(p: any) {
  if (!p) return null;
  return {
    id: p.id,
    email: p.email,
    name: p.name,
    phone: p.phone,
    memberNumber: p.member_number,
    cardActive: p.card_active,
    cardIssuedAt: p.card_issued_at,
    createdAt: p.created_at,
    type: p.type,
    firstName: p.first_name,
    lastName: p.last_name,
    gender: p.gender,
    birthDate: p.birth_date,
    birthPlace: p.birth_place,
    profession: p.profession,
    companyName: p.company_name,
    ifu: p.ifu,
    idType: p.id_type,
    idNumber: p.id_number,
    country: p.country,
    countryDial: p.country_dial,
    department: p.department,
    city: p.city,
    quartier: p.quartier,
    suspended: p.suspended,
  };
}

function mapContract(c: any) {
  if (!c) return null;
  return {
    id: c.id,
    product: c.product,
    status: c.status,
    startDate: c.start_date,
    endDate: c.end_date,
    premium: c.premium,
    currency: c.currency,
    frequency: c.frequency,
    autoDebit: c.auto_debit,
    nextBillingDate: c.next_billing_date,
    lastPaidAt: c.last_paid_at,
  };
}

function mapClaim(c: any, attachments: any[] = []) {
  if (!c) return null;
  return {
    id: c.id,
    contractId: c.contract_id,
    type: c.type,
    description: c.description,
    amount: c.amount,
    status: c.status,
    createdAt: c.created_at,
    adminNote: c.admin_note,
    decidedAt: c.decided_at,
    decidedBy: c.decided_by,
    attachments: attachments.map((a: any) => ({ path: a.path, name: a.name, size: a.size })),
  };
}

function mapPayment(p: any) {
  if (!p) return null;
  return {
    id: p.id,
    contractId: p.contract_id,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    status: p.status,
    purpose: p.purpose,
    createdAt: p.created_at,
    confirmedAt: p.confirmed_at,
    label: p.label,
  };
}

function mapBeneficiary(b: any) {
  if (!b) return null;
  return {
    id: b.id,
    name: b.name,
    relation: b.relation,
    birthDate: b.birth_date,
    createdAt: b.created_at,
  };
}

function mapNotification(n: any) {
  if (!n) return null;
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    type: n.type,
    read: n.read,
    createdAt: n.created_at,
  };
}

function mapMessage(m: any, attachment?: any) {
  if (!m) return null;
  return {
    id: m.id,
    from: m.from_role,
    author: m.author,
    body: m.body,
    createdAt: m.created_at,
    read: m.read,
    replyToId: m.reply_to_id,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    ...(attachment ? { attachment: { name: attachment.name, mime: attachment.mime, size: attachment.size, path: attachment.path } } : {}),
  };
}

function mapSettings(s: any) {
  if (!s) return { lang: "fr", notifySms: true, notifyEmail: true };
  return { lang: s.lang, notifySms: s.notify_sms, notifyEmail: s.notify_email };
}

// Apply payment-confirmation side effects based on the payment's `purpose`.
async function applyPaymentSideEffects(userId: string, paymentRow: any) {
  const purpose = paymentRow?.purpose ?? "cotisation";
  try {
    if (purpose === "renewal" && paymentRow.contract_id) {
      const { data: ct } = await admin.from("contracts").select("*").eq("id", paymentRow.contract_id).maybeSingle();
      if (ct) {
        const baseEnd = Math.max(Date.now(), new Date(ct.end_date).getTime());
        const newEnd = new Date(baseEnd + 365 * 86400000).toISOString();
        await admin.from("contracts").update({
          status: "active", end_date: newEnd, renewal_notice_sent: false,
          next_billing_date: nextBillingFromNow(),
        }).eq("id", paymentRow.contract_id);
        await addNotification(userId, "Contrat renouvelé", `« ${ct.product} » est prolongé jusqu'au ${new Date(newEnd).toLocaleDateString("fr-FR")}.`, "success");
      }
    } else if (purpose === "card_activation") {
      const { data: profile } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
      let memberNumber = profile?.member_number;
      if (!memberNumber) memberNumber = await assignMemberNumber(userId);
      await admin.from("profiles").update({ card_active: true, card_issued_at: new Date().toISOString() }).eq("id", userId);
      await addNotification(userId, "Carte membre activée", `Votre carte IPPOO n° ${memberNumber} est désormais active.`, "success");
    } else if (purpose === "monthly_premium" && paymentRow.contract_id) {
      await admin.from("contracts").update({
        last_paid_at: new Date().toISOString(), next_billing_date: nextBillingFromNow(),
      }).eq("id", paymentRow.contract_id);
      const { data: ct } = await admin.from("contracts").select("product").eq("id", paymentRow.contract_id).maybeSingle();
      await addNotification(userId, "Cotisation mensuelle reçue", `Paiement de ${paymentRow.amount} FCFA confirmé pour « ${ct?.product ?? ""} ».`, "success");
    } else {
      await addNotification(userId, "Cotisation reçue", `Paiement de ${paymentRow.amount} FCFA confirmé.`, "success");
    }
  } catch (err) {
    console.log(`[side-effect] purpose=${purpose} user=${userId} payment=${paymentRow?.id}: ${err}`);
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
    if (!apiKey) return;
    const { data: profile } = await admin.from("profiles").select("email, name").eq("id", userId).maybeSingle();
    const email = profile?.email;
    if (!email) return;
    let contractProduct = null;
    if (payment.contract_id) {
      const { data: ct } = await admin.from("contracts").select("product").eq("id", payment.contract_id).maybeSingle();
      contractProduct = ct?.product ?? null;
    }
    const invoiceNumber = `INV-${String(payment.id).slice(-8).toUpperCase()}`;
    const dateStr = new Date(payment.created_at).toLocaleDateString("fr-FR");
    const lineLabel = contractProduct ? `Cotisation – ${contractProduct}` : (payment.label ?? "Cotisation IPPOO");
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
          <p style="margin:20px 0 0;color:#888;font-size:12px">IPPOO Assurance — La micro-assurance qui prend soin de vous au Bénin.</p>
        </div>
      </div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from, to: [email], subject: `Facture ${invoiceNumber} — ${total}`, html }),
    });
    if (!res.ok) console.log(`[email] Resend error ${res.status} for ${payment.id}`);
  } catch (err) {
    console.log(`[email] sendInvoiceEmail failed: ${err}`);
  }
}

app.get(`${PREFIX}/health`, (c) => c.json({ status: "ok" }));

// ============================================================
// SIGNUP
// ============================================================
app.post(`${PREFIX}/signup`, async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const allowed = await rateLimit(`signup:${ip}`, 5, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, réessayez dans 10 min." }, 429);
    const parsed = await parseBody(c, SignupSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { email, password, name, phone, referralCode, profile: profileDetails } = parsed.data;
    const { data, error } = await admin.auth.admin.createUser({
      email, password,
      user_metadata: { name, phone, profileType: profileDetails?.type ?? "particulier" },
      email_confirm: true,
    });
    if (error) {
      const msg = /already been registered|already registered|user already exists/i.test(error.message)
        ? "Cet email est déjà associé à un compte IPPOO."
        : error.message;
      return c.json({ error: msg, code: "email_taken" }, 400);
    }
    const uid = data.user!.id;
    const now = new Date().toISOString();
    const memberNumber = randomMemberNumber();
    const referralCodeForUser = makeReferralCode(name);

    // Find referrer if code provided
    let referredByUid: string | null = null;
    if (referralCode && typeof referralCode === "string") {
      const { data: ref } = await admin.from("profiles").select("id").eq("referral_code", referralCode.toUpperCase().trim()).maybeSingle();
      if (ref?.id && ref.id !== uid) referredByUid = ref.id;
    }

    // Ensure member number is unique
    let finalMemberNumber = memberNumber;
    for (let i = 0; i < 12; i++) {
      const { data: existing } = await admin.from("profiles").select("id").eq("member_number", finalMemberNumber).maybeSingle();
      if (!existing) break;
      finalMemberNumber = randomMemberNumber();
    }

    await admin.from("profiles").insert({
      id: uid, email, name, phone: phone ?? "", member_number: finalMemberNumber,
      created_at: now, type: profileDetails?.type ?? "particulier",
      first_name: profileDetails?.firstName ?? null, last_name: profileDetails?.lastName ?? null,
      gender: profileDetails?.gender ?? null, birth_date: profileDetails?.birthDate ?? null,
      birth_place: profileDetails?.birthPlace ?? null, profession: profileDetails?.profession ?? null,
      company_name: profileDetails?.companyName ?? null, ifu: profileDetails?.ifu ?? null,
      id_type: profileDetails?.idType ?? null, id_number: profileDetails?.idNumber ?? null,
      country: profileDetails?.country ?? "BJ", country_dial: profileDetails?.countryDial ?? "229",
      department: profileDetails?.department ?? null, city: profileDetails?.city ?? null,
      quartier: profileDetails?.quartier ?? null, referral_code: referralCodeForUser,
      referred_by: referredByUid,
    });

    await admin.from("settings").insert({ user_id: uid, lang: "fr", notify_sms: true, notify_email: true });

    await addNotification(uid, "Bienvenue chez IPPOO", "Votre espace est prêt. Souscrivez à une couverture pour démarrer.", "success");

    // Notify referrer
    if (referredByUid) {
      await addNotification(referredByUid, "Parrainage validé", `Un nouveau filleul rejoint IPPOO grâce à votre code ${referralCode}.`, "success");
    }

    await auditLog(uid, "signup", { email, ip });
    return c.json({ ok: true });
  } catch (err) {
    console.log(`Signup exception: ${err}`);
    return c.json({ error: `Erreur serveur lors de l'inscription: ${err}` }, 500);
  }
});

// ============================================================
// ME (Profile)
// ============================================================
app.get(`${PREFIX}/me`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: profile } = await admin.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (profile && !profile.member_number) {
    const memberNumber = await assignMemberNumber(user.id);
    return c.json({ profile: mapProfile({ ...profile, member_number: memberNumber }) });
  }
  return c.json({ profile: mapProfile(profile) });
});

app.put(`${PREFIX}/me`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const parsed = await parseBody(c, ProfileUpdateSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const d = parsed.data as any;
    const updates: Record<string, any> = {};
    if (d.name !== undefined) updates.name = d.name;
    if (d.phone !== undefined) updates.phone = d.phone;
    if (d.firstName !== undefined) updates.first_name = d.firstName;
    if (d.lastName !== undefined) updates.last_name = d.lastName;
    if (d.gender !== undefined) updates.gender = d.gender;
    if (d.birthDate !== undefined) updates.birth_date = d.birthDate;
    if (d.birthPlace !== undefined) updates.birth_place = d.birthPlace;
    if (d.profession !== undefined) updates.profession = d.profession;
    if (d.companyName !== undefined) updates.company_name = d.companyName;
    if (d.ifu !== undefined) updates.ifu = d.ifu;
    if (d.idType !== undefined) updates.id_type = d.idType;
    if (d.idNumber !== undefined) updates.id_number = d.idNumber;
    if (d.country !== undefined) updates.country = d.country;
    if (d.countryDial !== undefined) updates.country_dial = d.countryDial;
    if (d.department !== undefined) updates.department = d.department;
    if (d.city !== undefined) updates.city = d.city;
    if (d.quartier !== undefined) updates.quartier = d.quartier;
    const { data: updated } = await admin.from("profiles").update(updates).eq("id", user.id).select("*").maybeSingle();
    return c.json({ profile: mapProfile(updated) });
  } catch (err) {
    return c.json({ error: `Erreur de mise à jour du profil: ${err}` }, 500);
  }
});

// ============================================================
// CONTRACTS
// ============================================================
app.get(`${PREFIX}/contracts`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: contracts } = await admin.from("contracts").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  return c.json({ contracts: (contracts ?? []).map(mapContract) });
});

app.patch(`${PREFIX}/contracts/:id/auto-debit`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const enabled = !!body?.enabled;
    const { data: ct } = await admin.from("contracts").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!ct) return c.json({ error: "Contrat introuvable" }, 404);
    const { data: updated } = await admin.from("contracts").update({
      auto_debit: enabled,
      next_billing_date: enabled ? (ct.next_billing_date ?? nextBillingFromNow()) : null,
    }).eq("id", id).select("*").maybeSingle();
    await auditLog(user.id, "contract.autoDebit", { id, enabled });
    return c.json({ contract: mapContract(updated) });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// CLAIMS
// ============================================================
app.get(`${PREFIX}/claims`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: claims } = await admin.from("claims").select("*, claim_attachments(*)").eq("user_id", user.id).order("created_at", { ascending: false });
  return c.json({ claims: (claims ?? []).map((cl: any) => mapClaim(cl, cl.claim_attachments ?? [])) });
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
    const { data: claim } = await admin.from("claims").insert({
      user_id: user.id, contract_id: contractId ?? null, type, description,
      amount: typeof amount === "number" ? amount : 0, status: "en_cours",
    }).select("*").maybeSingle();
    await addNotification(user.id, "Sinistre déclaré", `Votre déclaration « ${type} » est en cours d'instruction.`, "info");
    return c.json({ claim: mapClaim(claim) });
  } catch (err) {
    return c.json({ error: `Erreur de création du sinistre: ${err}` }, 500);
  }
});

// Upload attachment for a claim
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
    // Verify claim belongs to user
    const { data: cl } = await admin.from("claims").select("id").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!cl) return c.json({ error: "Sinistre introuvable" }, 404);
    await admin.from("claim_attachments").insert({ claim_id: id, user_id: user.id, path, name: file.name, size: file.size });
    return c.json({ ok: true, attachment: { path, name: file.name, size: file.size } });
  } catch (err) {
    return c.json({ error: `Erreur d'upload: ${err}` }, 500);
  }
});

app.get(`${PREFIX}/claims/attachments/url`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const path = c.req.query("path");
  if (!path || !path.startsWith(`${user.id}/`)) return c.json({ error: "Chemin invalide" }, 400);
  const { data, error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(path, 300);
  if (signErr) return c.json({ error: signErr.message }, 500);
  return c.json({ url: data.signedUrl });
});

// ============================================================
// PAYMENTS
// ============================================================
app.get(`${PREFIX}/payments`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: payments } = await admin.from("payments").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  return c.json({ payments: (payments ?? []).map(mapPayment) });
});

app.get(`${PREFIX}/payments/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const { data: payment } = await admin.from("payments").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!payment) return c.json({ error: "Paiement introuvable" }, 404);
  return c.json({ payment: mapPayment(payment) });
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
    const { data: payment } = await admin.from("payments").insert({
      user_id: user.id, contract_id: contractId ?? null, amount,
      currency: "XOF", method: method ?? "mobile_money", status: "en_attente", purpose: "cotisation",
    }).select("*").maybeSingle();
    return c.json({ payment: mapPayment(payment) });
  } catch (err) {
    return c.json({ error: `Erreur de cotisation: ${err}` }, 500);
  }
});

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
    let payment: any;
    if (paymentId) {
      const { data: existing } = await admin.from("payments").select("*").eq("id", paymentId).eq("user_id", user.id).maybeSingle();
      if (!existing) return c.json({ error: "Paiement introuvable" }, 404);
      if (existing.status === "confirme") return c.json({ error: "Déjà confirmé" }, 400);
      const { data: updated } = await admin.from("payments").update({ status: "en_attente" }).eq("id", paymentId).select("*").maybeSingle();
      payment = updated;
    } else {
      const { data: created } = await admin.from("payments").insert({
        user_id: user.id, contract_id: contractId ?? null, amount, currency: "XOF",
        method: "mobile_money", status: "en_attente", purpose: purpose ?? "cotisation",
      }).select("*").maybeSingle();
      payment = created;
    }
    await auditLog(user.id, "payment.initiated", { id: payment.id, amount, mode, purpose: payment.purpose });
    const mapped = mapPayment(payment);
    return c.json({ payment: { ...mapped, mode }, kkiapay: { publicKey, sandbox: !Deno.env.get("KKIAPAY_SECRET") } });
  } catch (err) {
    return c.json({ error: `Erreur initialisation paiement: ${err}` }, 500);
  }
});

app.post(`${PREFIX}/payments/webhook`, async (c) => {
  try {
    const secret = Deno.env.get("KKIAPAY_SECRET");
    const provided = c.req.header("X-Kkiapay-Secret") ?? c.req.header("x-kkiapay-secret") ?? "";
    if (!secret || provided !== secret) return c.json({ error: "Signature invalide" }, 401);
    const body = await c.req.json();
    const { state, data, amount } = body ?? {};
    const paymentId = data?.paymentId;
    const userId = data?.userId;
    if (!paymentId || !userId) return c.json({ error: "Données manquantes" }, 400);
    const { data: payment } = await admin.from("payments").select("*").eq("id", paymentId).maybeSingle();
    if (!payment) return c.json({ error: "Paiement introuvable" }, 404);
    const next = state === "SUCCESS" ? "confirme" : "echec";
    const { data: updated } = await admin.from("payments").update({ status: next, confirmed_at: new Date().toISOString() }).eq("id", paymentId).select("*").maybeSingle();
    if (next === "confirme") {
      await applyPaymentSideEffects(userId, updated);
      sendInvoiceEmail(userId, updated);
    }
    await auditLog(userId, `payment.${next}`, { id: paymentId, amount, purpose: payment.purpose });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "Erreur webhook" }, 500);
  }
});

app.post(`${PREFIX}/payments/:id/confirm-mock`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  if (Deno.env.get("KKIAPAY_SECRET") || Deno.env.get("APP_ENV") === "production" || Deno.env.get("KKIAPAY_PUBLIC_KEY")) {
    return c.json({ error: "Mode mock désactivé : passez par KkiaPay." }, 403);
  }
  const id = c.req.param("id");
  const { data: payment } = await admin.from("payments").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!payment) return c.json({ error: "Paiement introuvable" }, 404);
  if (payment.status === "confirme") return c.json({ payment: mapPayment(payment) });
  const { data: updated } = await admin.from("payments").update({ status: "confirme", confirmed_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  await applyPaymentSideEffects(user.id, updated);
  await auditLog(user.id, "payment.confirme", { id, mode: "mock", purpose: payment.purpose });
  sendInvoiceEmail(user.id, updated);
  return c.json({ payment: mapPayment(updated) });
});

// ============================================================
// BENEFICIARIES
// ============================================================
app.get(`${PREFIX}/beneficiaries`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: beneficiaries } = await admin.from("beneficiaries").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  return c.json({ beneficiaries: (beneficiaries ?? []).map(mapBeneficiary) });
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
    const { data: beneficiary } = await admin.from("beneficiaries").insert({
      user_id: user.id, name, relation, birth_date: birthDate ?? null,
    }).select("*").maybeSingle();
    return c.json({ beneficiary: mapBeneficiary(beneficiary) });
  } catch (err) {
    return c.json({ error: `Erreur d'ajout du bénéficiaire: ${err}` }, 500);
  }
});

app.delete(`${PREFIX}/beneficiaries/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  await admin.from("beneficiaries").delete().eq("id", id).eq("user_id", user.id);
  return c.json({ ok: true });
});

// ============================================================
// DOCUMENTS
// ============================================================
app.get(`${PREFIX}/documents`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: documents } = await admin.from("documents").select("*").eq("user_id", user.id).order("created_at", { ascending: false });
  return c.json({
    documents: (documents ?? []).map((d: any) => ({
      id: d.id, name: d.name, type: d.type, category: d.category, size: d.size, createdAt: d.created_at,
    })),
  });
});

// ============================================================
// NOTIFICATIONS
// ============================================================
app.get(`${PREFIX}/notifications`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: notifications } = await admin.from("notifications").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
  return c.json({ notifications: (notifications ?? []).map(mapNotification) });
});

app.post(`${PREFIX}/notifications/read`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  await admin.from("notifications").update({ read: true }).eq("user_id", user.id).eq("read", false);
  return c.json({ ok: true });
});

// ============================================================
// MESSAGES
// ============================================================
const EDIT_WINDOW_MS = 5 * 60 * 1000;

async function getMessageWithAttachment(msgRow: any) {
  if (!msgRow) return null;
  const { data: att } = await admin.from("message_attachments").select("*").eq("message_id", msgRow.id).maybeSingle();
  return mapMessage(msgRow, att);
}

app.get(`${PREFIX}/messages`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: messages } = await admin.from("messages").select("*, message_attachments(*)").eq("user_id", user.id).order("created_at", { ascending: true });
  return c.json({
    messages: (messages ?? []).map((m: any) =>
      mapMessage(m, m.message_attachments?.[0])
    ),
  });
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
    const replyToId = typeof (parsed.data as any).replyToId === "string" ? (parsed.data as any).replyToId : null;
    const { data: profile } = await admin.from("profiles").select("name").eq("id", user.id).maybeSingle();
    const { data: msg } = await admin.from("messages").insert({
      user_id: user.id, from_role: "user", author: profile?.name ?? "Vous",
      body: content, read: true, reply_to_id: replyToId,
    }).select("*").maybeSingle();
    const mapped = mapMessage(msg);
    await Promise.all([
      broadcast(`chat:${user.id}`, "message:new", { message: mapped }),
      broadcast(`admin:chat`, "message:new", { userId: user.id, message: mapped }),
    ]);
    return c.json({ messages: [mapped] });
  } catch (err) {
    return c.json({ error: `Erreur lors de l'envoi: ${err}` }, 500);
  }
});

app.patch(`${PREFIX}/messages/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const parsed = await parseBody(c, MessageEditSchema);
  if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
  const { data: m } = await admin.from("messages").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!m) return c.json({ error: "Message introuvable" }, 404);
  if (m.from_role !== "user") return c.json({ error: "Édition refusée" }, 403);
  if (m.deleted_at) return c.json({ error: "Message supprimé" }, 410);
  if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) return c.json({ error: "Fenêtre d'édition expirée" }, 409);
  const { data: updated } = await admin.from("messages").update({ body: parsed.data.content.trim(), edited_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  const mapped = mapMessage(updated);
  await Promise.all([
    broadcast(`chat:${user.id}`, "message:update", { message: mapped }),
    broadcast(`admin:chat`, "message:update", { userId: user.id, message: mapped }),
  ]);
  return c.json({ message: mapped });
});

app.delete(`${PREFIX}/messages/:id`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const id = c.req.param("id");
  const { data: m } = await admin.from("messages").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!m) return c.json({ error: "Message introuvable" }, 404);
  if (m.from_role !== "user") return c.json({ error: "Suppression refusée" }, 403);
  const { data: updated } = await admin.from("messages").update({ body: "", deleted_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  const mapped = mapMessage(updated);
  await Promise.all([
    broadcast(`chat:${user.id}`, "message:update", { message: mapped }),
    broadcast(`admin:chat`, "message:update", { userId: user.id, message: mapped }),
  ]);
  return c.json({ message: mapped });
});

app.post(`${PREFIX}/messages/read`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { count } = await admin.from("messages").update({ read: true }).eq("user_id", user.id).eq("from_role", "conseiller").eq("read", false).select("*", { count: "exact", head: true });
  const changed = count ?? 0;
  if (changed > 0) {
    await broadcast(`admin:chat`, "message:read", { userId: user.id, count: changed, at: new Date().toISOString() });
  }
  return c.json({ ok: true, marked: changed });
});

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
    const { data: profile } = await admin.from("profiles").select("name").eq("id", user.id).maybeSingle();
    const { data: msg } = await admin.from("messages").insert({
      user_id: user.id, from_role: "user", author: profile?.name ?? "Vous", body: caption, read: true,
    }).select("*").maybeSingle();
    await admin.from("message_attachments").insert({ message_id: msg.id, name: file.name, mime: file.type, size: file.size, path });
    const mapped = mapMessage(msg, { name: file.name, mime: file.type, size: file.size, path });
    await Promise.all([
      broadcast(`chat:${user.id}`, "message:new", { message: mapped }),
      broadcast(`admin:chat`, "message:new", { userId: user.id, message: mapped }),
    ]);
    return c.json({ message: mapped });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

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

// ============================================================
// SUBSCRIBE (new contract)
// ============================================================
const BILLING = {
  dailyPerProduct: 500,
  daysPerMonth: 31,
  accountFee: 1000,
  cardFee: 500,
};

app.post(`${PREFIX}/subscribe`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "sub", user.id, 10, 3600);
  if (limited) return limited;
  try {
    const parsed = await parseBody(c, SubscribeSchema);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const { product, frequency } = parsed.data;
    const now = new Date();
    const { data: contract } = await admin.from("contracts").insert({
      user_id: user.id, product, status: "active",
      start_date: now.toISOString(),
      end_date: new Date(now.getTime() + 365 * 86400000).toISOString(),
      premium: BILLING.dailyPerProduct * BILLING.daysPerMonth,
      currency: "XOF", frequency: frequency ?? "mensuel",
      auto_debit: true, next_billing_date: nextBillingFromNow(),
    }).select("*").maybeSingle();
    await addNotification(user.id, "Souscription confirmée", `Votre contrat « ${product} » est actif.`, "success");
    return c.json({ contract: mapContract(contract) });
  } catch (err) {
    return c.json({ error: `Erreur de souscription: ${err}` }, 500);
  }
});

// ============================================================
// SETTINGS
// ============================================================
app.get(`${PREFIX}/settings`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: settings } = await admin.from("settings").select("*").eq("user_id", user.id).maybeSingle();
  return c.json({ settings: mapSettings(settings) });
});

app.put(`${PREFIX}/settings`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const updates = await c.req.json();
    const patch: Record<string, any> = {};
    if (updates.lang !== undefined) patch.lang = updates.lang;
    if (updates.notifySms !== undefined) patch.notify_sms = updates.notifySms;
    if (updates.notifyEmail !== undefined) patch.notify_email = updates.notifyEmail;
    const { data: settings } = await admin.from("settings").upsert({ user_id: user.id, ...patch }).select("*").maybeSingle();
    return c.json({ settings: mapSettings(settings) });
  } catch (err) {
    return c.json({ error: `Erreur sauvegarde paramètres: ${err}` }, 500);
  }
});

// ============================================================
// CHANGE PASSWORD
// ============================================================
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
      await auditLog(user.id, "password.change.failed", { reason: updateErr.message });
      return c.json({ error: updateErr.message }, 400);
    }
    await auditLog(user.id, "password.change", {});
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `Erreur changement mot de passe: ${err}` }, 500);
  }
});

// ============================================================
// CONTRACT RENEWALS CHECK
// ============================================================
app.post(`${PREFIX}/contracts/check-renewals`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  try {
    const { data: contracts } = await admin.from("contracts").select("*").eq("user_id", user.id).eq("status", "active");
    const now = Date.now();
    let pushed = 0;
    for (const ct of contracts ?? []) {
      if (!ct.end_date) continue;
      const end = new Date(ct.end_date).getTime();
      const days = Math.ceil((end - now) / 86400000);
      if (days <= 30 && days >= 0 && !ct.renewal_notice_sent) {
        await addNotification(user.id, "Échéance proche", `Votre contrat « ${ct.product} » arrive à échéance dans ${days} jour${days > 1 ? "s" : ""}.`, "warn");
        await admin.from("contracts").update({ renewal_notice_sent: true }).eq("id", ct.id);
        pushed++;
      } else if (days > 30 && ct.renewal_notice_sent) {
        await admin.from("contracts").update({ renewal_notice_sent: false }).eq("id", ct.id);
      }
    }
    return c.json({ pushed });
  } catch (err) {
    return c.json({ error: `Erreur de vérification des échéances: ${err}` }, 500);
  }
});

// ============================================================
// RENEW CONTRACT
// ============================================================
app.post(`${PREFIX}/contracts/:id/renew`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "renew", user.id, 10, 3600);
  if (limited) return limited;
  const id = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const phone = typeof body.phone === "string" ? body.phone : null;
    const { data: ct } = await admin.from("contracts").select("*").eq("id", id).eq("user_id", user.id).maybeSingle();
    if (!ct) return c.json({ error: "Contrat introuvable" }, 404);
    const publicKey = Deno.env.get("KKIAPAY_PUBLIC_KEY") ?? "";
    const mode: "kkiapay" | "mock" = publicKey ? "kkiapay" : "mock";
    const { data: payment } = await admin.from("payments").insert({
      user_id: user.id, contract_id: ct.id, amount: ct.premium,
      currency: ct.currency ?? "XOF", method: "mobile_money",
      status: "en_attente", purpose: "renewal",
    }).select("*").maybeSingle();
    await auditLog(user.id, "renewal.initiated", { id, premium: ct.premium, paymentId: payment.id });
    return c.json({ payment: { ...mapPayment(payment), mode }, kkiapay: { publicKey, sandbox: !Deno.env.get("KKIAPAY_SECRET") } });
  } catch (err) {
    return c.json({ error: `Erreur de renouvellement: ${err}` }, 500);
  }
});

// ============================================================
// REFERRAL
// ============================================================
app.get(`${PREFIX}/referral`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: profile } = await admin.from("profiles").select("referral_code, referred_by").eq("id", user.id).maybeSingle();
  let code = profile?.referral_code;
  if (!code) {
    const { data: p } = await admin.from("profiles").select("name").eq("id", user.id).maybeSingle();
    code = makeReferralCode(p?.name ?? "IPPOO");
    await admin.from("profiles").update({ referral_code: code }).eq("id", user.id);
  }
  const { count } = await admin.from("profiles").select("*", { count: "exact", head: true }).eq("referred_by", user.id);
  return c.json({ code, count: count ?? 0 });
});

// ============================================================
// AUDIT LOG
// ============================================================
app.get(`${PREFIX}/audit`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: entries } = await admin.from("audit_log").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(200);
  return c.json({
    entries: (entries ?? []).map((e: any) => ({ id: e.id, action: e.action, meta: e.meta, at: e.created_at })),
  });
});

// ============================================================
// ACCOUNT DELETION (RGPD)
// ============================================================
app.post(`${PREFIX}/account/delete`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "acct-del", user.id, 5, 3600);
  if (limited) return limited;
  const scheduledFor = new Date(Date.now() + 30 * 86400000).toISOString();
  await admin.from("system_config").upsert({
    key: `account:deletion:${user.id}`,
    value: { requestedAt: new Date().toISOString(), scheduledFor },
  });
  await auditLog(user.id, "account.delete.request", { scheduledFor });
  await addNotification(user.id, "Suppression de compte programmée", `Votre compte sera supprimé le ${new Date(scheduledFor).toLocaleDateString("fr-FR")}. Connectez-vous pour annuler.`, "warn");
  return c.json({ ok: true, scheduledFor });
});

app.delete(`${PREFIX}/account/delete`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  await admin.from("system_config").delete().eq("key", `account:deletion:${user.id}`);
  await auditLog(user.id, "account.delete.cancel", {});
  return c.json({ ok: true });
});

app.get(`${PREFIX}/account/export`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const [{ data: profile }, { data: contracts }, { data: claims }, { data: payments },
    { data: beneficiaries }, { data: notifications }, { data: messages },
    { data: settings }, { data: audit }] = await Promise.all([
    admin.from("profiles").select("*").eq("id", user.id).maybeSingle(),
    admin.from("contracts").select("*").eq("user_id", user.id),
    admin.from("claims").select("*").eq("user_id", user.id),
    admin.from("payments").select("*").eq("user_id", user.id),
    admin.from("beneficiaries").select("*").eq("user_id", user.id),
    admin.from("notifications").select("*").eq("user_id", user.id),
    admin.from("messages").select("*").eq("user_id", user.id),
    admin.from("settings").select("*").eq("user_id", user.id).maybeSingle(),
    admin.from("audit_log").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(200),
  ]);
  await auditLog(user.id, "account.export", {});
  return c.json({
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email },
    profile: mapProfile(profile),
    contracts: (contracts ?? []).map(mapContract),
    claims: (claims ?? []).map((cl: any) => mapClaim(cl)),
    payments: (payments ?? []).map(mapPayment),
    beneficiaries: (beneficiaries ?? []).map(mapBeneficiary),
    notifications: (notifications ?? []).map(mapNotification),
    messages: (messages ?? []).map((m: any) => mapMessage(m)),
    settings: mapSettings(settings),
    audit: (audit ?? []).map((e: any) => ({ id: e.id, action: e.action, meta: e.meta, at: e.created_at })),
  });
});

async function hardDeleteUser(uid: string): Promise<void> {
  try { await admin.from("profiles").delete().eq("id", uid); } catch (err) { console.log(`hardDelete profiles error ${uid}: ${err}`); }
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

app.post(`${PREFIX}/account/delete-now`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "acct-del-now", user.id, 2, 86400);
  if (limited) return limited;
  await hardDeleteUser(user.id);
  return c.json({ ok: true });
});

app.post(`${PREFIX}/admin/account/sweep`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data } = await admin.from("system_config").select("key, value").like("key", "account:deletion:%");
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
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// BILLING & MEMBER CARD
// ============================================================
async function computeBilling(userId: string) {
  const { data: contracts } = await admin.from("contracts").select("*").eq("user_id", userId).eq("status", "active");
  const { data: profile } = await admin.from("profiles").select("card_active").eq("id", userId).maybeSingle();
  const perProduct = BILLING.dailyPerProduct * BILLING.daysPerMonth;
  const active = contracts ?? [];
  const items: any[] = active.map((c: any) => ({
    kind: "insurance", label: `Assurance — ${c.product}`, contractId: c.id,
    perDay: BILLING.dailyPerProduct, days: BILLING.daysPerMonth, amount: perProduct,
  }));
  items.push({ kind: "account_fee", label: "Frais de gestion de compte", amount: BILLING.accountFee });
  if (profile?.card_active) {
    items.push({ kind: "card_fee", label: "Carte membre IPPOO", amount: BILLING.cardFee });
  }
  const total = items.reduce((s, it) => s + it.amount, 0);
  return { items, total, perInsurance: perProduct, accountFee: BILLING.accountFee, cardFee: BILLING.cardFee, activeCount: active.length, cycle: "mensuel" };
}

app.get(`${PREFIX}/billing`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  return c.json(await computeBilling(user.id));
});

app.post(`${PREFIX}/member-card/activate`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "card", user.id, 5, 3600);
  if (limited) return limited;
  try {
    const { data: contracts } = await admin.from("contracts").select("*").eq("user_id", user.id).eq("status", "active");
    if (!contracts?.length) return c.json({ error: "Vous devez d'abord souscrire à au moins une assurance." }, 400);
    const { data: profile } = await admin.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (!profile) return c.json({ error: "Profil introuvable" }, 404);
    if (profile.card_active) return c.json({ profile: mapProfile(profile), payment: null });
    const body = await c.req.json().catch(() => ({}));
    const phone = typeof body?.phone === "string" ? body.phone : null;
    const publicKey = Deno.env.get("KKIAPAY_PUBLIC_KEY") ?? "";
    const mode: "kkiapay" | "mock" = publicKey ? "kkiapay" : "mock";
    const { data: payment } = await admin.from("payments").insert({
      user_id: user.id, contract_id: null, amount: BILLING.cardFee,
      currency: "XOF", method: "mobile_money", status: "en_attente",
      purpose: "card_activation", label: "Activation carte membre IPPOO",
    }).select("*").maybeSingle();
    await auditLog(user.id, "member-card.activate.initiated", { paymentId: payment.id });
    return c.json({ profile: mapProfile(profile), payment: { ...mapPayment(payment), mode }, kkiapay: { publicKey, sandbox: !Deno.env.get("KKIAPAY_SECRET") } });
  } catch (err) {
    return c.json({ error: `Erreur d'activation: ${err}` }, 500);
  }
});

// ============================================================
// QR LOGIN
// ============================================================
app.get(`${PREFIX}/me/qr-token`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: profile } = await admin.from("profiles").select("member_number, card_active").eq("id", user.id).maybeSingle();
  if (!profile?.member_number) return c.json({ error: "Profil incomplet" }, 400);
  if (!profile.card_active) return c.json({ error: "Carte membre non activée", code: "card_inactive" }, 403);
  const { data: contracts } = await admin.from("contracts").select("id").eq("user_id", user.id).eq("status", "active");
  if (!contracts?.length) return c.json({ error: "Aucune souscription active", code: "no_subscription" }, 403);
  const token = await signToken({ v: 1, sub: user.id, mn: profile.member_number, iat: Math.floor(Date.now() / 1000) });
  return c.json({ token, memberNumber: profile.member_number });
});

app.post(`${PREFIX}/auth/qr-login`, async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const allowed = await rateLimit(`qrlogin:${ip}`, 10, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, patientez." }, 429);
    const { token } = (await c.req.json()) ?? {};
    if (!token || typeof token !== "string") return c.json({ error: "Token manquant" }, 400);
    const payload = await verifyToken<{ sub: string; mn: string }>(token);
    if (!payload?.sub) return c.json({ error: "QR invalide ou falsifié" }, 401);
    const { data: profile } = await admin.from("profiles").select("email, member_number").eq("id", payload.sub).maybeSingle();
    if (!profile?.email || profile.member_number !== payload.mn) return c.json({ error: "Identifiants membres invalides" }, 401);
    const { data, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: profile.email });
    if (linkErr) return c.json({ error: linkErr.message }, 500);
    await auditLog(payload.sub, "auth.qr.login", { ip });
    return c.json({ email: profile.email, tokenHash: data.properties?.hashed_token, actionLink: data.properties?.action_link });
  } catch (err) {
    return c.json({ error: `Erreur QR: ${err}` }, 500);
  }
});

// ============================================================
// WEBAUTHN (biometric)
// ============================================================
app.post(`${PREFIX}/auth/webauthn/register/options`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: profile } = await admin.from("profiles").select("email, name").eq("id", user.id).maybeSingle();
  const { data: creds } = await admin.from("webauthn_credentials").select("id").eq("user_id", user.id);
  const { rpID } = webauthnContext(c);
  const opts = await generateRegistrationOptions({
    rpName: WEBAUTHN_RP_NAME, rpID,
    userID: enc.encode(user.id),
    userName: profile?.email ?? user.email ?? user.id,
    userDisplayName: profile?.name ?? "Membre IPPOO",
    attestationType: "none",
    authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
    excludeCredentials: (creds ?? []).map((c: any) => ({ id: c.id, type: "public-key" })),
  });
  await admin.from("system_config").upsert({ key: `webauthn:chal:reg:${user.id}`, value: { challenge: opts.challenge, at: Date.now() } });
  return c.json(opts);
});

app.post(`${PREFIX}/auth/webauthn/register/verify`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const limited = await guardRate(c, "biorev", user.id, 10, 600);
  if (limited) return limited;
  try {
    const body = await c.req.json();
    const { data: stored } = await admin.from("system_config").select("value").eq("key", `webauthn:chal:reg:${user.id}`).maybeSingle();
    if (!stored?.value?.challenge) return c.json({ error: "Aucun défi en cours" }, 400);
    const { origin, rpID } = webauthnContext(c);
    const verification = await verifyRegistrationResponse({
      response: body.response, expectedChallenge: stored.value.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) return c.json({ error: "Vérification échouée" }, 400);
    const { credential } = verification.registrationInfo as any;
    await admin.from("webauthn_credentials").insert({
      id: credential.id, user_id: user.id,
      public_key: b64urlEncode(credential.publicKey),
      counter: credential.counter ?? 0,
      transports: body.response?.response?.transports ?? [],
    });
    await auditLog(user.id, "auth.webauthn.register", {});
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `Erreur d'enregistrement biométrique: ${err}` }, 500);
  }
});

app.post(`${PREFIX}/auth/webauthn/login/options`, async (c) => {
  try {
    const { email } = (await c.req.json()) ?? {};
    if (!email) return c.json({ error: "Email requis" }, 400);
    const { data: profile } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
    if (!profile?.id) return c.json({ error: "Aucun compte trouvé" }, 404);
    const uid = profile.id;
    const { data: creds } = await admin.from("webauthn_credentials").select("*").eq("user_id", uid);
    if (!creds?.length) return c.json({ error: "Aucune empreinte enregistrée" }, 404);
    const { rpID } = webauthnContext(c);
    const opts = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map((c: any) => ({ id: c.id, type: "public-key", transports: c.transports })),
      userVerification: "preferred",
    });
    await admin.from("system_config").upsert({ key: `webauthn:chal:auth:${uid}`, value: { challenge: opts.challenge, at: Date.now() } });
    return c.json({ ...opts, _uid: uid });
  } catch (err) {
    return c.json({ error: `Erreur: ${err}` }, 500);
  }
});

app.post(`${PREFIX}/auth/webauthn/login/verify`, async (c) => {
  try {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
    const allowed = await rateLimit(`biolog:${ip}`, 10, 600);
    if (!allowed) return c.json({ error: "Trop de tentatives, patientez." }, 429);
    const { email, response } = (await c.req.json()) ?? {};
    const { data: profile } = await admin.from("profiles").select("id, email").eq("email", email).maybeSingle();
    if (!profile?.id) return c.json({ error: "Compte introuvable" }, 404);
    const uid = profile.id;
    const { data: storedConfig } = await admin.from("system_config").select("value").eq("key", `webauthn:chal:auth:${uid}`).maybeSingle();
    if (!storedConfig?.value?.challenge) return c.json({ error: "Aucun défi en cours" }, 400);
    const { data: creds } = await admin.from("webauthn_credentials").select("*").eq("user_id", uid);
    const cred = (creds ?? []).find((c: any) => c.id === response.id);
    if (!cred) return c.json({ error: "Empreinte inconnue" }, 404);
    const { origin, rpID } = webauthnContext(c);
    const verification = await verifyAuthenticationResponse({
      response, expectedChallenge: storedConfig.value.challenge,
      expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: cred.id, publicKey: b64urlDecode(cred.public_key), counter: cred.counter, transports: cred.transports },
      requireUserVerification: false,
    });
    if (!verification.verified) return c.json({ error: "Empreinte rejetée" }, 401);
    await admin.from("webauthn_credentials").update({ counter: verification.authenticationInfo.newCounter }).eq("id", cred.id);
    const { data, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: profile.email });
    if (linkErr) return c.json({ error: linkErr.message }, 500);
    await auditLog(uid, "auth.webauthn.login", { ip });
    return c.json({ email: profile.email, tokenHash: data.properties?.hashed_token });
  } catch (err) {
    return c.json({ error: `Erreur de vérification biométrique: ${err}` }, 500);
  }
});

app.get(`${PREFIX}/auth/webauthn/status`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const { data: creds } = await admin.from("webauthn_credentials").select("id, created_at").eq("user_id", user.id);
  return c.json({ count: (creds ?? []).length, devices: (creds ?? []).map((c: any) => ({ id: c.id, createdAt: c.created_at })) });
});

app.delete(`${PREFIX}/auth/webauthn/:credId`, async (c) => {
  const { user, error } = await requireUser(c);
  if (!user) return c.json({ error: `Non autorisé: ${error}` }, 401);
  const credId = c.req.param("credId");
  await admin.from("webauthn_credentials").delete().eq("id", credId).eq("user_id", user.id);
  await auditLog(user.id, "auth.webauthn.remove", { credId });
  return c.json({ ok: true });
});

// ============================================================
// ADMIN
// ============================================================
app.post(`${PREFIX}/admin/login`, async (c) => {
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const limited = await guardRate(c, `admin-login:${ip}`, 5, 600);
  if (limited) return limited;
  try {
    const body = await c.req.json().catch(() => ({}));
    const username = (body.username ?? "").toString().trim();
    const password = (body.password ?? "").toString();
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return c.json({ error: "Back office non configuré." }, 503);
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return c.json({ error: "Identifiants invalides" }, 401);
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
    const { data } = await admin.from("claims").select("*, profiles(email, name, member_number), claim_attachments(*)").order("created_at", { ascending: false });
    const claims = (data ?? []).map((cl: any) => ({
      ...mapClaim(cl, cl.claim_attachments ?? []),
      userId: cl.user_id,
      userEmail: cl.profiles?.email ?? "",
      userName: cl.profiles?.name ?? "",
      memberNumber: cl.profiles?.member_number ?? "",
      adminNote: cl.admin_note,
      decidedAt: cl.decided_at,
      decidedBy: cl.decided_by,
    }));
    return c.json({ claims });
  } catch (err) {
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
    if (!["en_cours", "valide", "rejete", "regle"].includes(status)) return c.json({ error: "Statut invalide" }, 400);
    const { data: claim } = await admin.from("claims").update({
      status, admin_note: note, decided_at: new Date().toISOString(), decided_by: r.admin.username,
    }).eq("id", claimId).eq("user_id", userId).select("*").maybeSingle();
    if (!claim) return c.json({ error: "Sinistre introuvable" }, 404);
    const label = status === "valide" ? "validé" : status === "rejete" ? "rejeté" : status === "regle" ? "réglé" : "mis à jour";
    await addNotification(userId, `Sinistre ${label}`, `Votre sinistre « ${claim.type} » a été ${label}.`, status === "rejete" ? "warn" : "success");
    await auditLog(userId, "admin.claim.status", { claimId, status, by: r.admin.username });
    return c.json({ claim: mapClaim(claim) });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/stats`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const [{ count: usersCount }, { data: claimsData }, { data: paymentsData }] = await Promise.all([
      admin.from("profiles").select("*", { count: "exact", head: true }),
      admin.from("claims").select("status"),
      admin.from("payments").select("amount, status").eq("status", "confirme"),
    ]);
    const totalClaims = claimsData?.length ?? 0;
    const pendingClaims = (claimsData ?? []).filter((c: any) => c.status === "en_cours").length;
    const revenue = (paymentsData ?? []).reduce((s: number, p: any) => s + (p.amount ?? 0), 0);
    return c.json({ users: usersCount ?? 0, claims: { total: totalClaims, pending: pendingClaims }, revenue });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/members`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data: profiles } = await admin.from("profiles").select("id, email, name, phone, member_number, created_at, suspended").order("created_at", { ascending: false });
    const members = await Promise.all((profiles ?? []).map(async (p: any) => {
      const [{ count: activeContracts }, { count: pendingClaims }, { data: payments }] = await Promise.all([
        admin.from("contracts").select("*", { count: "exact", head: true }).eq("user_id", p.id).eq("status", "active"),
        admin.from("claims").select("*", { count: "exact", head: true }).eq("user_id", p.id).eq("status", "en_cours"),
        admin.from("payments").select("amount").eq("user_id", p.id).eq("status", "confirme"),
      ]);
      const revenue = (payments ?? []).reduce((s: number, pay: any) => s + (pay.amount ?? 0), 0);
      return { id: p.id, email: p.email, name: p.name, phone: p.phone, memberNumber: p.member_number, createdAt: p.created_at, suspended: !!p.suspended, activeContracts: activeContracts ?? 0, pendingClaims: pendingClaims ?? 0, revenue };
    }));
    return c.json({ members });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/member/:uid`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const [{ data: profile }, { data: contracts }, { data: claims }, { data: payments }, { data: beneficiaries }, { data: notifications }, { data: settings }] = await Promise.all([
      admin.from("profiles").select("*").eq("id", uid).maybeSingle(),
      admin.from("contracts").select("*").eq("user_id", uid),
      admin.from("claims").select("*, claim_attachments(*)").eq("user_id", uid),
      admin.from("payments").select("*").eq("user_id", uid),
      admin.from("beneficiaries").select("*").eq("user_id", uid),
      admin.from("notifications").select("*").eq("user_id", uid),
      admin.from("settings").select("*").eq("user_id", uid).maybeSingle(),
    ]);
    if (!profile) return c.json({ error: "Membre introuvable" }, 404);
    return c.json({
      profile: { ...mapProfile(profile), suspended: profile.suspended },
      contracts: (contracts ?? []).map(mapContract),
      claims: (claims ?? []).map((cl: any) => mapClaim(cl, cl.claim_attachments ?? [])),
      payments: (payments ?? []).map(mapPayment),
      beneficiaries: (beneficiaries ?? []).map(mapBeneficiary),
      notifications: (notifications ?? []).map(mapNotification),
      settings: mapSettings(settings),
    });
  } catch (err) {
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
    await admin.from("profiles").update({ suspended }).eq("id", uid);
    await auditLog(uid, "admin.member.suspend", { suspended, by: r.admin.username });
    return c.json({ ok: true, suspended });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/contracts`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data } = await admin.from("contracts").select("*, profiles(email, name)").order("start_date", { ascending: false });
    const contracts = (data ?? []).map((ct: any) => ({
      ...mapContract(ct), userId: ct.user_id, userEmail: ct.profiles?.email ?? "", userName: ct.profiles?.name ?? "",
    }));
    return c.json({ contracts });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/payments`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data } = await admin.from("payments").select("*, profiles(email, name)").order("created_at", { ascending: false });
    const payments = (data ?? []).map((p: any) => ({
      ...mapPayment(p), userId: p.user_id, userEmail: p.profiles?.email ?? "", userName: p.profiles?.name ?? "",
    }));
    return c.json({ payments });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.post(`${PREFIX}/admin/broadcast`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const body = await c.req.json();
    const title = (body.title ?? "").toString().trim();
    const text = (body.body ?? "").toString().trim();
    const type = ["info", "success", "warn"].includes(body.type) ? body.type : "info";
    if (!title || !text) return c.json({ error: "Titre et message requis" }, 400);
    const { data: profiles } = await admin.from("profiles").select("id");
    let count = 0;
    for (const p of profiles ?? []) {
      await addNotification(p.id, title, text, type);
      count++;
    }
    await auditLog(`admin:${r.admin.username}` as any, "admin.broadcast", { title, count });
    return c.json({ ok: true, recipients: count });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// SITE CONTENT
// ============================================================
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
  const { data } = await admin.from("system_config").select("value").eq("key", "system:site").maybeSingle();
  return c.json({ site: { ...DEFAULT_SITE, ...(data?.value ?? {}) } });
});

app.put(`${PREFIX}/admin/site`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const body = await c.req.json();
    const { data: current } = await admin.from("system_config").select("value").eq("key", "system:site").maybeSingle();
    const allow = ["brandName", "tagline", "heroTitle", "heroSubtitle", "aboutShort", "contactEmail", "contactPhone", "contactAddress", "whatsapp", "facebook", "instagram", "linkedin"];
    const next: Record<string, string> = { ...DEFAULT_SITE, ...(current?.value ?? {}) };
    for (const key of allow) {
      if (typeof body?.[key] === "string") next[key] = body[key].slice(0, 600);
    }
    await admin.from("system_config").upsert({ key: "system:site", value: next });
    await auditLog(`admin:${r.admin.username}` as any, "admin.site.update", { count: Object.keys(body ?? {}).length });
    return c.json({ ok: true, site: next });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// PARTNERS
// ============================================================
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
  const { data } = await admin.from("system_config").select("value").eq("key", "system:partners").maybeSingle();
  return c.json({ partners: data?.value ?? DEFAULT_PARTNERS });
});

app.put(`${PREFIX}/admin/partners`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
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
      lat: Number(p.lat) || 0, lng: Number(p.lng) || 0,
      hours: String(p.hours ?? "").slice(0, 40),
    })).filter((p: any) => p.name);
    await admin.from("system_config").upsert({ key: "system:partners", value: partners });
    await auditLog(`admin:${r.admin.username}` as any, "admin.partners.update", { count: partners.length });
    return c.json({ ok: true, partners });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// PROMOS
// ============================================================
app.get(`${PREFIX}/promos`, async (c) => {
  const { data } = await admin.from("system_config").select("value").eq("key", "system:promos").maybeSingle();
  return c.json({ promos: data?.value ?? [] });
});

app.put(`${PREFIX}/admin/promos`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
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
    await admin.from("system_config").upsert({ key: "system:promos", value: promos });
    await auditLog(`admin:${r.admin.username}` as any, "admin.promos.update", { count: promos.length });
    return c.json({ ok: true, promos });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// ADMIN: RECENT AUDIT
// ============================================================
app.get(`${PREFIX}/admin/audit/recent`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  try {
    const { data } = await admin.from("audit_log").select("*, profiles(email, name)").order("created_at", { ascending: false }).limit(200);
    const entries = (data ?? []).map((e: any) => ({
      id: e.id, action: e.action, meta: e.meta, at: e.created_at,
      userId: e.user_id, userEmail: e.profiles?.email ?? "", userName: e.profiles?.name ?? "",
    }));
    return c.json({ entries });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// ADMIN: MESSAGES (conversations)
// ============================================================
app.get(`${PREFIX}/admin/messages`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const statusFilter = (c.req.query("status") ?? "").trim();
  const mineOnly = c.req.query("mine") === "1";
  try {
    // Get all users who have messages
    const { data: msgUsers } = await admin.from("messages").select("user_id").neq("user_id", null);
    const uids = [...new Set((msgUsers ?? []).map((m: any) => m.user_id))];
    const convos: any[] = [];
    for (const uid of uids) {
      const [{ data: msgs }, { data: profile }, { data: meta }] = await Promise.all([
        admin.from("messages").select("*").eq("user_id", uid).order("created_at", { ascending: true }),
        admin.from("profiles").select("email, name, member_number").eq("id", uid).maybeSingle(),
        admin.from("conversation_meta").select("*").eq("user_id", uid).maybeSingle(),
      ]);
      if (!msgs?.length) continue;
      const last = msgs[msgs.length - 1];
      const unread = msgs.filter((m: any) => m.from_role === "user" && !m.read).length;
      const currentMeta = meta ?? { status: "ouvert", assignee: null, tags: [] };
      const hay = `${profile?.email ?? ""} ${profile?.name ?? ""} ${profile?.member_number ?? ""} ${last?.body ?? ""}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (statusFilter && (currentMeta.status ?? "ouvert") !== statusFilter) continue;
      if (mineOnly && currentMeta.assignee !== r.admin.username) continue;
      convos.push({
        userId: uid, userEmail: profile?.email ?? "", userName: profile?.name ?? "",
        memberNumber: profile?.member_number ?? "", lastMessage: last?.body ?? "",
        lastAt: last?.created_at ?? "", lastFrom: last?.from_role ?? "user",
        unread, total: msgs.length, status: currentMeta.status ?? "ouvert",
        assignee: currentMeta.assignee ?? null, tags: currentMeta.tags ?? [],
      });
    }
    convos.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
    return c.json({ conversations: convos });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.patch(`${PREFIX}/admin/messages/:uid/meta`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const body = await c.req.json();
    const { data: current } = await admin.from("conversation_meta").select("*").eq("user_id", uid).maybeSingle();
    const next: any = { user_id: uid, status: current?.status ?? "ouvert", assignee: current?.assignee ?? null, tags: current?.tags ?? [] };
    if (body?.status && ["ouvert", "en_cours", "resolu"].includes(body.status)) next.status = body.status;
    if (body?.assignee !== undefined) next.assignee = body.assignee ? String(body.assignee).slice(0, 80) : null;
    if (Array.isArray(body?.tags)) next.tags = body.tags.slice(0, 8).map((t: any) => String(t).slice(0, 40));
    next.updated_at = new Date().toISOString();
    await admin.from("conversation_meta").upsert(next);
    await auditLog(uid, "conversation.meta", { by: r.admin.username, ...next });
    await broadcast(`admin:chat`, "meta:update", { userId: uid, meta: next });
    return c.json({ meta: { status: next.status, assignee: next.assignee, tags: next.tags, updatedAt: next.updated_at } });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.get(`${PREFIX}/admin/messages/:uid`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const { data: msgs } = await admin.from("messages").select("*, message_attachments(*)").eq("user_id", uid).order("created_at", { ascending: true });
  // Mark user messages as read
  await admin.from("messages").update({ read: true }).eq("user_id", uid).eq("from_role", "user").eq("read", false);
  const changed = (msgs ?? []).filter((m: any) => m.from_role === "user" && !m.read).length;
  if (changed > 0) await broadcast(`chat:${uid}`, "message:read", { count: changed, at: new Date().toISOString() });
  return c.json({ messages: (msgs ?? []).map((m: any) => mapMessage(m, m.message_attachments?.[0])) });
});

app.post(`${PREFIX}/admin/messages/:uid`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  try {
    const body = await c.req.json();
    const content = String(body?.content ?? "").trim();
    if (!content) return c.json({ error: "Message vide" }, 400);
    const replyToId = typeof body?.replyToId === "string" ? body.replyToId : null;
    const { data: msg } = await admin.from("messages").insert({
      user_id: uid, from_role: "conseiller",
      author: `${r.admin.username} (IPPOO)`, body: content, read: false, reply_to_id: replyToId,
    }).select("*").maybeSingle();
    await addNotification(uid, "Nouveau message conseiller", content.slice(0, 120), "info");
    await auditLog(uid, "message.admin_reply", { by: r.admin.username, length: content.length });
    const mapped = mapMessage(msg);
    await Promise.all([
      broadcast(`chat:${uid}`, "message:new", { message: mapped }),
      broadcast(`admin:chat`, "message:new", { userId: uid, message: mapped }),
    ]);
    return c.json({ message: mapped });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

app.patch(`${PREFIX}/admin/messages/:uid/:id`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const id = c.req.param("id");
  const parsed = await parseBody(c, MessageEditSchema);
  if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
  const { data: m } = await admin.from("messages").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!m) return c.json({ error: "Message introuvable" }, 404);
  if (m.from_role !== "conseiller") return c.json({ error: "Édition refusée" }, 403);
  if (m.deleted_at) return c.json({ error: "Message supprimé" }, 410);
  const { data: updated } = await admin.from("messages").update({ body: parsed.data.content.trim(), edited_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  await auditLog(uid, "message.admin_edit", { by: r.admin.username, id });
  const mapped = mapMessage(updated);
  await Promise.all([
    broadcast(`chat:${uid}`, "message:update", { message: mapped }),
    broadcast(`admin:chat`, "message:update", { userId: uid, message: mapped }),
  ]);
  return c.json({ message: mapped });
});

app.delete(`${PREFIX}/admin/messages/:uid/:id`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const id = c.req.param("id");
  const { data: m } = await admin.from("messages").select("*").eq("id", id).eq("user_id", uid).maybeSingle();
  if (!m) return c.json({ error: "Message introuvable" }, 404);
  if (m.from_role !== "conseiller") return c.json({ error: "Suppression refusée" }, 403);
  const { data: updated } = await admin.from("messages").update({ body: "", deleted_at: new Date().toISOString() }).eq("id", id).select("*").maybeSingle();
  await auditLog(uid, "message.admin_delete", { by: r.admin.username, id });
  const mapped = mapMessage(updated);
  await Promise.all([
    broadcast(`chat:${uid}`, "message:update", { message: mapped }),
    broadcast(`admin:chat`, "message:update", { userId: uid, message: mapped }),
  ]);
  return c.json({ message: mapped });
});

app.post(`${PREFIX}/admin/messages/:uid/read`, async (c) => {
  const r = await requireAdminToken(c);
  if (!r.admin) return c.json({ error: r.error }, r.status);
  const uid = c.req.param("uid");
  const { count } = await admin.from("messages").update({ read: true }).eq("user_id", uid).eq("from_role", "user").eq("read", false).select("*", { count: "exact", head: true });
  const changed = count ?? 0;
  if (changed > 0) await broadcast(`chat:${uid}`, "message:read", { count: changed, at: new Date().toISOString() });
  return c.json({ ok: true, marked: changed });
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
    const { data: msg } = await admin.from("messages").insert({
      user_id: uid, from_role: "conseiller", author: `${r.admin.username} (IPPOO)`, body: caption, read: false,
    }).select("*").maybeSingle();
    await admin.from("message_attachments").insert({ message_id: msg.id, name: file.name, mime: file.type, size: file.size, path });
    await addNotification(uid, "Nouveau message conseiller", `Pièce jointe : ${file.name}`, "info");
    await auditLog(uid, "message.admin_attachment", { by: r.admin.username, name: file.name, size: file.size });
    const mapped = mapMessage(msg, { name: file.name, mime: file.type, size: file.size, path });
    await Promise.all([
      broadcast(`chat:${uid}`, "message:new", { message: mapped }),
      broadcast(`admin:chat`, "message:new", { userId: uid, message: mapped }),
    ]);
    return c.json({ message: mapped });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

// ============================================================
// AUTO-DEBIT BILLING CYCLE
// ============================================================
async function runMonthlyBillingCycle(triggeredBy: string) {
  const { data: contracts } = await admin.from("contracts").select("*, profiles(id)").eq("status", "active").eq("auto_debit", true);
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let generated = 0, skipped = 0;
  for (const ct of contracts ?? []) {
    const due = ct.next_billing_date ? new Date(ct.next_billing_date).getTime() : 0;
    if (due > now.getTime()) { skipped++; continue; }
    // Check if already has a pending or confirmed payment for this cycle
    const { data: existing } = await admin.from("payments").select("id").eq("contract_id", ct.id).eq("purpose", "monthly_premium").in("status", ["confirme", "en_attente"]).gte("created_at", `${monthKey}-01`).maybeSingle();
    if (existing) { skipped++; continue; }
    await admin.from("payments").insert({
      user_id: ct.user_id, contract_id: ct.id, amount: ct.premium, currency: ct.currency ?? "XOF",
      method: "mobile_money", status: "en_attente", purpose: "monthly_premium",
    });
    await addNotification(ct.user_id, "Cotisation mensuelle à régler", `Votre prélèvement de ${ct.premium} FCFA pour « ${ct.product} » est à régler.`, "warn");
    await admin.from("contracts").update({ next_billing_date: nextBillingFromNow() }).eq("id", ct.id);
    generated++;
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

// ============================================================
// WEB PUSH (VAPID)
// ============================================================
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
    await admin.from("push_subscriptions").upsert({ user_id: r.user.id, endpoint: sub.endpoint, subscription: sub }, { onConflict: "endpoint" });
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
    await admin.from("push_subscriptions").delete().eq("user_id", r.user.id).eq("endpoint", endpoint);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: `${err}` }, 500);
  }
});

async function pushUsers(uids: string[], payload: { title: string; body: string; url?: string; tag?: string }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return { sent: 0, skipped: uids.length, reason: "no-vapid" };
  let webpush: any;
  try {
    webpush = await import("npm:web-push@3.6.7");
    webpush.default.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (err) {
    return { sent: 0, skipped: uids.length, reason: "import-failed" };
  }
  let sent = 0, failed = 0;
  for (const uid of uids) {
    const { data: subs } = await admin.from("push_subscriptions").select("*").eq("user_id", uid);
    for (const s of subs ?? []) {
      try {
        await webpush.default.sendNotification(s.subscription, JSON.stringify(payload));
        sent++;
      } catch (err: any) {
        failed++;
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("user_id", uid).eq("endpoint", s.endpoint);
        }
      }
    }
  }
  return { sent, failed };
}
(globalThis as any).__ippoo_pushUsers = pushUsers;

// ============================================================
// WALLET (Google & Apple)
// ============================================================
const GW_ISSUER = Deno.env.get("GOOGLE_WALLET_ISSUER_ID") ?? null;
const GW_CLASS = Deno.env.get("GOOGLE_WALLET_CLASS_ID") ?? null;
const GW_SA_EMAIL = Deno.env.get("GOOGLE_WALLET_SA_EMAIL") ?? null;
const GW_SA_KEY = Deno.env.get("GOOGLE_WALLET_SA_KEY") ?? null;

async function importPemRsaKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = b64urlDecode(body.replace(/\+/g, "-").replace(/\//g, "_"));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

app.get(`${PREFIX}/wallet/google`, async (c) => {
  const r = await requireUser(c);
  if (!r.user) return c.json({ error: r.error }, 401);
  const configured = !!(GW_ISSUER && GW_CLASS && GW_SA_EMAIL && GW_SA_KEY);
  if (!configured) return c.json({ saveUrl: null, configured: false });
  try {
    const { data: profile } = await admin.from("profiles").select("name, member_number").eq("id", r.user.id).maybeSingle();
    const objectId = `${GW_ISSUER}.member-${r.user.id}`;
    const payload = {
      iss: GW_SA_EMAIL, aud: "google", typ: "savetowallet", iat: Math.floor(Date.now() / 1000),
      payload: {
        genericObjects: [{
          id: objectId, classId: GW_CLASS, state: "ACTIVE",
          cardTitle: { defaultValue: { language: "fr", value: "IPPOO Assurance" } },
          header: { defaultValue: { language: "fr", value: profile?.name ?? "Membre IPPOO" } },
          subheader: { defaultValue: { language: "fr", value: "Carte Membre" } },
          textModulesData: [{ header: "N° Membre", body: profile?.member_number ?? "—" }],
          barcode: { type: "QR_CODE", value: profile?.member_number ?? r.user.id, alternateText: profile?.member_number ?? "" },
        }],
      },
    };
    const header = { alg: "RS256", typ: "JWT" };
    const h64 = b64urlEncode(enc.encode(JSON.stringify(header)));
    const p64 = b64urlEncode(enc.encode(JSON.stringify(payload)));
    const signingInput = `${h64}.${p64}`;
    const rsaKey = await importPemRsaKey(GW_SA_KEY!);
    const sigBytes = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsaKey, enc.encode(signingInput));
    const jwt = `${signingInput}.${b64urlEncode(sigBytes)}`;
    const saveUrl = `https://pay.google.com/gp/v/save/${jwt}`;
    return c.json({ saveUrl, configured: true });
  } catch (err) {
    console.log(`[wallet] Google Wallet error: ${err}`);
    return c.json({ saveUrl: null, configured: false });
  }
});

app.get(`${PREFIX}/wallet/apple`, async (c) => {
  const r = await requireUser(c);
  if (!r.user) return c.json({ error: r.error }, 401);
  return c.json({ message: "Apple Wallet non configuré" }, 501);
});

Deno.serve(app.fetch);
