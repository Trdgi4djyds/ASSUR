// Libellés humains affichés à la place des codes techniques.
// Centralisé pour rester cohérent sur l'app cliente ET le back office.

const STATUS: Record<string, string> = {
  // Sinistres
  en_cours: "En cours",
  valide: "Validé",
  regle: "Réglé",
  rejete: "Rejeté",
  // Paiements
  confirme: "Confirmé",
  en_attente: "En attente",
  echec: "Échec",
  // Contrats
  active: "Actif",
  expired: "Expiré",
  pending: "En attente",
  suspended: "Suspendu",
};

const METHOD: Record<string, string> = {
  mobile_money: "Mobile Money",
  momo: "MTN Mobile Money",
  moov: "Moov Money",
  kkiapay: "KKiaPay",
  card: "Carte bancaire",
  cash: "Espèces",
  bank: "Virement bancaire",
  virement: "Virement bancaire",
};

const PARTNER_KIND: Record<string, string> = {
  clinique: "Clinique",
  pharmacie: "Pharmacie",
  hopital: "Hôpital",
};

const FREQUENCY: Record<string, string> = {
  mensuel: "Mensuelle",
  mensuelle: "Mensuelle",
  trimestriel: "Trimestrielle",
  trimestrielle: "Trimestrielle",
  annuel: "Annuelle",
  annuelle: "Annuelle",
};

const RELATION: Record<string, string> = {
  conjoint: "Conjoint(e)",
  pere: "Père",
  mere: "Mère",
  enfant: "Enfant",
  frere: "Frère",
  soeur: "Sœur",
  autre: "Autre",
};

const AUDIT_ACTION: Record<string, string> = {
  "signup": "Inscription",
  "login": "Connexion",
  "password.change": "Changement de mot de passe",
  "contract.subscribe": "Souscription de contrat",
  "contract.renew": "Renouvellement de contrat",
  "claim.create": "Déclaration de sinistre",
  "claim.attachment": "Pièce jointe sinistre",
  "payment.create": "Paiement créé",
  "payment.confirm": "Paiement confirmé",
  "payment.initiate": "Paiement initié",
  "member-card.activate": "Activation carte membre",
  "beneficiary.create": "Ajout d'un bénéficiaire",
  "beneficiary.delete": "Suppression d'un bénéficiaire",
  "profile.update": "Mise à jour du profil",
  "settings.update": "Mise à jour des préférences",
  "message.send": "Message envoyé",
  "admin.broadcast": "Diffusion d'une annonce",
  "admin.member.suspend": "Suspension / réactivation d'un membre",
  "admin.claim.status": "Décision sur un sinistre",
  "admin.promos.update": "Mise à jour du carrousel",
  "admin.partners.update": "Mise à jour des partenaires",
  "admin.site.update": "Mise à jour du contenu du site",
  "account.delete.request": "Demande de suppression de compte",
};

const META_LABEL: Record<string, string> = {
  amount: "Montant",
  status: "Statut",
  method: "Méthode",
  product: "Produit",
  contractId: "Contrat",
  claimId: "Sinistre",
  paymentId: "Paiement",
  beneficiaryId: "Bénéficiaire",
  title: "Titre",
  count: "Nombre",
  recipients: "Destinataires",
  type: "Type",
  memberNumber: "N° de membre",
  note: "Note",
  by: "Par",
  reason: "Motif",
};

function humanize(value: string): string {
  return value
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function statusLabel(code?: string | null) {
  if (!code) return "—";
  return STATUS[code] ?? humanize(code);
}

export function methodLabel(code?: string | null) {
  if (!code) return "—";
  return METHOD[code] ?? humanize(code);
}

export function partnerKindLabel(code?: string | null) {
  if (!code) return "—";
  return PARTNER_KIND[code] ?? humanize(code);
}

export function frequencyLabel(code?: string | null) {
  if (!code) return "—";
  return FREQUENCY[code.toLowerCase()] ?? humanize(code);
}

export function relationLabel(code?: string | null) {
  if (!code) return "—";
  return RELATION[code.toLowerCase()] ?? humanize(code);
}

export function auditActionLabel(code?: string | null) {
  if (!code) return "—";
  return AUDIT_ACTION[code] ?? humanize(code);
}

export function metaKeyLabel(key: string) {
  return META_LABEL[key] ?? humanize(key);
}

export function formatMeta(meta: Record<string, unknown> | null | undefined): string {
  if (!meta || typeof meta !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || v === "") continue;
    let display: string;
    if (k === "amount" && typeof v === "number") {
      display = new Intl.NumberFormat("fr-FR").format(v) + " FCFA";
    } else if (k === "status") {
      display = statusLabel(String(v));
    } else if (k === "method") {
      display = methodLabel(String(v));
    } else if (typeof v === "object") {
      display = JSON.stringify(v);
    } else {
      display = String(v);
    }
    parts.push(`${metaKeyLabel(k)} : ${display}`);
  }
  return parts.join(" · ");
}
