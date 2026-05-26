-- ============================================================
-- IPPOO Assurance – Migration vers un schéma relationnel
-- Remplace la table unique kv_store_752d1a39
-- ============================================================

-- Activer l'extension UUID si ce n'est pas déjà fait
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. PROFILES (données utilisateur)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  phone           TEXT DEFAULT '',
  member_number   TEXT UNIQUE,
  card_active     BOOLEAN DEFAULT FALSE,
  card_issued_at  TIMESTAMPTZ,
  type            TEXT DEFAULT 'particulier',
  first_name      TEXT,
  last_name       TEXT,
  gender          TEXT,
  birth_date      DATE,
  birth_place     TEXT,
  profession      TEXT,
  company_name    TEXT,
  ifu             TEXT,
  id_type         TEXT,
  id_number       TEXT,
  country         TEXT DEFAULT 'BJ',
  country_dial    TEXT DEFAULT '229',
  department      TEXT,
  city            TEXT,
  quartier        TEXT,
  suspended       BOOLEAN DEFAULT FALSE,
  referral_code   TEXT UNIQUE,
  referred_by     UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. SETTINGS (préférences utilisateur)
-- ============================================================
CREATE TABLE IF NOT EXISTS settings (
  user_id         UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  lang            TEXT DEFAULT 'fr',
  notify_sms      BOOLEAN DEFAULT TRUE,
  notify_email    BOOLEAN DEFAULT TRUE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. CONTRACTS (contrats d'assurance)
-- ============================================================
CREATE TABLE IF NOT EXISTS contracts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  product          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active', 'expired', 'pending')),
  start_date       TIMESTAMPTZ DEFAULT NOW(),
  end_date         TIMESTAMPTZ,
  premium          NUMERIC(12,2) DEFAULT 0,
  currency         TEXT DEFAULT 'XOF',
  frequency        TEXT DEFAULT 'mensuel',
  auto_debit       BOOLEAN DEFAULT FALSE,
  next_billing_date TIMESTAMPTZ,
  last_paid_at     TIMESTAMPTZ,
  renewal_notice_sent BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. CLAIMS (sinistres déclarés)
-- ============================================================
CREATE TABLE IF NOT EXISTS claims (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES contracts(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount      NUMERIC(12,2) DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'en_cours' CHECK (status IN ('en_cours', 'valide', 'rejete', 'regle')),
  admin_note  TEXT,
  decided_at  TIMESTAMPTZ,
  decided_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 5. CLAIM_ATTACHMENTS (pièces jointes sinistres)
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id    UUID NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  name        TEXT NOT NULL,
  size        BIGINT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. PAYMENTS (historique des paiements)
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  contract_id  UUID REFERENCES contracts(id) ON DELETE SET NULL,
  amount       NUMERIC(12,2) NOT NULL,
  currency     TEXT DEFAULT 'XOF',
  method       TEXT DEFAULT 'mobile_money',
  status       TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('confirme', 'en_attente', 'echec')),
  purpose      TEXT DEFAULT 'cotisation' CHECK (purpose IN ('cotisation', 'renewal', 'card_activation', 'monthly_premium')),
  phone        TEXT,
  label        TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 7. BENEFICIARIES (bénéficiaires)
-- ============================================================
CREATE TABLE IF NOT EXISTS beneficiaries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  relation    TEXT NOT NULL DEFAULT '',
  birth_date  DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 8. DOCUMENTS (documents utilisateur)
-- ============================================================
CREATE TABLE IF NOT EXISTS documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT '',
  category    TEXT NOT NULL DEFAULT '',
  size        BIGINT DEFAULT 0,
  path        TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 9. NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'info' CHECK (type IN ('info', 'success', 'warn')),
  read        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 10. MESSAGES (messagerie utilisateur ↔ conseiller)
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_role    TEXT NOT NULL DEFAULT 'user' CHECK (from_role IN ('user', 'conseiller')),
  author       TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL DEFAULT '',
  read         BOOLEAN DEFAULT FALSE,
  reply_to_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  edited_at    TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 11. MESSAGE_ATTACHMENTS (pièces jointes messagerie)
-- ============================================================
CREATE TABLE IF NOT EXISTS message_attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL DEFAULT '',
  size        BIGINT DEFAULT 0,
  path        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 12. AUDIT_LOG (journal des actions)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  meta        JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 13. SYSTEM_CONFIG (données système globales : promos, partners, site)
-- ============================================================
CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 14. WEBAUTHN_CREDENTIALS (clés WebAuthn)
-- ============================================================
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id            TEXT PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  public_key    BYTEA NOT NULL,
  counter       BIGINT DEFAULT 0,
  device_type   TEXT,
  backed_up     BOOLEAN DEFAULT FALSE,
  transports    TEXT[],
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 15. PUSH_SUBSCRIPTIONS (abonnements Web Push)
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 16. CONVERSATION_META (métadonnées conversations admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_meta (
  user_id     UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'ouvert' CHECK (status IN ('ouvert', 'en_cours', 'resolu')),
  assignee    TEXT,
  tags        TEXT[] DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 17. HMAC_SECRETS (secrets HMAC système)
-- ============================================================
CREATE TABLE IF NOT EXISTS hmac_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TRIGGERS : mise à jour automatique de updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_profiles_updated
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_contracts_updated
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_claims_updated
  BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_payments_updated
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Activer RLS sur toutes les tables utilisateur
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE hmac_secrets ENABLE ROW LEVEL SECURITY;

-- -------- profiles --------
CREATE POLICY "Users can read own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);
-- L'insertion des profils se fait par la fonction Edge (service_role), pas directement par le client.

-- -------- settings --------
CREATE POLICY "Users can read own settings" ON settings
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can upsert own settings" ON settings
  FOR ALL USING (auth.uid() = user_id);

-- -------- contracts --------
CREATE POLICY "Users can read own contracts" ON contracts
  FOR SELECT USING (auth.uid() = user_id);

-- -------- claims --------
CREATE POLICY "Users can read own claims" ON claims
  FOR SELECT USING (auth.uid() = user_id);

-- -------- claim_attachments --------
CREATE POLICY "Users can read own claim attachments" ON claim_attachments
  FOR SELECT USING (auth.uid() = user_id);

-- -------- payments --------
CREATE POLICY "Users can read own payments" ON payments
  FOR SELECT USING (auth.uid() = user_id);

-- -------- beneficiaries --------
CREATE POLICY "Users can read own beneficiaries" ON beneficiaries
  FOR SELECT USING (auth.uid() = user_id);

-- -------- documents --------
CREATE POLICY "Users can read own documents" ON documents
  FOR SELECT USING (auth.uid() = user_id);

-- -------- notifications --------
CREATE POLICY "Users can read own notifications" ON notifications
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON notifications
  FOR UPDATE USING (auth.uid() = user_id);

-- -------- messages --------
CREATE POLICY "Users can read own messages" ON messages
  FOR SELECT USING (auth.uid() = user_id);

-- -------- message_attachments --------
CREATE POLICY "Users can read own message attachments" ON message_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      WHERE m.id = message_attachments.message_id
        AND m.user_id = auth.uid()
    )
  );

-- -------- webauthn_credentials --------
CREATE POLICY "Users can read own webauthn credentials" ON webauthn_credentials
  FOR SELECT USING (auth.uid() = user_id);

-- -------- push_subscriptions --------
CREATE POLICY "Users can manage own push subscriptions" ON push_subscriptions
  FOR ALL USING (auth.uid() = user_id);

-- -------- conversation_meta --------
CREATE POLICY "Users can read own conversation meta" ON conversation_meta
  FOR SELECT USING (auth.uid() = user_id);

-- -------- audit_log (lecture seule par l'utilisateur) --------
CREATE POLICY "Users can read own audit log" ON audit_log
  FOR SELECT USING (auth.uid() = user_id);

-- -------- system_config (lecture publique) --------
CREATE POLICY "Anyone can read system_config" ON system_config
  FOR SELECT USING (TRUE);

-- ============================================================
-- INDEX pour les performances
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_contracts_user_id ON contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_claims_user_id ON claims(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_user_id ON beneficiaries(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_member_number ON profiles(member_number);
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON profiles(referral_code);
