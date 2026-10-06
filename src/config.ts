import 'dotenv/config';
import { z } from 'zod';

/** Only explicit boolean spellings are accepted; empty values fail closed. */
export function envBool(defaultValue: boolean): z.ZodType<boolean, unknown> {
  return z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return defaultValue;
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes'].includes(normalized)) return true;
      if (['false', '0', 'no'].includes(normalized)) return false;
      ctx.addIssue({ code: 'custom', message: 'Doit valoir true/1/yes ou false/0/no (pas vide)' });
      return z.NEVER;
    });
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
  // Attente maximale d'une connexion IMAP libre, en millisecondes. Au-delà,
  // l'appel échoue avec une erreur explicite au lieu de rester bloqué en file.
  IMAP_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  SMTP_HOST: z.string().min(1).default('smtp.mail.me.com'),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_POOL_SIZE: z.coerce.number().int().positive().default(2),
  MCP_BEARER_TOKEN: z.string().min(16, 'MCP_BEARER_TOKEN doit faire au moins 16 caractères'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  // Comma-separated socket IPs/CIDRs of trusted proxies. Empty = direct requests.
  TRUSTED_PROXIES: z.string().default(''),
  HTTP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1,[::1]'),
  HTTP_ALLOWED_ORIGINS: z.string().default(''),
  HTTP_MAX_CONCURRENT_REQUESTS: z.coerce.number().int().positive().default(4),
  HTTP_BODY_MAX_BYTES: z.coerce.number().int().positive().default(8_388_608),
  MAX_SESSIONS: z.coerce.number().int().positive().default(32),
  MAX_MESSAGE_BYTES: z.coerce.number().int().positive().default(26_214_400),
  IMAP_MAX_WAITERS: z.coerce.number().int().positive().default(32),
  UPLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Coupe-circuit pour compose_message (deliver "send") et send_draft.
  ENABLE_SENDING: envBool(false),

  // --- Garde-fous d'envoi (lot D) ------------------------------------------
  // Taille maximale d'une pièce jointe, en octets.
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  // Destinataires autorisés : adresses ou domaines séparés par des virgules.
  // Vide = aucun filtrage. Exposé aussi en tableau via ALLOWED_RECIPIENTS_LIST.
  ALLOWED_RECIPIENTS: z.string().default(''),
  // Nombre maximal d'envois par jour glissant. 0 = illimité.
  MAX_SENDS_PER_DAY: z.coerce.number().int().nonnegative().default(0),
  // Fichier où persister le quota d'envoi entre deux redémarrages.
  // Vide = compteur en mémoire seule, remis à zéro au redémarrage.
  QUOTA_STATE_PATH: z.string().trim().default(''),
  // Force tous les envois à passer par un brouillon (aucun mail n'est émis).
  DRAFTS_ONLY: envBool(false),
  // Lève tous les garde-fous d'envoi. À n'utiliser qu'en connaissance de cause.
  UNRESTRICTED: envBool(false),

  // --- Jetons de confirmation (lot 2) -------------------------------------
  // Secret HMAC des jetons de confirmation des opérations destructives.
  // Optionnel : absent ou vide, un secret aléatoire est tiré au démarrage
  // (les jetons ne survivent pas à un redémarrage, sans gravité vu leur TTL).
  CONFIRM_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'CONFIRM_SECRET doit faire au moins 32 caractères').optional(),
  ),

  // --- Liens de téléchargement (get_attachment format "url") ---------------
  // Secret HMAC des liens signés servis par GET /download/:token. Optionnel :
  // absent ou vide, un secret aléatoire est tiré au démarrage (les liens, valables
  // 15 min, ne survivent pas à un redémarrage). Même logique que CONFIRM_SECRET.
  DOWNLOAD_URL_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().min(32, 'DOWNLOAD_URL_SECRET doit faire au moins 32 caractères').optional(),
  ),

  // --- Dépôts de fichiers (create_upload_link, POST /upload/:token) --------
  // Plafonds du stockage EN MÉMOIRE des fichiers déposés, pour qu'un client ne
  // sature pas la RAM : nombre de dépôts conservés à la fois, et octets cumulés.
  // Chaque fichier reste en outre borné par ATTACHMENT_MAX_BYTES.
  UPLOAD_MAX_FILES: z.coerce.number().int().positive().default(20),
  UPLOAD_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(52_428_800),

  // --- Protocole MCP / sessions (lots C, E) -------------------------------
  // Plafond d'appels par minute et par session.
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // Durée de vie d'une session inactive, en millisecondes.
  SESSION_TTL_MS: z.coerce.number().int().positive().default(1_800_000),
  // Transport exposé par le serveur MCP.
  MCP_TRANSPORT: z
    .enum(['http', 'stdio', 'both'], {
      message: 'MCP_TRANSPORT doit valoir "http", "stdio" ou "both"',
    })
    .default('http'),
  // Longueur maximale d'un corps de message (texte ou HTML) accepté par les outils.
  MAX_BODY_CHARS: z.coerce.number().int().positive().default(20_000),
  // Active l'outil wait_for_new_message (attente IDLE sur connexion hors pool).
  // OFF par défaut : pas de reconnexion, l'attente se dégrade silencieusement
  // si la connexion iCloud saute. Voir docs/configuration.md.
  ENABLE_IDLE_WATCH: envBool(false),

  // --- Compatibilité --------------------------------------------------------
  // Réenregistre les anciens outils (list_messages, get_message, send_message…)
  // en plus des nouveaux, avec leurs noms et contrats d'origine et la mention
  // « Deprecated » en tête de description. Prévu pour une version de
  // transition seulement. Voir docs/tools.md.
  LEGACY_TOOLS: envBool(false),

  // URL publique HTTPS du serveur (ex. https://mail-mcp.exemple.com), sans
  // slash final. Optionnelle : renseigne `icons`/`websiteUrl` dans les
  // métadonnées `Implementation` du protocole MCP (favicon affiché par les
  // clients qui les lisent) et sert de base aux liens de téléchargement
  // (get_attachment format "url"). Absente = ces champs ne sont pas envoyés
  // et le format "url" est refusé.
  PUBLIC_BASE_URL: z
    .string()
    .default('')
    .refine((v) => {
      if (v === '') return true;
      try {
        const url = new URL(v);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          url.pathname === '/' &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, 'PUBLIC_BASE_URL doit être vide ou une origine https:// sans identifiants')
    .transform((v) => v.replace(/\/+$/, '')),
});

/** Valide un environnement arbitraire. Exporté pour les tests ; l'app utilise `config`. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
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
