import 'dotenv/config';
import { z } from 'zod';

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
  // Coupe-circuit pour send_message / reply_message. Volontairement pas un simple
  // z.coerce.boolean() : dans zod, "false" est une chaîne non-vide donc coercée à `true`.
  ENABLE_SENDING: z
    .string()
    .optional()
    .default('true')
    .transform((v) => !['false', '0', 'no'].includes(v.trim().toLowerCase())),
});

/** Valide un environnement arbitraire. Exporté pour les tests ; l'app utilise `config`. */
export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Configuration invalide (voir .env / .env.example) :\n${issues}`);
  }
  return parsed.data;
}

export const config = parseConfig(process.env);
export type Config = typeof config;
