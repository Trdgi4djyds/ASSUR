import { z } from "npm:zod@3.23.8";

export const SignupSchema = z.object({
  email: z.string().email("Email invalide"),
  password: z.string().min(8, "Mot de passe trop court (8 caractères min.)"),
  name: z.string().min(2, "Nom requis").max(120),
  phone: z.string().max(40).optional(),
  referralCode: z.string().max(40).optional(),
  profile: z
    .object({ type: z.string().max(40).optional() })
    .passthrough()
    .optional(),
});

const nullableStr = (max: number) => z.string().max(max).nullable().optional();
export const ProfileUpdateSchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    phone: z.string().max(40).optional(),
    email: z.string().email().optional(),
    firstName: nullableStr(80),
    lastName: nullableStr(80),
    gender: nullableStr(20),
    birthDate: nullableStr(40),
    birthPlace: nullableStr(120),
    profession: nullableStr(120),
    companyName: nullableStr(160),
    ifu: nullableStr(40),
    idType: nullableStr(40),
    idNumber: nullableStr(60),
    country: nullableStr(60),
    countryDial: nullableStr(8),
    department: nullableStr(80),
    city: nullableStr(80),
    quartier: nullableStr(120),
  })
  .strict();

export const ClaimCreateSchema = z.object({
  contractId: z.string().max(80).optional(),
  type: z.string().min(2).max(80),
  description: z.string().min(5).max(4000),
  amount: z.number().nonnegative().max(50_000_000).optional(),
});

export const PaymentLegacySchema = z.object({
  contractId: z.string().max(80).optional(),
  amount: z.number().positive().max(5_000_000),
  method: z.string().max(40).optional(),
});

export const PaymentInitiateSchema = z.object({
  contractId: z.string().max(80).optional(),
  amount: z.number().positive().max(5_000_000),
  phone: z.string().max(40).optional(),
  purpose: z.enum(["cotisation", "renewal", "card_activation", "monthly_premium"]).optional(),
  paymentId: z.string().max(80).optional(),
});

export const BeneficiaryCreateSchema = z.object({
  name: z.string().min(2).max(120),
  relation: z.string().min(2).max(40),
  birthDate: z.string().max(40).optional(),
});

export const MessageCreateSchema = z.object({
  content: z.string().min(1, "Message vide").max(4000),
  replyToId: z.string().max(80).optional(),
});

export const MessageEditSchema = z.object({
  content: z.string().min(1, "Message vide").max(4000),
});

export const SubscribeSchema = z.object({
  product: z.string().min(2).max(120),
  premium: z.number().positive().max(5_000_000).optional(),
  frequency: z.string().max(20).optional(),
});

export const SettingsUpdateSchema = z
  .object({
    lang: z.enum(["fr", "en", "fon"]).optional(),
    notifySms: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
  })
  .strict();

export const ChangePasswordSchema = z.object({
  newPassword: z.string().min(8, "Mot de passe trop court (8 caractères min.)"),
});

export const RenewContractSchema = z.object({
  method: z.string().max(40).optional(),
});

// Helper: parses a JSON body against a schema and returns either the parsed
// value or a tuple [errorMessage, 400] that the route can return directly.
export async function parseBody<S extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; status: 400; message: string }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, status: 400, message: "JSON invalide" };
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    const path = first.path.length ? first.path.join(".") : "body";
    return { ok: false, status: 400, message: `${path}: ${first.message}` };
  }
  return { ok: true, data: r.data };
}
