import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Users, FileText, Wallet, RefreshCw, Search, X,
  Megaphone, History, Ban, CheckCircle2, ChevronRight, ListChecks, Image as ImageIcon, Trash2, Plus, Save, MapPin, Globe, MessageCircle, Send, Loader2,
} from "lucide-react";
import { useAdminAuth, useAdminData } from "../AdminLayout";
import { getSupabase } from "../supabaseClient";
import { formatDate, formatXOF } from "../hooks";
import { api, type Claim, type AdminMember, type Promo, type Partner, type SiteContent, type Payment, type Profile } from "../api";
import { Invoice } from "../components/Invoice";
import { Receipt, Paperclip, Reply, Pencil, Trash2, X } from "lucide-react";
import { AttachmentView } from "./MessageriePage";
import { StatusBadge } from "./DashboardPage";
import { toast } from "sonner";
import { RowSkeleton } from "../Skeleton";
import { statusLabel, methodLabel, relationLabel, auditActionLabel, formatMeta } from "../labels";

type AdminClaim = Claim & {
  userId: string; userEmail: string; userName: string; memberNumber: string; adminNote?: string;
};

type TabKey = "overview" | "claims" | "members" | "contracts" | "payments" | "messages" | "broadcast" | "promos" | "partners" | "site" | "audit";

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: "overview", label: "Vue d'ensemble", icon: ListChecks },
  { key: "claims", label: "Sinistres", icon: FileText },
  { key: "members", label: "Membres", icon: Users },
  { key: "contracts", label: "Contrats", icon: FileText },
  { key: "payments", label: "Paiements", icon: Wallet },
  { key: "messages", label: "Messagerie", icon: MessageCircle },
  { key: "broadcast", label: "Diffusion", icon: Megaphone },
  { key: "promos", label: "Carrousel", icon: ImageIcon },
  { key: "partners", label: "Partenaires", icon: MapPin },
  { key: "site", label: "Contenu du site", icon: Globe },
  { key: "audit", label: "Journal d'activité", icon: History },
];

export function AdminPage() {
  const { session } = useAdminAuth();
  const [tab, setTab] = useState<TabKey>("overview");

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="t-title1">Administration</h1>
        <p className="mt-1 text-[#666]" style={{ fontSize: "0.9rem" }}>
          Session ouverte par <strong>{session?.username}</strong>
        </p>
      </header>

      <nav className="bg-white rounded-2xl border border-black/5 p-2 mb-6 flex flex-wrap gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl transition ${on ? "bg-[#0E1320] text-white" : "text-[#0E1320] hover:bg-black/5"}`}
              style={{ fontSize: "0.82rem", fontWeight: 700 }}
            >
              <Icon className="w-4 h-4" />
              <span className="whitespace-nowrap">{t.label}</span>
            </button>
          );
        })}
      </nav>

      {tab === "overview" && <OverviewTab />}
      {tab === "claims" && <ClaimsTab />}
      {tab === "members" && <MembersTab />}
      {tab === "contracts" && <ContractsTab />}
      {tab === "payments" && <PaymentsTab />}
      {tab === "messages" && <MessagesTab />}
      {tab === "broadcast" && <BroadcastTab />}
      {tab === "promos" && <PromosTab />}
      {tab === "partners" && <PartnersTab />}
      {tab === "site" && <SiteTab />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

// =========================================================================
// OVERVIEW
// =========================================================================

function OverviewTab() {
  const { session } = useAdminAuth();
  const statsQ = useAdminData((t) => api.adminStats(t));
  const [running, setRunning] = useState(false);

  async function runBilling() {
    if (!session?.token) return;
    if (!window.confirm("Lancer le cycle de prélèvement mensuel pour tous les contrats actifs ?")) return;
    setRunning(true);
    try {
      const res = await api.adminRunBilling(session.token);
      toast.success(`Cycle ${res.cycleKey}`, { description: `${res.generated} prélèvements créés · ${res.skipped} ignorés` });
    } catch (err) {
      toast.error("Échec du cycle", { description: err instanceof Error ? err.message : "Erreur" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard icon={Users} label="Membres" value={statsQ.data?.users ?? "..."} tone="blue" />
        <StatCard
          icon={FileText}
          label="Sinistres en cours"
          value={`${statsQ.data?.claims.pending ?? "..."} / ${statsQ.data?.claims.total ?? "..."}`}
          tone="orange"
        />
        <StatCard icon={Wallet} label="Encaissé" value={statsQ.data ? formatXOF(statsQ.data.revenue) : "..."} tone="green" />
      </div>
      <div className="bg-white rounded-2xl border border-black/5 p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p style={{ fontSize: "0.92rem", fontWeight: 800 }}>Cycle de prélèvement mensuel</p>
          <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>
            Génère un prélèvement <strong>en attente</strong> pour chaque contrat actif dont la date d'échéance est dépassée. Les membres reçoivent une notification et règlent via KkiaPay.
          </p>
        </div>
        <button
          onClick={runBilling} disabled={running}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#0E1320] text-white disabled:opacity-50"
          style={{ fontSize: "0.82rem", fontWeight: 700 }}
        >
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wallet className="w-3.5 h-3.5" />}
          Lancer le cycle
        </button>
      </div>
    </div>
  );
}

// =========================================================================
// CLAIMS
// =========================================================================

const CLAIM_FILTERS: { key: "all" | Claim["status"]; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "en_cours", label: "En cours" },
  { key: "valide", label: "Validés" },
  { key: "regle", label: "Réglés" },
  { key: "rejete", label: "Rejetés" },
];

function ClaimsTab() {
  const { session } = useAdminAuth();
  const [filter, setFilter] = useState<"all" | Claim["status"]>("en_cours");
  const [busyId, setBusyId] = useState<string | null>(null);
  const claimsQ = useAdminData((t) => api.adminClaims(t));

  async function updateStatus(claim: AdminClaim, status: Claim["status"]) {
    if (!session?.token) return;
    setBusyId(claim.id);
    try {
      await api.adminUpdateClaimStatus(session.token, claim.userId, claim.id, status);
      await claimsQ.reload();
      toast.success("Statut mis à jour");
    } catch (err) {
      toast.error("Échec", { description: err instanceof Error ? err.message : "Erreur" });
    } finally {
      setBusyId(null);
    }
  }

  const claims = (claimsQ.data?.claims ?? []) as AdminClaim[];
  const filtered = filter === "all" ? claims : claims.filter((c) => c.status === filter);

  return (
    <div>
      <div className="bg-white rounded-2xl border border-black/5 p-3 sm:p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {CLAIM_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg ${filter === f.key ? "bg-[#0E1320] text-white" : "bg-black/5 text-[#0E1320]"}`}
              style={{ fontSize: "0.8rem", fontWeight: 700 }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => claimsQ.reload()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5"
          style={{ fontSize: "0.78rem", fontWeight: 700 }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Actualiser
        </button>
      </div>

      {claimsQ.loading && (
        <div className="bg-white rounded-2xl border border-black/5 overflow-hidden divide-y divide-black/5">
          <RowSkeleton /><RowSkeleton /><RowSkeleton />
        </div>
      )}
      {claimsQ.error && <p className="text-red-600">{claimsQ.error}</p>}
      {!claimsQ.loading && filtered.length === 0 && (
        <div className="bg-white rounded-2xl border border-black/5 p-10 text-center text-[#666]">
          Aucun sinistre dans cette catégorie.
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((cl) => (
          <div key={`${cl.userId}-${cl.id}`} className="bg-white rounded-2xl border border-black/5 p-4 sm:p-5 ippoo-fade-in">
            <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p style={{ fontSize: "0.95rem", fontWeight: 800 }}>{cl.type}</p>
                  <StatusBadge status={cl.status} />
                </div>
                <p className="text-[#666]" style={{ fontSize: "0.8rem" }}>
                  {cl.userName || "Sans nom"} · {cl.userEmail} {cl.memberNumber ? `· ${cl.memberNumber}` : ""}
                </p>
                <p className="text-[#999] mt-0.5" style={{ fontSize: "0.75rem" }}>
                  Déclaré le {formatDate(cl.createdAt)}
                </p>
              </div>
              {cl.amount ? (
                <div className="text-right">
                  <p style={{ fontSize: "1rem", fontWeight: 800 }}>{formatXOF(cl.amount)}</p>
                  <p className="text-[#666]" style={{ fontSize: "0.7rem" }}>montant demandé</p>
                </div>
              ) : null}
            </div>
            <p className="text-[#333] mb-3 whitespace-pre-wrap break-words" style={{ fontSize: "0.88rem" }}>{cl.description}</p>
            {cl.attachments && cl.attachments.length > 0 && (
              <p className="text-[#666] mb-3" style={{ fontSize: "0.78rem" }}>
                {cl.attachments.length} pièce{cl.attachments.length > 1 ? "s" : ""} jointe{cl.attachments.length > 1 ? "s" : ""}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <ActionBtn label="Valider" tone="green" disabled={busyId === cl.id || cl.status === "valide"} onClick={() => updateStatus(cl, "valide")} />
              <ActionBtn label="Régler" tone="blue" disabled={busyId === cl.id || cl.status === "regle"} onClick={() => updateStatus(cl, "regle")} />
              <ActionBtn label="Rejeter" tone="red" disabled={busyId === cl.id || cl.status === "rejete"} onClick={() => updateStatus(cl, "rejete")} />
              <ActionBtn label="Remettre en cours" tone="gray" disabled={busyId === cl.id || cl.status === "en_cours"} onClick={() => updateStatus(cl, "en_cours")} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =========================================================================
// MEMBERS
// =========================================================================

function MembersTab() {
  const { session } = useAdminAuth();
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const membersQ = useAdminData((t) => api.adminMembers(t));

  const members = (membersQ.data?.members ?? []) as AdminMember[];
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return members;
    return members.filter((m) =>
      (m.name + " " + m.email + " " + (m.memberNumber ?? "") + " " + (m.phone ?? ""))
        .toLowerCase()
        .includes(s),
    );
  }, [members, q]);

  async function toggleSuspend(m: AdminMember) {
    if (!session?.token) return;
    setBusy(m.id);
    try {
      await api.adminSuspend(session.token, m.id, !m.suspended);
      await membersQ.reload();
      toast.success(m.suspended ? "Membre réactivé" : "Membre suspendu");
    } catch (err) {
      toast.error("Échec", { description: err instanceof Error ? err.message : "Erreur" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="bg-white rounded-2xl border border-black/5 p-3 sm:p-4 mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#888]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Nom, e-mail, n° membre, téléphone..."
            className="w-full pl-9 pr-3 py-2 rounded-lg border border-black/10 bg-white"
            style={{ fontSize: "0.85rem" }}
          />
        </div>
        <button
          onClick={() => membersQ.reload()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5"
          style={{ fontSize: "0.78rem", fontWeight: 700 }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Actualiser
        </button>
      </div>

      {membersQ.loading && <RowSkeleton />}
      {!membersQ.loading && filtered.length === 0 && (
        <div className="bg-white rounded-2xl border border-black/5 p-10 text-center text-[#666]">
          Aucun membre.
        </div>
      )}

      <div className="bg-white rounded-2xl border border-black/5 overflow-hidden divide-y divide-black/5">
        {filtered.map((m) => (
          <div key={m.id} className="p-4 flex flex-wrap items-center justify-between gap-3 hover:bg-black/5">
            <button
              onClick={() => setSelected(m.id)}
              className="flex-1 min-w-[200px] text-left"
            >
              <div className="flex items-center gap-2 mb-1">
                <p style={{ fontSize: "0.92rem", fontWeight: 800 }}>{m.name || "Sans nom"}</p>
                {m.suspended && <span className="px-2 py-0.5 rounded-full bg-[#FFDDE2] text-[#C0263A]" style={{ fontSize: "0.7rem", fontWeight: 800 }}>Suspendu</span>}
              </div>
              <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>
                {m.email}{m.memberNumber ? ` · ${m.memberNumber}` : ""}
              </p>
              <p className="text-[#999] mt-0.5" style={{ fontSize: "0.72rem" }}>
                {m.activeContracts} contrat{m.activeContracts > 1 ? "s" : ""} actif{m.activeContracts > 1 ? "s" : ""} · {m.pendingClaims} sinistre{m.pendingClaims > 1 ? "s" : ""} en cours · {formatXOF(m.revenue)}
              </p>
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleSuspend(m)}
                disabled={busy === m.id}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg disabled:opacity-40"
                style={{
                  fontSize: "0.78rem", fontWeight: 700,
                  background: m.suspended ? "#DBFBE7" : "#FFDDE2",
                  color: m.suspended ? "#0F7A47" : "#C0263A",
                }}
              >
                {m.suspended ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                {m.suspended ? "Réactiver" : "Suspendre"}
              </button>
              <button onClick={() => setSelected(m.id)} className="p-2 rounded-lg hover:bg-black/5">
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {selected && <MemberDrawer uid={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MemberDrawer({ uid, onClose }: { uid: string; onClose: () => void }) {
  const detailQ = useAdminData((t) => api.adminMember(t, uid));
  const d = detailQ.data;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button aria-label="Fermer" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white w-full max-w-md h-full overflow-y-auto p-5 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 style={{ fontSize: "1.1rem", fontWeight: 900 }}>Fiche membre</h2>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-black/5"><X className="w-4 h-4" /></button>
        </div>
        {detailQ.loading && <RowSkeleton />}
        {detailQ.error && <p className="text-red-600">{detailQ.error}</p>}
        {d && (
          <div className="space-y-4">
            <Section title="Profil">
              <KV k="Nom" v={d.profile.name || "—"} />
              <KV k="E-mail" v={d.profile.email} />
              <KV k="Téléphone" v={d.profile.phone || "—"} />
              <KV k="N° membre" v={d.profile.memberNumber || "—"} />
              <KV k="Carte" v={d.profile.cardActive ? "Active" : "Inactive"} />
              <KV k="Inscrit le" v={d.profile.createdAt ? formatDate(d.profile.createdAt) : "—"} />
            </Section>
            <Section title={`Contrats (${d.contracts.length})`}>
              {d.contracts.length === 0 ? <Empty /> : d.contracts.map((c) => (
                <div key={c.id} className="flex items-center justify-between py-1.5" style={{ fontSize: "0.82rem" }}>
                  <span className="truncate">{c.product}</span>
                  <span className="text-[#666]">{statusLabel(c.status)} · {formatXOF(c.premium)}</span>
                </div>
              ))}
            </Section>
            <Section title={`Sinistres (${d.claims.length})`}>
              {d.claims.length === 0 ? <Empty /> : d.claims.slice(0, 6).map((c) => (
                <div key={c.id} className="flex items-center justify-between py-1.5" style={{ fontSize: "0.82rem" }}>
                  <span className="truncate">{c.type}</span>
                  <StatusBadge status={c.status} />
                </div>
              ))}
            </Section>
            <Section title={`Paiements (${d.payments.length})`}>
              {d.payments.length === 0 ? <Empty /> : d.payments.slice(0, 6).map((p) => (
                <div key={p.id} className="flex items-center justify-between py-1.5" style={{ fontSize: "0.82rem" }}>
                  <span>{formatDate(p.createdAt)}</span>
                  <span className="text-[#666]">{formatXOF(p.amount)} · {statusLabel(p.status)}</span>
                </div>
              ))}
            </Section>
            <Section title={`Bénéficiaires (${d.beneficiaries.length})`}>
              {d.beneficiaries.length === 0 ? <Empty /> : d.beneficiaries.map((b) => (
                <div key={b.id} className="py-1.5" style={{ fontSize: "0.82rem" }}>
                  {b.name} <span className="text-[#666]">· {relationLabel(b.relation)}</span>
                </div>
              ))}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#F9FAFC] rounded-xl p-3">
      <p className="mb-2 text-[#666]" style={{ fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.05em", textTransform: "uppercase" }}>{title}</p>
      <div>{children}</div>
    </div>
  );
}
function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between py-1" style={{ fontSize: "0.82rem" }}>
      <span className="text-[#666]">{k}</span>
      <span style={{ fontWeight: 700 }}>{v}</span>
    </div>
  );
}
function Empty() { return <p className="text-[#999]" style={{ fontSize: "0.78rem" }}>Aucun élément.</p>; }

// =========================================================================
// CONTRACTS
// =========================================================================

function ContractsTab() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "pending" | "expired">("all");
  const dataQ = useAdminData((t) => api.adminContracts(t));
  const items = dataQ.data?.contracts ?? [];

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((c) => {
      if (status !== "all" && c.status !== status) return false;
      if (!s) return true;
      return (c.product + " " + c.userEmail + " " + c.userName).toLowerCase().includes(s);
    });
  }, [items, q, status]);

  return (
    <div>
      <FiltersBar q={q} setQ={setQ} reload={dataQ.reload}>
        <Select value={status} onChange={(v) => setStatus(v as any)} options={[
          ["all", "Tous"], ["active", "Actifs"], ["pending", "En attente"], ["expired", "Expirés"],
        ]} />
      </FiltersBar>
      {dataQ.loading && <RowSkeleton />}
      <div className="bg-white rounded-2xl border border-black/5 overflow-hidden divide-y divide-black/5">
        {filtered.map((c) => (
          <div key={`${c.userId}-${c.id}`} className="p-4 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p style={{ fontSize: "0.88rem", fontWeight: 800 }}>{c.product}</p>
              <p className="text-[#666]" style={{ fontSize: "0.76rem" }}>{c.userName || c.userEmail}</p>
              <p className="text-[#999] mt-0.5" style={{ fontSize: "0.72rem" }}>
                {formatDate(c.startDate)} → {formatDate(c.endDate)}
              </p>
            </div>
            <div className="text-right">
              <p style={{ fontSize: "0.88rem", fontWeight: 800 }}>{formatXOF(c.premium)}</p>
              <p className="text-[#666]" style={{ fontSize: "0.72rem" }}>{statusLabel(c.status)}</p>
            </div>
          </div>
        ))}
        {!dataQ.loading && filtered.length === 0 && (
          <div className="p-10 text-center text-[#666]">Aucun contrat.</div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// PAYMENTS
// =========================================================================

function PaymentsTab() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | "confirme" | "en_attente" | "echec">("all");
  const [invoicePayment, setInvoicePayment] = useState<Payment | null>(null);
  const [invoiceProfile, setInvoiceProfile] = useState<Profile | null>(null);
  const dataQ = useAdminData((t) => api.adminPayments(t));
  const items = dataQ.data?.payments ?? [];

  function openInvoice(p: typeof items[number]) {
    const payment: Payment = {
      id: p.id, amount: p.amount, method: p.method, status: p.status,
      createdAt: p.createdAt, contractId: (p as any).contractId,
    } as Payment;
    const profile = {
      id: p.userId, email: p.userEmail, name: p.userName,
      memberNumber: (p as any).memberNumber,
    } as Profile;
    setInvoicePayment(payment);
    setInvoiceProfile(profile);
  }

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((p) => {
      if (status !== "all" && p.status !== status) return false;
      if (!s) return true;
      return (p.method + " " + p.userEmail + " " + p.userName).toLowerCase().includes(s);
    });
  }, [items, q, status]);

  const total = filtered.filter((p) => p.status === "confirme").reduce((s, p) => s + p.amount, 0);

  return (
    <div>
      <FiltersBar q={q} setQ={setQ} reload={dataQ.reload}>
        <Select value={status} onChange={(v) => setStatus(v as any)} options={[
          ["all", "Tous"], ["confirme", "Confirmés"], ["en_attente", "En attente"], ["echec", "Échecs"],
        ]} />
      </FiltersBar>

      <div className="bg-[#FFF8F2] border border-black/5 rounded-2xl p-3 mb-3 flex items-center justify-between">
        <span className="text-[#666]" style={{ fontSize: "0.8rem" }}>Encaissé (sélection)</span>
        <span style={{ fontSize: "1rem", fontWeight: 900 }}>{formatXOF(total)}</span>
      </div>

      {dataQ.loading && <RowSkeleton />}
      <div className="bg-white rounded-2xl border border-black/5 overflow-hidden divide-y divide-black/5">
        {filtered.map((p) => (
          <div key={`${p.userId}-${p.id}`} className="p-4 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p style={{ fontSize: "0.86rem", fontWeight: 800 }}>{p.userName || p.userEmail}</p>
              <p className="text-[#666]" style={{ fontSize: "0.74rem" }}>{methodLabel(p.method)} · {formatDate(p.createdAt)}</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <p style={{ fontSize: "0.88rem", fontWeight: 800 }}>{formatXOF(p.amount)}</p>
                <StatusBadge status={p.status} />
              </div>
              {p.status === "confirme" && (
                <button
                  onClick={() => openInvoice(p)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0E1320] text-white hover:bg-[#1a1f2e]"
                  style={{ fontSize: "0.74rem", fontWeight: 700 }}
                >
                  <Receipt className="w-3.5 h-3.5" /> Reçu
                </button>
              )}
            </div>
          </div>
        ))}
        {!dataQ.loading && filtered.length === 0 && (
          <div className="p-10 text-center text-[#666]">Aucun paiement.</div>
        )}
      </div>
      {invoicePayment && (
        <Invoice
          open={!!invoicePayment}
          onClose={() => { setInvoicePayment(null); setInvoiceProfile(null); }}
          payment={invoicePayment}
          profile={invoiceProfile}
          contract={null}
        />
      )}
    </div>
  );
}

// =========================================================================
// MESSAGES
// =========================================================================

function MessagesTab() {
  const { session } = useAdminAuth();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ouvert" | "en_cours" | "resolu">("");
  const [mineOnly, setMineOnly] = useState(false);
  const adminUsername = session?.username ?? "";
  const fetcher = useMemo(
    () => (t: string) => api.adminConversations(t, { q: q || undefined, status: statusFilter || undefined, mine: mineOnly || undefined }),
    [q, statusFilter, mineOnly],
  );
  const convosQ = useAdminData(fetcher);
  const [selected, setSelected] = useState<string | null>(null);
  type AdminMsg = { id: string; from: string; author: string; body: string; createdAt: string; read: boolean; attachment?: { name: string; mime: string; size: number; path: string }; replyToId?: string; editedAt?: string; deletedAt?: string };
  const [thread, setThread] = useState<AdminMsg[]>([]);
  const [replyTo, setReplyTo] = useState<{ id: string; author: string; body: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [userTyping, setUserTyping] = useState(false);
  const userChannelRef = useRef<ReturnType<ReturnType<typeof getSupabase>["channel"]> | null>(null);
  const userTypingTimerRef = useRef<number | null>(null);
  const lastAdminTypingRef = useRef(0);
  const [loadingThread, setLoadingThread] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const conversations = convosQ.data?.conversations ?? [];
  const current = conversations.find((c) => c.userId === selected) ?? null;

  useEffect(() => {
    const sb = getSupabase();
    const ch = sb.channel("admin:chat", { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "message:new" }, ({ payload }) => {
      const uid = payload?.userId as string | undefined;
      const msg = payload?.message as { id: string; from: string; author: string; body: string; createdAt: string; read: boolean } | undefined;
      convosQ.reload();
      if (uid && msg && uid === selected) {
        setThread((t) => (t.some((m) => m.id === msg.id) ? t : [...t, msg]));
      }
    });
    ch.on("broadcast", { event: "message:read" }, ({ payload }) => {
      const uid = payload?.userId as string | undefined;
      convosQ.reload();
      if (uid && uid === selected) {
        setThread((t) => t.map((m) => (m.from === "conseiller" && !m.read ? { ...m, read: true } : m)));
      }
    });
    ch.on("broadcast", { event: "meta:update" }, () => { convosQ.reload(); });
    ch.on("broadcast", { event: "message:update" }, ({ payload }) => {
      const uid = payload?.userId as string | undefined;
      const msg = payload?.message as AdminMsg | undefined;
      convosQ.reload();
      if (uid && msg && uid === selected) {
        setThread((t) => t.map((m) => (m.id === msg.id ? msg : m)));
      }
    });
    ch.subscribe();
    return () => { sb.removeChannel(ch); };
  }, [selected, convosQ.reload]);

  // Open a per-user channel for the currently selected conversation so we can
  // see/send typing pings. Recreated whenever `selected` changes.
  useEffect(() => {
    setUserTyping(false);
    if (!selected) { userChannelRef.current = null; return; }
    const sb = getSupabase();
    const ch = sb.channel(`chat:${selected}`, { config: { broadcast: { self: false } } });
    ch.on("broadcast", { event: "typing" }, ({ payload }) => {
      if (payload?.from !== "user") return;
      setUserTyping(!!payload?.typing);
      if (userTypingTimerRef.current) window.clearTimeout(userTypingTimerRef.current);
      if (payload?.typing) userTypingTimerRef.current = window.setTimeout(() => setUserTyping(false), 3500);
    });
    ch.subscribe();
    userChannelRef.current = ch;
    return () => {
      if (userTypingTimerRef.current) window.clearTimeout(userTypingTimerRef.current);
      sb.removeChannel(ch);
      userChannelRef.current = null;
    };
  }, [selected]);

  function emitAdminTyping() {
    if (!userChannelRef.current) return;
    const now = Date.now();
    if (now - lastAdminTypingRef.current < 2000) return;
    lastAdminTypingRef.current = now;
    userChannelRef.current.send({ type: "broadcast", event: "typing", payload: { from: "conseiller", typing: true } });
  }

  async function openThread(uid: string) {
    if (!session?.token) return;
    setSelected(uid);
    setLoadingThread(true);
    try {
      const res = await api.adminConversation(session.token, uid);
      setThread(res.messages);
      convosQ.reload();
      api.adminMarkConversationRead(session.token, uid).catch(() => {});
    } catch (err) {
      toast.error("Échec de chargement", { description: err instanceof Error ? err.message : "Erreur" });
    } finally {
      setLoadingThread(false);
    }
  }

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !session?.token || !selected) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("Fichier trop volumineux (max 10 Mo)"); return; }
    setSending(true);
    try {
      const res = await api.adminSendAttachment(session.token, selected, file, reply.trim() || undefined);
      setThread((t) => [...t, res.message]);
      setReply("");
      convosQ.reload();
    } catch (err) {
      toast.error("Envoi impossible", { description: err instanceof Error ? err.message : "Erreur" });
    } finally { setSending(false); }
  }

  async function send() {
    if (!session?.token || !selected) return;
    const content = reply.trim();
    if (!content) return;
    setSending(true);
    const editing = editingId;
    const replyId = replyTo?.id;
    setReply("");
    setEditingId(null);
    setReplyTo(null);
    try {
      if (editing) {
        const res = await api.adminEditMessage(session.token, selected, editing, content);
        setThread((t) => t.map((m) => (m.id === editing ? (res.message as AdminMsg) : m)));
      } else {
        const res = await api.adminReplyMessage(session.token, selected, content, replyId);
        setThread((t) => [...t, res.message as AdminMsg]);
      }
      convosQ.reload();
    } catch (err) {
      toast.error("Envoi impossible", { description: err instanceof Error ? err.message : "Erreur" });
    } finally {
      setSending(false);
    }
  }

  async function adminDelete(id: string) {
    if (!session?.token || !selected) return;
    if (!window.confirm("Supprimer ce message ?")) return;
    try {
      const res = await api.adminDeleteMessage(session.token, selected, id);
      setThread((t) => t.map((m) => (m.id === id ? (res.message as AdminMsg) : m)));
    } catch (err) {
      toast.error("Suppression impossible", { description: err instanceof Error ? err.message : "Erreur" });
    }
  }
  function adminStartEdit(m: AdminMsg) { setEditingId(m.id); setReplyTo(null); setReply(m.body); }
  function adminCancelEdit() { setEditingId(null); setReply(""); }

  async function updateMeta(patch: { status?: "ouvert"|"en_cours"|"resolu"; assignee?: string|null }) {
    if (!session?.token || !selected) return;
    try {
      await api.adminUpdateConversationMeta(session.token, selected, patch);
      convosQ.reload();
    } catch (err) {
      toast.error("Mise à jour impossible", { description: err instanceof Error ? err.message : "Erreur" });
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3">
      <div className="bg-white rounded-2xl border border-black/5 overflow-hidden">
        <div className="px-3 py-2 border-b border-black/5 flex items-center justify-between">
          <span style={{ fontSize: "0.82rem", fontWeight: 800 }}>Conversations</span>
          <button onClick={() => convosQ.reload()} className="p-1.5 rounded-lg hover:bg-black/5" title="Rafraîchir">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-3 py-2 border-b border-black/5 space-y-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[#888]" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher (nom, email, n° membre, texte)"
              className="w-full pl-7 pr-7 py-1.5 rounded-lg border border-black/10"
              style={{ fontSize: "0.78rem" }}
            />
            {q && (
              <button onClick={() => setQ("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-[#888]" aria-label="Effacer">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {([
              { v: "", label: "Tous" },
              { v: "ouvert", label: "Ouvert" },
              { v: "en_cours", label: "En cours" },
              { v: "resolu", label: "Résolu" },
            ] as const).map((o) => (
              <button
                key={o.v}
                onClick={() => setStatusFilter(o.v as typeof statusFilter)}
                className={`px-2 py-0.5 rounded-full border ${statusFilter === o.v ? "bg-[#0E1320] text-white border-[#0E1320]" : "bg-white text-[#666] border-black/10 hover:border-black/20"}`}
                style={{ fontSize: "0.68rem", fontWeight: 700 }}
              >
                {o.label}
              </button>
            ))}
            <label className="ml-auto inline-flex items-center gap-1 text-[#666]" style={{ fontSize: "0.7rem", fontWeight: 700 }}>
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} className="accent-[#FF3B57]" />
              Mes conv.
            </label>
          </div>
        </div>
        <div className="divide-y divide-black/5 max-h-[60vh] overflow-y-auto">
          {convosQ.loading && <RowSkeleton />}
          {!convosQ.loading && conversations.length === 0 && (
            <div className="p-6 text-center text-[#666]" style={{ fontSize: "0.82rem" }}>Aucune conversation.</div>
          )}
          {conversations.map((c) => {
            const statusColor = c.status === "resolu" ? "#0F7A47" : c.status === "en_cours" ? "#B36B00" : "#2A6BFF";
            const statusBg = c.status === "resolu" ? "#E6F4EC" : c.status === "en_cours" ? "#FFF1DC" : "#E8F0FF";
            return (
              <button
                key={c.userId}
                onClick={() => openThread(c.userId)}
                className={`w-full text-left p-3 transition ${selected === c.userId ? "bg-[#FFF1F3]" : "hover:bg-black/[0.02]"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate" style={{ fontSize: "0.84rem", fontWeight: 800 }}>{c.userName || c.userEmail}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="px-1.5 py-0.5 rounded-full" style={{ background: statusBg, color: statusColor, fontSize: "0.62rem", fontWeight: 800 }}>
                      {c.status === "resolu" ? "Résolu" : c.status === "en_cours" ? "En cours" : "Ouvert"}
                    </span>
                    {c.unread > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-[#FF3B57] text-white" style={{ fontSize: "0.65rem", fontWeight: 800 }}>{c.unread}</span>
                    )}
                  </div>
                </div>
                <p className="truncate text-[#666] mt-0.5" style={{ fontSize: "0.74rem" }}>
                  {c.lastFrom === "user" ? "" : "Vous : "}{c.lastMessage}
                </p>
                <div className="flex items-center justify-between mt-0.5">
                  <p className="text-[#999]" style={{ fontSize: "0.68rem" }}>{formatDate(c.lastAt)}</p>
                  {c.assignee && (
                    <span className="text-[#888] truncate ml-2" style={{ fontSize: "0.66rem", fontWeight: 700 }}>
                      → {c.assignee === adminUsername ? "moi" : c.assignee}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 flex flex-col min-h-[60vh]">
        {!current ? (
          <div className="flex-1 flex items-center justify-center text-[#666]" style={{ fontSize: "0.86rem" }}>
            Sélectionnez une conversation.
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-black/5 flex items-center gap-3 flex-wrap">
              <div className="flex-1 min-w-0">
                <p style={{ fontSize: "0.92rem", fontWeight: 800 }}>{current.userName || current.userEmail}</p>
                <p className="text-[#666]" style={{ fontSize: "0.72rem" }}>
                  {current.userEmail}{current.memberNumber ? ` · ${current.memberNumber}` : ""}
                  {userTyping && <span className="ml-2 text-[#16B26A]" style={{ fontWeight: 700 }}>· écrit…</span>}
                </p>
              </div>
              <select
                value={current.status}
                onChange={(e) => updateMeta({ status: e.target.value as "ouvert"|"en_cours"|"resolu" })}
                className="px-2 py-1.5 rounded-lg border border-black/10 bg-white"
                style={{ fontSize: "0.74rem", fontWeight: 700 }}
                title="Statut de la conversation"
              >
                <option value="ouvert">Ouvert</option>
                <option value="en_cours">En cours</option>
                <option value="resolu">Résolu</option>
              </select>
              {current.assignee === adminUsername ? (
                <button onClick={() => updateMeta({ assignee: null })} className="px-2.5 py-1.5 rounded-lg bg-[#FFF1F3] text-[#C0263A]" style={{ fontSize: "0.74rem", fontWeight: 700 }}>
                  Désassigner
                </button>
              ) : (
                <button onClick={() => updateMeta({ assignee: adminUsername })} className="px-2.5 py-1.5 rounded-lg bg-[#0E1320] text-white" style={{ fontSize: "0.74rem", fontWeight: 700 }}>
                  {current.assignee ? `Reprendre (${current.assignee})` : "M'assigner"}
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#F9FAFC]">
              {loadingThread && <p className="text-[#666]">Chargement...</p>}
              {(() => { const byId = new Map(thread.map((m) => [m.id, m])); return thread.map((m) => {
                const mine = m.from !== "user";
                const deleted = !!m.deletedAt;
                const quoted = m.replyToId ? byId.get(m.replyToId) : undefined;
                const canEdit = mine && !deleted && (Date.now() - new Date(m.createdAt).getTime() < 5 * 60 * 1000);
                const canDelete = mine && !deleted;
                return (
                  <div key={m.id} className={`group flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div className="max-w-[75%]">
                      <div
                        className="px-3 py-2 rounded-2xl"
                        style={{
                          background: deleted ? "#EEE" : mine ? "linear-gradient(90deg,#0E1320,#2A1840)" : "white",
                          color: deleted ? "#888" : mine ? "white" : "#111",
                          fontSize: "0.86rem",
                          fontStyle: deleted ? "italic" : undefined,
                        }}
                      >
                        {quoted && !deleted && (
                          <div className="mb-1.5 px-2 py-1 rounded-lg border-l-2"
                            style={{ borderColor: mine ? "rgba(255,255,255,0.7)" : "#0E1320", background: mine ? "rgba(255,255,255,0.12)" : "#F5F6FA", fontSize: "0.7rem" }}>
                            <p style={{ fontWeight: 800 }}>{quoted.author}</p>
                            <p className="line-clamp-2 opacity-90">{quoted.body || (quoted.attachment ? "📎 Pièce jointe" : "")}</p>
                          </div>
                        )}
                        {deleted ? <span>Message supprimé</span> : <>
                          {m.attachment && (
                            <AttachmentView att={m.attachment} mine={mine} getUrl={async (path) => (await api.adminMessageAttachmentUrl(session!.token, path)).url} />
                          )}
                          {m.body && <div className={m.attachment ? "mt-2" : ""}>{m.body}</div>}
                        </>}
                      </div>
                      <p className={`text-[#888] mt-1 px-1 flex items-center gap-1.5 ${mine ? "justify-end" : "justify-start"}`} style={{ fontSize: "0.66rem" }}>
                        <span>{m.author} · {formatDate(m.createdAt)}{m.editedAt && !deleted ? " · modifié" : ""}</span>
                        {!deleted && (
                          <button onClick={() => setReplyTo({ id: m.id, author: m.author, body: m.body || (m.attachment ? "📎 Pièce jointe" : "") })}
                            className="opacity-0 group-hover:opacity-100 transition p-0.5 hover:text-[#0E1320]" title="Répondre" aria-label="Répondre">
                            <Reply className="w-3 h-3" />
                          </button>
                        )}
                        {canEdit && <button onClick={() => adminStartEdit(m)} className="opacity-0 group-hover:opacity-100 transition p-0.5 hover:text-[#0E1320]" title="Modifier"><Pencil className="w-3 h-3" /></button>}
                        {canDelete && <button onClick={() => adminDelete(m.id)} className="opacity-0 group-hover:opacity-100 transition p-0.5 hover:text-[#C0263A]" title="Supprimer"><Trash2 className="w-3 h-3" /></button>}
                      </p>
                    </div>
                  </div>
                );
              }); })()}
            </div>
            {(replyTo || editingId) && (
              <div className="px-3 py-2 border-t border-black/5 bg-[#F9FAFC] flex items-center gap-2">
                <div className="flex-1 min-w-0 border-l-2 border-[#0E1320] pl-2">
                  <p className="text-[#666] truncate" style={{ fontSize: "0.68rem", fontWeight: 800 }}>
                    {editingId ? "Modification du message" : `Réponse à ${replyTo?.author}`}
                  </p>
                  {replyTo && <p className="text-[#888] truncate" style={{ fontSize: "0.7rem" }}>{replyTo.body}</p>}
                </div>
                <button type="button" onClick={() => { setReplyTo(null); if (editingId) adminCancelEdit(); }} className="p-1 text-[#666] hover:text-[#0E1320]" aria-label="Annuler">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
            <form
              onSubmit={(e) => { e.preventDefault(); send(); }}
              className="p-3 border-t border-black/5 flex items-center gap-2"
            >
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept="image/*,application/pdf,audio/*,video/mp4,video/webm,text/plain"
                onChange={onPickFile}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={sending}
                className="p-2 rounded-xl border border-black/10 text-[#666] hover:text-[#0E1320] disabled:opacity-50"
                title="Joindre un fichier (max 10 Mo)"
                aria-label="Joindre"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <input
                value={reply} onChange={(e) => { setReply(e.target.value); emitAdminTyping(); }}
                placeholder="Votre réponse au membre…"
                className="flex-1 px-3 py-2 rounded-xl border border-black/10"
                style={{ fontSize: "0.88rem" }}
                disabled={sending}
              />
              <button
                type="submit" disabled={sending || !reply.trim()}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#0E1320] text-white disabled:opacity-50"
                style={{ fontSize: "0.82rem", fontWeight: 700 }}
              >
                <Send className="w-3.5 h-3.5" /> Envoyer
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// BROADCAST
// =========================================================================

function BroadcastTab() {
  const { session } = useAdminAuth();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState<"info" | "success" | "warn">("info");
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!session?.token) return;
    if (!title.trim() || !body.trim()) {
      toast.error("Titre et message requis"); return;
    }
    if (!window.confirm("Envoyer cette notification à tous les membres ?")) return;
    setBusy(true);
    try {
      const res = await api.adminBroadcast(session.token, { title: title.trim(), body: body.trim(), type });
      toast.success(`Envoyé à ${res.recipients} membre${res.recipients > 1 ? "s" : ""}`);
      setTitle(""); setBody("");
    } catch (err) {
      toast.error("Échec", { description: err instanceof Error ? err.message : "Erreur" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-black/5 p-5 max-w-2xl">
      <h2 style={{ fontSize: "1.05rem", fontWeight: 900 }}>Diffuser une notification</h2>
      <p className="text-[#666] mt-1 mb-4" style={{ fontSize: "0.82rem" }}>
        Ce message apparaîtra dans la cloche de notifications de chaque membre.
      </p>
      <label className="block mb-3">
        <span className="block mb-1 text-[#666]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>Titre</span>
        <input
          value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80}
          className="w-full px-3 py-2 rounded-lg border border-black/10"
          placeholder="Ex. Nouveau service disponible"
          style={{ fontSize: "0.88rem" }}
        />
      </label>
      <label className="block mb-3">
        <span className="block mb-1 text-[#666]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>Message</span>
        <textarea
          value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={400}
          className="w-full px-3 py-2 rounded-lg border border-black/10"
          placeholder="Décrivez l'information à transmettre..."
          style={{ fontSize: "0.88rem" }}
        />
      </label>
      <label className="block mb-4">
        <span className="block mb-1 text-[#666]" style={{ fontSize: "0.78rem", fontWeight: 700 }}>Type</span>
        <Select value={type} onChange={(v) => setType(v as any)} options={[
          ["info", "Information"], ["success", "Succès"], ["warn", "Alerte"],
        ]} />
      </label>
      <button
        onClick={send} disabled={busy}
        className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#FF3B57] text-white disabled:opacity-50"
        style={{ fontSize: "0.85rem", fontWeight: 800 }}
      >
        <Megaphone className="w-4 h-4" />
        {busy ? "Envoi..." : "Envoyer à tous les membres"}
      </button>
    </div>
  );
}

// =========================================================================
// AUDIT
// =========================================================================

function AuditTab() {
  const dataQ = useAdminData((t) => api.adminAuditRecent(t));
  const entries = dataQ.data?.entries ?? [];
  return (
    <div>
      <div className="bg-white rounded-2xl border border-black/5 p-3 mb-3 flex items-center justify-end">
        <button
          onClick={() => dataQ.reload()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5"
          style={{ fontSize: "0.78rem", fontWeight: 700 }}
        >
          <RefreshCw className="w-3.5 h-3.5" /> Actualiser
        </button>
      </div>
      {dataQ.loading && <RowSkeleton />}
      <div className="bg-white rounded-2xl border border-black/5 overflow-hidden divide-y divide-black/5">
        {entries.map((e) => (
          <div key={e.id} className="p-4">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p style={{ fontSize: "0.86rem", fontWeight: 800 }}>{auditActionLabel(e.action)}</p>
              <span className="text-[#999]" style={{ fontSize: "0.72rem" }}>{formatDate(e.at)}</span>
            </div>
            <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>
              {e.userName || "Sans nom"} · {e.userEmail || e.userId.slice(0, 8)}
            </p>
            {e.meta && Object.keys(e.meta).length > 0 && (
              <p className="mt-2 text-[#555]" style={{ fontSize: "0.78rem" }}>
                {formatMeta(e.meta)}
              </p>
            )}
          </div>
        ))}
        {!dataQ.loading && entries.length === 0 && (
          <div className="p-10 text-center text-[#666]">Aucune entrée d'audit.</div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Shared bits
// =========================================================================

function FiltersBar({
  q, setQ, reload, children,
}: { q: string; setQ: (v: string) => void; reload: () => void; children?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-black/5 p-3 sm:p-4 mb-4 flex flex-wrap items-center gap-3">
      <div className="relative flex-1 min-w-[200px]">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#888]" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher..."
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-black/10 bg-white"
          style={{ fontSize: "0.85rem" }}
        />
      </div>
      {children}
      <button
        onClick={reload}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-black/5"
        style={{ fontSize: "0.78rem", fontWeight: 700 }}
      >
        <RefreshCw className="w-3.5 h-3.5" /> Actualiser
      </button>
    </div>
  );
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="px-3 py-2 rounded-lg border border-black/10 bg-white"
      style={{ fontSize: "0.82rem", fontWeight: 700 }}
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>{label}</option>
      ))}
    </select>
  );
}

function StatCard({ icon: Icon, label, value, tone }: { icon: any; label: string; value: any; tone: "blue" | "orange" | "green" }) {
  const bg = tone === "blue" ? "#DDE7FF" : tone === "orange" ? "#FFE8D6" : "#D6F5DC";
  const fg = tone === "blue" ? "#2A6BFF" : tone === "orange" ? "#FF7A00" : "#1E9E4A";
  return (
    <div className="bg-white rounded-2xl border border-black/5 p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: bg }}>
        <Icon className="w-5 h-5" style={{ color: fg }} />
      </div>
      <div className="min-w-0">
        <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>{label}</p>
        <p className="truncate" style={{ fontSize: "1.1rem", fontWeight: 800 }}>{value}</p>
      </div>
    </div>
  );
}

function ActionBtn({ label, tone, onClick, disabled }: { label: string; tone: "green" | "red" | "blue" | "gray"; onClick: () => void; disabled?: boolean }) {
  const bg = tone === "green" ? "#1E9E4A" : tone === "red" ? "#FF3B57" : tone === "blue" ? "#2A6BFF" : "#0E1320";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-3 py-2 rounded-lg text-white disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ background: bg, fontSize: "0.8rem", fontWeight: 700 }}
    >
      {label}
    </button>
  );
}

// =========================================================================
// PROMOS — éditeur du carrousel d'annonces
// =========================================================================

function PromosTab() {
  const { session } = useAdminAuth();
  const [items, setItems] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  function reload() {
    setLoading(true);
    api.promos().then((r) => setItems(r.promos ?? [])).finally(() => setLoading(false));
  }
  useEffect(() => { reload(); }, []);

  function update(i: number, patch: Partial<Promo>) {
    setItems((arr) => arr.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function add() {
    setItems((arr) => [...arr, { id: `promo_${Date.now()}`, image: "", alt: "Annonce IPPOO", to: "", active: true }]);
  }
  function remove(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    setItems((arr) => {
      const next = arr.slice();
      const j = i + dir;
      if (j < 0 || j >= next.length) return arr;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  async function save() {
    if (!session?.token) return;
    setSaving(true);
    try {
      const r = await api.adminUpdatePromos(session.token, items);
      setItems(r.promos);
      toast.success("Carrousel enregistré");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-black/5 p-4 flex items-center justify-between gap-2">
        <div>
          <p style={{ fontSize: "0.95rem", fontWeight: 900 }}>Annonces du carrousel</p>
          <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>
            Affichées sur l'accueil public et le tableau de bord client.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={add} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-black/5" style={{ fontSize: "0.8rem", fontWeight: 700 }}>
            <Plus className="w-4 h-4" /> Ajouter
          </button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white disabled:opacity-60" style={{ background: "#FF3B57", fontSize: "0.8rem", fontWeight: 800 }}>
            <Save className="w-4 h-4" /> {saving ? "Sauvegarde..." : "Enregistrer"}
          </button>
        </div>
      </div>

      {loading && <RowSkeleton />}
      {!loading && items.length === 0 && (
        <div className="bg-white rounded-2xl border border-black/5 p-10 text-center text-[#666]">
          Aucune annonce. Cliquez sur « Ajouter » pour créer votre première bannière.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {items.map((p, i) => (
          <div key={p.id} className="bg-white rounded-2xl border border-black/5 p-4 space-y-3">
            <div className="aspect-[16/9] rounded-xl overflow-hidden bg-[#F5F6FA] flex items-center justify-center">
              {p.image ? (
                <img src={p.image} alt={p.alt} className="w-full h-full object-cover" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = "0.2"; }} />
              ) : (
                <ImageIcon className="w-8 h-8 text-[#bbb]" />
              )}
            </div>
            <div>
              <label className="block mb-1" style={{ fontSize: "0.72rem", fontWeight: 700, color: "#666" }}>URL de l'image</label>
              <input type="url" value={p.image} onChange={(e) => update(i, { image: e.target.value })} placeholder="https://..." className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57]" style={{ fontSize: "0.82rem" }} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block mb-1" style={{ fontSize: "0.72rem", fontWeight: 700, color: "#666" }}>Texte alternatif</label>
                <input type="text" value={p.alt} onChange={(e) => update(i, { alt: e.target.value })} className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57]" style={{ fontSize: "0.82rem" }} />
              </div>
              <div>
                <label className="block mb-1" style={{ fontSize: "0.72rem", fontWeight: 700, color: "#666" }}>Lien (optionnel)</label>
                <input type="text" value={p.to ?? ""} onChange={(e) => update(i, { to: e.target.value })} placeholder="/produits/sante-maladie" className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57]" style={{ fontSize: "0.82rem" }} />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <label className="inline-flex items-center gap-2" style={{ fontSize: "0.8rem", fontWeight: 700 }}>
                <input type="checkbox" checked={p.active !== false} onChange={(e) => update(i, { active: e.target.checked })} />
                Active
              </label>
              <div className="flex gap-1">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="px-2 py-1 rounded-lg bg-black/5 disabled:opacity-30" style={{ fontSize: "0.78rem" }}>↑</button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1} className="px-2 py-1 rounded-lg bg-black/5 disabled:opacity-30" style={{ fontSize: "0.78rem" }}>↓</button>
                <button onClick={() => remove(i)} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 text-red-700" style={{ fontSize: "0.78rem", fontWeight: 700 }}>
                  <Trash2 className="w-3.5 h-3.5" /> Supprimer
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// =========================================================================
// PARTNERS — éditeur du réseau santé
// =========================================================================

function PartnersTab() {
  const { session } = useAdminAuth();
  const [items, setItems] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  function reload() {
    setLoading(true);
    api.partners().then((r) => setItems(r.partners ?? [])).finally(() => setLoading(false));
  }
  useEffect(() => { reload(); }, []);

  function update(i: number, patch: Partial<Partner>) {
    setItems((arr) => arr.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));
  }
  function add() {
    setItems((arr) => [...arr, { id: `pt_${Date.now()}`, name: "", kind: "clinique", address: "", city: "", phone: "", lat: 0, lng: 0, hours: "24/7" }]);
  }
  function remove(i: number) {
    setItems((arr) => arr.filter((_, idx) => idx !== i));
  }
  async function save() {
    if (!session?.token) return;
    setSaving(true);
    try {
      const r = await api.adminUpdatePartners(session.token, items);
      setItems(r.partners);
      toast.success("Partenaires enregistrés");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-black/5 p-4 flex items-center justify-between gap-2">
        <div>
          <p style={{ fontSize: "0.95rem", fontWeight: 900 }}>Réseau partenaires santé</p>
          <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>
            Cliniques, pharmacies, hôpitaux affichés aux membres dans l'onglet Partenaires.
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={add} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-black/5" style={{ fontSize: "0.8rem", fontWeight: 700 }}>
            <Plus className="w-4 h-4" /> Ajouter
          </button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white disabled:opacity-60" style={{ background: "#FF3B57", fontSize: "0.8rem", fontWeight: 800 }}>
            <Save className="w-4 h-4" /> {saving ? "Sauvegarde..." : "Enregistrer"}
          </button>
        </div>
      </div>

      {loading && <RowSkeleton />}
      {!loading && items.length === 0 && (
        <div className="bg-white rounded-2xl border border-black/5 p-10 text-center text-[#666]">
          Aucun partenaire. Cliquez sur « Ajouter » pour créer le premier établissement.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {items.map((p, i) => (
          <div key={p.id} className="bg-white rounded-2xl border border-black/5 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p style={{ fontSize: "0.85rem", fontWeight: 800 }}>{p.name || "Nouveau partenaire"}</p>
              <button onClick={() => remove(i)} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 text-red-700" style={{ fontSize: "0.75rem", fontWeight: 700 }}>
                <Trash2 className="w-3.5 h-3.5" /> Supprimer
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <AdminInput label="Nom" value={p.name} onChange={(v) => update(i, { name: v })} />
              <div>
                <label className="block mb-1" style={{ fontSize: "0.7rem", fontWeight: 700, color: "#666" }}>Type</label>
                <select value={p.kind} onChange={(e) => update(i, { kind: e.target.value as Partner["kind"] })} className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57]" style={{ fontSize: "0.82rem" }}>
                  <option value="clinique">Clinique</option>
                  <option value="pharmacie">Pharmacie</option>
                  <option value="hopital">Hôpital</option>
                </select>
              </div>
              <AdminInput label="Adresse" value={p.address} onChange={(v) => update(i, { address: v })} />
              <AdminInput label="Ville" value={p.city} onChange={(v) => update(i, { city: v })} />
              <AdminInput label="Téléphone" value={p.phone} onChange={(v) => update(i, { phone: v })} />
              <AdminInput label="Horaires" value={p.hours} onChange={(v) => update(i, { hours: v })} />
              <AdminInput label="Latitude" value={String(p.lat)} onChange={(v) => update(i, { lat: Number(v) || 0 })} />
              <AdminInput label="Longitude" value={String(p.lng)} onChange={(v) => update(i, { lng: Number(v) || 0 })} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block mb-1" style={{ fontSize: "0.7rem", fontWeight: 700, color: "#666" }}>{label}</label>
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57]" style={{ fontSize: "0.82rem" }} />
    </div>
  );
}

// =========================================================================
// SITE — CMS du contenu public
// =========================================================================

const SITE_FIELDS: { key: keyof SiteContent; label: string; type: "text" | "textarea"; hint?: string }[] = [
  { key: "brandName", label: "Nom de la marque", type: "text" },
  { key: "tagline", label: "Slogan", type: "text", hint: "Phrase courte affichée à côté du logo." },
  { key: "heroTitle", label: "Titre principal (page d'accueil)", type: "text" },
  { key: "heroSubtitle", label: "Sous-titre (page d'accueil)", type: "textarea" },
  { key: "aboutShort", label: "Présentation courte (À propos)", type: "textarea" },
  { key: "contactEmail", label: "E-mail de contact", type: "text" },
  { key: "contactPhone", label: "Téléphone de contact", type: "text" },
  { key: "contactAddress", label: "Adresse du siège", type: "text" },
  { key: "whatsapp", label: "Numéro WhatsApp", type: "text" },
  { key: "facebook", label: "Lien Facebook", type: "text", hint: "URL complète, ex. https://facebook.com/ippoo" },
  { key: "instagram", label: "Lien Instagram", type: "text" },
  { key: "linkedin", label: "Lien LinkedIn", type: "text" },
];

function SiteTab() {
  const { session } = useAdminAuth();
  const [data, setData] = useState<SiteContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.site().then((r) => setData(r.site)).finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!session?.token || !data) return;
    setSaving(true);
    try {
      const r = await api.adminUpdateSite(session.token, data);
      setData(r.site);
      toast.success("Contenu du site enregistré");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !data) return <RowSkeleton />;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-black/5 p-4 flex items-center justify-between gap-2">
        <div>
          <p style={{ fontSize: "0.95rem", fontWeight: 900 }}>Contenu du site public</p>
          <p className="text-[#666]" style={{ fontSize: "0.78rem" }}>
            Les modifications sont immédiatement visibles sur l'accueil, la page À propos et le pied de page.
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white disabled:opacity-60"
          style={{ background: "#FF3B57", fontSize: "0.8rem", fontWeight: 800 }}
        >
          <Save className="w-4 h-4" /> {saving ? "Sauvegarde..." : "Enregistrer"}
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-black/5 p-5 space-y-4">
        {SITE_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block mb-1" style={{ fontSize: "0.78rem", fontWeight: 700 }}>{f.label}</label>
            {f.type === "textarea" ? (
              <textarea
                value={data[f.key] ?? ""}
                onChange={(e) => setData({ ...data, [f.key]: e.target.value })}
                rows={3}
                className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57] resize-y"
                style={{ fontSize: "0.85rem" }}
              />
            ) : (
              <input
                type="text"
                value={data[f.key] ?? ""}
                onChange={(e) => setData({ ...data, [f.key]: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-black/10 focus:outline-none focus:border-[#FF3B57]"
                style={{ fontSize: "0.85rem" }}
              />
            )}
            {f.hint && <p className="text-[#888] mt-1" style={{ fontSize: "0.72rem" }}>{f.hint}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
