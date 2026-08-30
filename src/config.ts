import 'dotenv/config';
import { z } from 'zod';

/**
 * Booléen tolérant lu depuis l'environnement. Volontairement pas un
 * `z.coerce.boolean()` : dans zod, la chaîne `"false"` est une chaîne non vide,
 * donc coercée à `true` — un coupe-circuit `FLAG=false` serait silencieusement
 * inopérant. Ici `"false"`, `"0"` et `"no"` (insensibles à la casse, espaces
 * ignorés) valent faux ; toute autre valeur vaut vrai ; l'absence de variable
 * retombe sur `defaultValue`.
 */
export function envBool(defaultValue: boolean): z.ZodType<boolean, unknown> {
  return z
    .string()
    .optional()
    .transform((v) => (v === undefined ? defaultValue : !['false', '0', 'no'].includes(v.trim().toLowerCase())));
}

/** Découpe une liste séparée par des virgules en entrées normalisées (trim, minuscules, vides retirées). */
export function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

const envSchema = z.object({
  ICLOUD_EMAIL: z.string().email('ICLOUD_EMAIL doit être une adresse email valide'),
  ICLOUD_APP_PASSWORD: z.string().min(1, 'ICLOUD_APP_PASSWORD est requis'),
  IMAP_HOST: z.string().min(1).default('imap.mail.me.com'),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_POOL_SIZE: z.coerce.number().int().positive().default(2),
  SMTP_HOST: z.string().min(1).default('smtp.mail.me.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_POOL_SIZE: z.coerce.number().int().positive().default(2),
  MCP_BEARER_TOKEN: z.string().min(16, 'MCP_BEARER_TOKEN doit faire au moins 16 caractères'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Coupe-circuit pour send_message / reply_message.
  ENABLE_SENDING: envBool(true),

  // --- Garde-fous d'envoi (lot D) ------------------------------------------
  // Taille maximale d'une pièce jointe, en octets.
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  // Destinataires autorisés : adresses ou domaines séparés par des virgules.
  // Vide = aucun filtrage. Exposé aussi en tableau via ALLOWED_RECIPIENTS_LIST.
  ALLOWED_RECIPIENTS: z.string().default(''),
  // Nombre maximal d'envois par jour glissant. 0 = illimité.
  MAX_SENDS_PER_DAY: z.coerce.number().int().nonnegative().default(0),
  // Force tous les envois à passer par un brouillon (aucun mail n'est émis).
  DRAFTS_ONLY: envBool(false),
  // Lève tous les garde-fous d'envoi. À n'utiliser qu'en connaissance de cause.
  UNRESTRICTED: envBool(false),

  // --- Protocole MCP / sessions (lots C, E) -------------------------------
  // Plafond d'appels par minute et par session.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // Durée de vie d'une session inactive, en millisecondes.
  SESSION_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  // Transport exposé par le serveur MCP.
  MCP_TRANSPORT: z
    .enum(['http', 'stdio', 'both'], { message: 'MCP_TRANSPORT doit valoir "http", "stdio" ou "both"' })
    .default('http'),
  // Longueur maximale d'un corps de message (texte ou HTML) accepté par les outils.
  MAX_BODY_CHARS: z.coerce.number().int().positive().default(20_000),
});

/** Valide un environnement arbitraire. Exporté pour les tests ; l'app utilise `config`. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Configuration invalide (voir .env / .env.example) :\n${issues}`);
  }
  return {
    ...parsed.data,
    /** `ALLOWED_RECIPIENTS` normalisé en tableau (vide = aucun filtrage). */
    ALLOWED_RECIPIENTS_LIST: parseList(parsed.data.ALLOWED_RECIPIENTS),
  };
}

export const config = parseConfig(process.env);
export type Config = typeof config;
