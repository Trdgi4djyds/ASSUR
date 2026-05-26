import { apiFetch, API_BASE } from "./supabaseClient";
import { publicAnonKey } from "../../../utils/supabase/info";

export interface Profile {
  id: string;
  email: string;
  name: string;
  phone?: string;
  memberNumber?: string;
  cardActive?: boolean;
  cardIssuedAt?: string;
  createdAt: string;
  type?: "informel" | "particulier" | "salarie" | string;
  firstName?: string | null;
  lastName?: string | null;
  gender?: string | null;
  birthDate?: string | null;
  birthPlace?: string | null;
  profession?: string | null;
  companyName?: string | null;
  ifu?: string | null;
  idType?: string | null;
  idNumber?: string | null;
  country?: string | null;
  countryDial?: string | null;
  department?: string | null;
  city?: string | null;
  quartier?: string | null;
}
export interface BillingItem { kind: "insurance" | "account_fee" | "card_fee"; label: string; contractId?: string; perDay?: number; days?: number; amount: number; }
export interface Billing { items: BillingItem[]; total: number; perInsurance: number; accountFee: number; cardFee: number; activeCount: number; cycle: string; }
export interface Contract { id: string; product: string; status: "active" | "expired" | "pending"; startDate: string; endDate: string; premium: number; currency: string; frequency: string; autoDebit?: boolean; nextBillingDate?: string | null; lastPaidAt?: string; }
export interface ClaimAttachment { path: string; name: string; size: number; }
export interface Claim { id: string; contractId: string | null; type: string; description: string; amount: number; status: "en_cours" | "valide" | "rejete" | "regle"; createdAt: string; attachments?: ClaimAttachment[]; }
export interface Payment { id: string; contractId: string | null; amount: number; currency: string; method: string; status: "confirme" | "en_attente" | "echec"; createdAt: string; purpose?: "cotisation" | "renewal" | "card_activation" | "monthly_premium"; confirmedAt?: string; label?: string; }
export interface Beneficiary { id: string; name: string; relation: string; birthDate: string | null; createdAt: string; }
export interface Document { id: string; name: string; type: string; category: string; size: number; createdAt: string; }
export interface Notification { id: string; title: string; body: string; type: "info" | "success" | "warn"; read: boolean; createdAt: string; }
export interface MessageAttachment { name: string; mime: string; size: number; path: string; }
export interface Message { id: string; from: "user" | "conseiller"; author: string; body: string; createdAt: string; read: boolean; attachment?: MessageAttachment; replyToId?: string; editedAt?: string; deletedAt?: string; }
export interface Settings { lang: string; notifySms: boolean; notifyEmail: boolean; }

export const api = {
  me: (token: string) => apiFetch<{ profile: Profile | null }>("/me", { token }),
  updateMe: (token: string, updates: Partial<Profile>) => apiFetch<{ profile: Profile }>("/me", { method: "PUT", body: updates, token }),
  contracts: (token: string) => apiFetch<{ contracts: Contract[] }>("/contracts", { token }),
  claims: (token: string) => apiFetch<{ claims: Claim[] }>("/claims", { token }),
  createClaim: (token: string, input: { contractId?: string; type: string; description: string; amount?: number }) => apiFetch<{ claim: Claim }>("/claims", { method: "POST", body: input, token }),
  payments: (token: string) => apiFetch<{ payments: Payment[] }>("/payments", { token }),
  createPayment: (token: string, input: { contractId?: string; amount: number; method?: string }) => apiFetch<{ payment: Payment }>("/payments", { method: "POST", body: input, token }),
  initiatePayment: (
    token: string,
    input: { contractId?: string; amount: number; phone?: string; purpose?: "cotisation" | "renewal" | "card_activation" | "monthly_premium"; paymentId?: string },
  ) =>
    apiFetch<{
      payment: Payment & { mode: "kkiapay" | "mock"; purpose?: string };
      kkiapay: { publicKey: string; sandbox: boolean };
    }>("/payments/initiate", { method: "POST", body: input, token }),
  setAutoDebit: (token: string, contractId: string, enabled: boolean) =>
    apiFetch<{ contract: Contract }>(`/contracts/${contractId}/auto-debit`, { method: "PATCH", body: { enabled }, token }),
  adminRunBilling: (adminToken: string) =>
    apiFetch<{ ok: true; cycleKey: string; generated: number; skipped: number }>("/admin/billing/run", { method: "POST", adminToken }),
  confirmPaymentMock: (token: string, id: string) =>
    apiFetch<{ payment: Payment }>(`/payments/${id}/confirm-mock`, { method: "POST", token }),
  getPayment: (token: string, id: string) =>
    apiFetch<{ payment: Payment }>(`/payments/${id}`, { token }),
  beneficiaries: (token: string) => apiFetch<{ beneficiaries: Beneficiary[] }>("/beneficiaries", { token }),
  createBeneficiary: (token: string, input: { name: string; relation: string; birthDate?: string }) => apiFetch<{ beneficiary: Beneficiary }>("/beneficiaries", { method: "POST", body: input, token }),
  deleteBeneficiary: (token: string, id: string) => apiFetch<{ ok: true }>(`/beneficiaries/${id}`, { method: "DELETE", token }),
  documents: (token: string) => apiFetch<{ documents: Document[] }>("/documents", { token }),
  notifications: (token: string) => apiFetch<{ notifications: Notification[] }>("/notifications", { token }),
  markNotificationsRead: (token: string) => apiFetch<{ ok: true }>("/notifications/read", { method: "POST", token }),
  messages: (token: string) => apiFetch<{ messages: Message[] }>("/messages", { token }),
  sendMessage: (token: string, content: string, replyToId?: string) => apiFetch<{ messages: Message[] }>("/messages", { method: "POST", body: { content, ...(replyToId ? { replyToId } : {}) }, token }),
  editMessage: (token: string, id: string, content: string) => apiFetch<{ message: Message }>(`/messages/${id}`, { method: "PATCH", body: { content }, token }),
  deleteMessage: (token: string, id: string) => apiFetch<{ message: Message }>(`/messages/${id}`, { method: "DELETE", token }),
  markMessagesRead: (token: string) => apiFetch<{ ok: true; marked: number }>("/messages/read", { method: "POST", token }),
  sendMessageAttachment: async (token: string, file: File, caption?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (caption) form.append("caption", caption);
    const res = await fetch(`${API_BASE}/messages/attachment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${publicAnonKey}`, ...(token ? { "X-User-Token": token } : {}) },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as { message: Message };
  },
  messageAttachmentUrl: (token: string, path: string) =>
    apiFetch<{ url: string; expiresIn: number }>(`/messages/attachment-url?path=${encodeURIComponent(path)}`, { token }),
  subscribe: (token: string, input: { product: string; premium: number; frequency?: string }) => apiFetch<{ contract: Contract }>("/subscribe", { method: "POST", body: input, token }),
  settings: (token: string) => apiFetch<{ settings: Settings }>("/settings", { token }),
  updateSettings: (token: string, updates: Partial<Settings>) => apiFetch<{ settings: Settings }>("/settings", { method: "PUT", body: updates, token }),
  changePassword: (token: string, newPassword: string) => apiFetch<{ ok: true }>("/change-password", { method: "POST", body: { newPassword }, token }),
  uploadClaimAttachment: async (token: string, claimId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/claims/${claimId}/attachments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${publicAnonKey}`,
        ...(token ? { "X-User-Token": token } : {}),
      },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as { ok: true; attachment: ClaimAttachment };
  },
  claimAttachmentUrl: (token: string, path: string) =>
    apiFetch<{ url: string }>(`/claims/attachments/url?path=${encodeURIComponent(path)}`, { token }),
  checkRenewals: (token: string) =>
    apiFetch<{ pushed: number }>("/contracts/check-renewals", { method: "POST", token }),
  referral: (token: string) =>
    apiFetch<{ code: string; count: number }>("/referral", { token }),
  audit: (token: string) =>
    apiFetch<{ entries: { id: string; action: string; meta: Record<string, any>; at: string }[] }>("/audit", { token }),
  requestAccountDeletion: (token: string) =>
    apiFetch<{ ok: true; scheduledFor: string }>("/account/delete", { method: "POST", token }),
  cancelAccountDeletion: (token: string) =>
    apiFetch<{ ok: true }>("/account/delete", { method: "DELETE", token }),
  deleteAccountNow: (token: string) =>
    apiFetch<{ ok: true }>("/account/delete-now", { method: "POST", token }),
  exportAccountData: (token: string) =>
    apiFetch<Record<string, any>>("/account/export", { token }),
  renewContract: (token: string, id: string, phone?: string) =>
    apiFetch<{ payment: Payment & { mode: "kkiapay" | "mock" }; kkiapay: { publicKey: string; sandbox: boolean } }>(
      `/contracts/${id}/renew`, { method: "POST", body: { phone }, token },
    ),
  qrToken: (token: string) =>
    apiFetch<{ token: string; memberNumber: string }>("/me/qr-token", { token }),
  billing: (token: string) =>
    apiFetch<Billing>("/billing", { token }),
  activateMemberCard: (token: string, phone?: string) =>
    apiFetch<{ profile: Profile; payment: (Payment & { mode: "kkiapay" | "mock" }) | null; kkiapay?: { publicKey: string; sandbox: boolean } }>(
      "/member-card/activate", { method: "POST", body: { phone }, token },
    ),
  qrLogin: (qrToken: string) =>
    apiFetch<{ email: string; tokenHash: string; actionLink: string }>("/auth/qr-login", {
      method: "POST", body: { token: qrToken },
    }),
  webauthnRegisterOptions: (token: string) =>
    apiFetch<any>("/auth/webauthn/register/options", { method: "POST", token }),
  webauthnRegisterVerify: (token: string, response: any) =>
    apiFetch<{ ok: true }>("/auth/webauthn/register/verify", { method: "POST", body: { response }, token }),
  webauthnLoginOptions: (email: string) =>
    apiFetch<any>("/auth/webauthn/login/options", { method: "POST", body: { email } }),
  webauthnLoginVerify: (email: string, response: any) =>
    apiFetch<{ email: string; tokenHash: string }>("/auth/webauthn/login/verify", {
      method: "POST", body: { email, response },
    }),
  webauthnStatus: (token: string) =>
    apiFetch<{ count: number; devices: { id: string; createdAt: string }[] }>("/auth/webauthn/status", { token }),
  webauthnRemove: (token: string, credId: string) =>
    apiFetch<{ ok: true }>(`/auth/webauthn/${encodeURIComponent(credId)}`, { method: "DELETE", token }),
  adminLogin: (username: string, password: string) =>
    apiFetch<{ token: string; username: string; expiresAt: number }>("/admin/login", {
      method: "POST", body: { username, password },
    }),
  adminCheck: (adminToken: string) =>
    apiFetch<{ admin: boolean; username?: string; error?: string }>("/admin/check", { adminToken }),
  adminClaims: (adminToken: string) =>
    apiFetch<{ claims: (Claim & { userId: string; userEmail: string; userName: string; memberNumber: string; adminNote?: string; decidedAt?: string; decidedBy?: string })[] }>("/admin/claims", { adminToken }),
  adminUpdateClaimStatus: (adminToken: string, userId: string, claimId: string, status: Claim["status"], note?: string) =>
    apiFetch<{ claim: Claim }>(`/admin/claims/${userId}/${claimId}/status`, {
      method: "POST", body: { status, note }, adminToken,
    }),
  adminStats: (adminToken: string) =>
    apiFetch<{ users: number; claims: { total: number; pending: number }; revenue: number }>("/admin/stats", { adminToken }),
  adminMembers: (adminToken: string) =>
    apiFetch<{ members: AdminMember[] }>("/admin/members", { adminToken }),
  adminMember: (adminToken: string, uid: string) =>
    apiFetch<{
      profile: Profile & { suspended?: boolean };
      contracts: Contract[];
      claims: Claim[];
      payments: Payment[];
      beneficiaries: Beneficiary[];
      notifications: Notification[];
      settings: Settings | null;
    }>(`/admin/member/${uid}`, { adminToken }),
  adminSuspend: (adminToken: string, uid: string, suspended: boolean) =>
    apiFetch<{ ok: true; suspended: boolean }>(`/admin/member/${uid}/suspend`, {
      method: "POST", body: { suspended }, adminToken,
    }),
  adminContracts: (adminToken: string) =>
    apiFetch<{ contracts: (Contract & { userId: string; userEmail: string; userName: string })[] }>("/admin/contracts", { adminToken }),
  adminPayments: (adminToken: string) =>
    apiFetch<{ payments: (Payment & { userId: string; userEmail: string; userName: string })[] }>("/admin/payments", { adminToken }),
  adminBroadcast: (adminToken: string, input: { title: string; body: string; type?: "info" | "success" | "warn" }) =>
    apiFetch<{ ok: true; recipients: number }>("/admin/broadcast", { method: "POST", body: input, adminToken }),
  adminConversations: (adminToken: string, opts?: { q?: string; status?: string; mine?: boolean }) => {
    const qs = new URLSearchParams();
    if (opts?.q) qs.set("q", opts.q);
    if (opts?.status) qs.set("status", opts.status);
    if (opts?.mine) qs.set("mine", "1");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch<{ conversations: { userId: string; userEmail: string; userName: string; memberNumber: string; lastMessage: string; lastAt: string; lastFrom: string; unread: number; total: number; status: "ouvert"|"en_cours"|"resolu"; assignee: string|null; tags: string[] }[] }>(`/admin/messages${suffix}`, { adminToken });
  },
  adminUpdateConversationMeta: (adminToken: string, uid: string, patch: { status?: "ouvert"|"en_cours"|"resolu"; assignee?: string|null; tags?: string[] }) =>
    apiFetch<{ meta: { status: string; assignee: string|null; tags: string[]; updatedAt: string } }>(`/admin/messages/${uid}/meta`, { method: "PATCH", body: patch, adminToken }),
  adminConversation: (adminToken: string, uid: string) =>
    apiFetch<{ messages: { id: string; from: string; author: string; body: string; createdAt: string; read: boolean }[] }>(`/admin/messages/${uid}`, { adminToken }),
  adminReplyMessage: (adminToken: string, uid: string, content: string, replyToId?: string) =>
    apiFetch<{ message: { id: string; from: string; author: string; body: string; createdAt: string; read: boolean; replyToId?: string } }>(`/admin/messages/${uid}`, { method: "POST", body: { content, ...(replyToId ? { replyToId } : {}) }, adminToken }),
  adminEditMessage: (adminToken: string, uid: string, id: string, content: string) =>
    apiFetch<{ message: Message }>(`/admin/messages/${uid}/${id}`, { method: "PATCH", body: { content }, adminToken }),
  adminDeleteMessage: (adminToken: string, uid: string, id: string) =>
    apiFetch<{ message: Message }>(`/admin/messages/${uid}/${id}`, { method: "DELETE", adminToken }),
  adminMarkConversationRead: (adminToken: string, uid: string) =>
    apiFetch<{ ok: true; marked: number }>(`/admin/messages/${uid}/read`, { method: "POST", adminToken }),
  adminSendAttachment: async (adminToken: string, uid: string, file: File, caption?: string) => {
    const form = new FormData();
    form.append("file", file);
    if (caption) form.append("caption", caption);
    const res = await fetch(`${API_BASE}/admin/messages/${uid}/attachment`, {
      method: "POST",
      headers: { Authorization: `Bearer ${publicAnonKey}`, "X-Admin-Token": adminToken },
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data as { message: { id: string; from: string; author: string; body: string; createdAt: string; read: boolean; attachment?: MessageAttachment } };
  },
  adminMessageAttachmentUrl: (adminToken: string, path: string) =>
    apiFetch<{ url: string; expiresIn: number }>(`/messages/attachment-url?path=${encodeURIComponent(path)}`, { adminToken }),
  adminAuditRecent: (adminToken: string) =>
    apiFetch<{ entries: { id: string; action: string; meta: Record<string, any>; at: string; userId: string; userEmail: string; userName: string }[] }>("/admin/audit/recent", { adminToken }),
  promos: () => apiFetch<{ promos: Promo[] }>("/promos"),
  adminUpdatePromos: (adminToken: string, promos: Promo[]) =>
    apiFetch<{ ok: true; promos: Promo[] }>("/admin/promos", { method: "PUT", body: { promos }, adminToken }),
  partners: () => apiFetch<{ partners: Partner[] }>("/partners"),
  adminUpdatePartners: (adminToken: string, partners: Partner[]) =>
    apiFetch<{ ok: true; partners: Partner[] }>("/admin/partners", { method: "PUT", body: { partners }, adminToken }),
  site: () => apiFetch<{ site: SiteContent }>("/site"),
  adminUpdateSite: (adminToken: string, site: Partial<SiteContent>) =>
    apiFetch<{ ok: true; site: SiteContent }>("/admin/site", { method: "PUT", body: site, adminToken }),
  // Web Push
  pushVapid: () => apiFetch<{ publicKey: string | null }>("/push/vapid-public"),
  pushSync: (token: string, subscription: any) =>
    apiFetch<{ ok: true }>("/push/subscribe", { method: "POST", body: { subscription }, token }),
  pushRemove: (token: string, endpoint: string) =>
    apiFetch<{ ok: true }>("/push/unsubscribe", { method: "POST", body: { endpoint }, token }),
  // Wallet
  walletGoogle: (token: string) =>
    apiFetch<{ saveUrl: string | null; configured: boolean }>("/wallet/google", { token }),
  walletAppleUrl: (token: string) => `${API_BASE}/wallet/apple?t=${encodeURIComponent(token)}`,
};

export interface SiteContent {
  brandName: string;
  tagline: string;
  heroTitle: string;
  heroSubtitle: string;
  aboutShort: string;
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
  whatsapp: string;
  facebook: string;
  instagram: string;
  linkedin: string;
}

export interface Partner {
  id: string;
  name: string;
  kind: "clinique" | "pharmacie" | "hopital";
  address: string;
  city: string;
  phone: string;
  lat: number;
  lng: number;
  hours: string;
}

export interface Promo {
  id: string;
  image: string;
  alt: string;
  to?: string;
  active?: boolean;
}

export interface AdminMember {
  id: string;
  email: string;
  name: string;
  phone: string;
  memberNumber: string;
  createdAt: string | null;
  suspended: boolean;
  activeContracts: number;
  pendingClaims: number;
  revenue: number;
}
