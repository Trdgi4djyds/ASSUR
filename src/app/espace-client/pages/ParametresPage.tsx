import { useState, useEffect, type FormEvent } from "react";
import { Bell, Lock, Globe, Check, BellRing, BellOff } from "lucide-react";
import { useAuth } from "../AuthContext";
import { useApiData } from "../hooks";
import { api } from "../api";
import { toast } from "sonner";
import { useI18n, type Lang } from "../i18n";
import { pushStatus, isSubscribed, subscribeToPush, unsubscribeFromPush } from "../push";

export function ParametresPage() {
  const { session } = useAuth();
  const q = useApiData((tk) => api.settings(tk));
  const { lang: uiLang, setLang: setUiLang, t } = useI18n();
  const [lang, setLang] = useState("fr");
  const [notifySms, setNotifySms] = useState(true);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [pwdMsg, setPwdMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [pwdBusy, setPwdBusy] = useState(false);

  useEffect(() => {
    if (q.data?.settings) {
      setLang(q.data.settings.lang);
      setNotifySms(q.data.settings.notifySms);
      setNotifyEmail(q.data.settings.notifyEmail);
      if (["fr", "en", "fon"].includes(q.data.settings.lang) && q.data.settings.lang !== uiLang) {
        setUiLang(q.data.settings.lang as Lang);
      }
    }
  }, [q.data, uiLang, setUiLang]);

  async function saveSettings(updates: Partial<{ lang: string; notifySms: boolean; notifyEmail: boolean }>) {
    if (!session?.access_token) return;
    try {
      await api.updateSettings(session.access_token, updates);
      setSavedAt(Date.now());
      toast.success("Préférences enregistrées");
    } catch (err) {
      console.error("Save settings failed:", err);
      toast.error("Sauvegarde impossible");
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (!session?.access_token) return;
    setPwdMsg(null);
    if (pwd.length < 8) { setPwdMsg({ type: "err", text: "8 caractères minimum." }); return; }
    if (pwd !== pwd2) { setPwdMsg({ type: "err", text: "Les mots de passe ne correspondent pas." }); return; }
    setPwdBusy(true);
    try {
      await api.changePassword(session.access_token, pwd);
      setPwd(""); setPwd2("");
      setPwdMsg({ type: "ok", text: "Mot de passe mis à jour." });
      toast.success("Mot de passe mis à jour");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur";
      setPwdMsg({ type: "err", text: msg });
      toast.error("Échec du changement", { description: msg });
    } finally {
      setPwdBusy(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <header>
        <h1 className="t-title1">{t("settings.title")}</h1>
        <p className="mt-1 text-[#666]" style={{ fontSize: "0.9rem" }}>{t("settings.subtitle")}</p>
      </header>

      <section className="bg-white rounded-2xl border border-black/5 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-[#DDE7FF] flex items-center justify-center"><Bell className="w-5 h-5 text-[#2A6BFF]" /></div>
          <div>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 800 }}>{t("settings.notifications")}</h2>
            <p className="text-[#666]" style={{ fontSize: "0.8rem" }}>{t("settings.notifications.desc")}</p>
          </div>
        </div>
        <Toggle label={t("settings.sms")} checked={notifySms} onChange={(v) => { setNotifySms(v); saveSettings({ notifySms: v }); }} />
        <Toggle label={t("settings.email")} checked={notifyEmail} onChange={(v) => { setNotifyEmail(v); saveSettings({ notifyEmail: v }); }} />
        <PushToggle />
      </section>

      <section className="bg-white rounded-2xl border border-black/5 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-[#EFE3FF] flex items-center justify-center"><Globe className="w-5 h-5 text-[#8A4BFF]" /></div>
          <div>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 800 }}>{t("settings.lang")}</h2>
            <p className="text-[#666]" style={{ fontSize: "0.8rem" }}>{t("settings.lang.desc")}</p>
          </div>
        </div>
        <select
          value={lang}
          onChange={(e) => {
            const v = e.target.value;
            setLang(v);
            saveSettings({ lang: v });
            if (v === "fr" || v === "en" || v === "fon") setUiLang(v);
          }}
          className="w-full px-4 py-3 rounded-xl border-2 border-black/10 focus:outline-none focus:border-[#FF3B57] bg-white"
        >
          <option value="fr">Français</option>
          <option value="en">English</option>
          <option value="fon">Fon</option>
        </select>
        {savedAt && (
          <p className="mt-3 text-[#0F7A47] flex items-center gap-1" style={{ fontSize: "0.8rem", fontWeight: 700 }}>
            <Check className="w-4 h-4" /> {t("settings.saved")}
          </p>
        )}
      </section>

      <section className="bg-white rounded-2xl border border-black/5 shadow-sm p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-[#FFDDE2] flex items-center justify-center"><Lock className="w-5 h-5 text-[#C0263A]" /></div>
          <div>
            <h2 style={{ fontSize: "1.05rem", fontWeight: 800 }}>{t("settings.security")}</h2>
            <p className="text-[#666]" style={{ fontSize: "0.8rem" }}>{t("settings.security.desc")}</p>
          </div>
        </div>
        <form onSubmit={changePassword} className="space-y-3">
          <input type="password" placeholder="Nouveau mot de passe" value={pwd} onChange={(e) => setPwd(e.target.value)} className="w-full px-4 py-3 rounded-xl border-2 border-black/10 focus:outline-none focus:border-[#FF3B57]" />
          <input type="password" placeholder="Confirmer le mot de passe" value={pwd2} onChange={(e) => setPwd2(e.target.value)} className="w-full px-4 py-3 rounded-xl border-2 border-black/10 focus:outline-none focus:border-[#FF3B57]" />
          {pwdMsg && (
            <div className={`px-4 py-3 rounded-xl ${pwdMsg.type === "ok" ? "bg-[#DBFBE7] text-[#0F7A47]" : "bg-red-50 text-red-700 border border-red-200"}`} style={{ fontSize: "0.85rem" }}>
              {pwdMsg.text}
            </div>
          )}
          <button type="submit" disabled={pwdBusy} className="w-full px-6 py-3 rounded-xl text-white disabled:opacity-60" style={{ background: "#FF3B57", fontWeight: 800 }}>
            {pwdBusy ? "Mise à jour..." : "Changer le mot de passe"}
          </button>
        </form>
      </section>

    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between py-3 cursor-pointer">
      <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="relative w-11 h-6 rounded-full transition-colors"
        style={{ background: checked ? "#16B26A" : "#D1D5DB" }}
        aria-pressed={checked}
      >
        <span
          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
          style={{ left: checked ? "1.4rem" : "0.125rem" }}
        />
      </button>
    </label>
  );
}

function PushToggle() {
  const { session } = useAuth();
  const [state, setState] = useState<"loading" | "off" | "on" | "denied" | "unsupported">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await pushStatus();
      if (s === "unsupported") return setState("unsupported");
      if (s === "denied") return setState("denied");
      setState((await isSubscribed()) ? "on" : "off");
    })();
  }, []);

  async function toggle() {
    if (!session?.access_token || busy) return;
    setBusy(true);
    try {
      if (state === "on") {
        await unsubscribeFromPush(session.access_token);
        setState("off");
        toast.success("Notifications push désactivées");
      } else {
        await subscribeToPush(session.access_token);
        setState("on");
        toast.success("Notifications push activées");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return null;
  if (state === "unsupported") {
    return (
      <div className="flex items-center gap-3 py-3 t-subhead t-muted">
        <BellOff className="w-[18px] h-[18px]" /> Push non supporté sur cet appareil
      </div>
    );
  }
  if (state === "denied") {
    return (
      <div className="flex items-center gap-3 py-3 t-subhead t-muted">
        <BellOff className="w-[18px] h-[18px]" /> Permission refusée — modifiez dans les réglages du navigateur
      </div>
    );
  }
  return (
    <label className="flex items-center justify-between py-3 cursor-pointer">
      <span className="flex items-center gap-2 t-body" style={{ color: "var(--ippoo-text)" }}>
        <BellRing className="w-[18px] h-[18px]" style={{ color: "var(--accent-primary)" }} />
        Notifications push
      </span>
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={state === "on"}
        className="relative transition-colors disabled:opacity-60"
        style={{
          width: "48px", height: "28px", borderRadius: "9999px",
          background: state === "on" ? "var(--accent-primary)" : "var(--surface-sunken)",
        }}
      >
        <span
          className="absolute top-[3px] transition-all"
          style={{
            left: state === "on" ? "23px" : "3px",
            width: "22px", height: "22px", borderRadius: "9999px",
            background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }}
        />
      </button>
    </label>
  );
}
