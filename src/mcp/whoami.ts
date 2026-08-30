import { config } from '../config.js';
import { getQuotaStatus } from '../smtp/quota.js';
import { account } from '../account.js';
import { serverVersion } from '../version.js';
import { imapPool } from '../imap/pool.js';
import { listFolders } from '../imap/folders.js';
import { classifyImapError } from '../imap/errors.js';

/**
 * Logique pure de l'outil `whoami`. Aucun secret ne doit sortir d'ici : le mot
 * de passe d'application et le bearer token ne sont exposés que sous forme d'un
 * booléen « configuré ». Un test verrouille cette règle sur la sortie sérialisée.
 */

export interface WhoamiGuardrails {
  /** Coupe-circuit d'envoi (`ENABLE_SENDING`). Toujours présent. */
  sendingEnabled: boolean;
  /** Garde-fous posés par le lot D — affichés seulement s'ils existent. */
  draftsOnly?: boolean;
  unrestricted?: boolean;
  allowlistActive?: boolean;
  maxSendsPerDay?: number;
  quota?: WhoamiQuota;
}

export interface WhoamiQuota {
  windowHours: number;
  limit: number;
  /** `true` quand `MAX_SENDS_PER_DAY = 0` : aucun plafond. */
  unlimited: boolean;
  used: number;
  /** `null` quand le quota est illimité. */
  remaining: number | null;
  /** Instant où le plus ancien envoi sort de la fenêtre. */
  resetsAt?: string;
}

export interface WhoamiReport {
  server: { name: string; version: string };
  account: {
    email: string;
    imap: { host: string; port: number };
    smtp: { host: string; port: number };
  };
  credentials: { appPasswordConfigured: boolean; bearerTokenConfigured: boolean };
  guardrails: WhoamiGuardrails;
  imapPool: { open: number; inUse: number; max: number };
  probe?: { attempted: true; ok: boolean; folderCount?: number; error?: string };
}

export interface WhoamiDeps {
  /** Photo du pool IMAP. Défaut : `imapPool.stats()`. */
  poolStats?: () => { open: number; inUse: number; max: number };
  /** Vérification de connexion réelle et légère. Défaut : `listFolders()`. */
  probe?: () => Promise<{ folderCount: number }>;
  /** Quota d'envoi restant, si le lot D l'expose. Défaut : indisponible. */
  quota?: () => WhoamiQuota | undefined;
}

const defaultProbe = async (): Promise<{ folderCount: number }> => {
  const folders = await listFolders();
  return { folderCount: folders.length };
};

/**
 * Ceinture et bretelles : même si une erreur de sonde ne contient en pratique
 * jamais d'identifiant, on retire toute occurrence littérale des secrets connus
 * avant de la mettre dans la sortie.
 */
function redactSecrets(text: string): string {
  let out = text;
  for (const secret of [account.password, config.MCP_BEARER_TOKEN]) {
    if (secret.length >= 4) {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out;
}

/** Quota d'envoi tel que le lot D le comptabilise, sans effet de bord. */
function defaultQuota(): WhoamiQuota {
  const status = getQuotaStatus();
  return {
    windowHours: 24,
    limit: status.limit,
    unlimited: status.unlimited,
    used: status.used,
    remaining: status.remaining,
    resetsAt: status.resetsAt?.toISOString(),
  };
}

export async function buildWhoami(probeRequested: boolean, deps: WhoamiDeps = {}): Promise<WhoamiReport> {
  const poolStats = deps.poolStats ?? (() => imapPool.stats());
  const probe = deps.probe ?? defaultProbe;

  const guardrails: WhoamiGuardrails = { sendingEnabled: config.ENABLE_SENDING };

  guardrails.draftsOnly = config.DRAFTS_ONLY;
  guardrails.unrestricted = config.UNRESTRICTED;
  guardrails.allowlistActive = config.ALLOWED_RECIPIENTS_LIST.length > 0;
  guardrails.maxSendsPerDay = config.MAX_SENDS_PER_DAY;

  // Lecture seule : afficher le quota ne doit jamais consommer un crédit d'envoi.
  const quota = (deps.quota ?? defaultQuota)();
  if (quota !== undefined) guardrails.quota = quota;

  const report: WhoamiReport = {
    server: { name: 'icloud-mail', version: serverVersion },
    account: {
      email: account.email,
      imap: { host: account.imap.host, port: account.imap.port },
      smtp: { host: account.smtp.host, port: account.smtp.port },
    },
    credentials: {
      appPasswordConfigured: account.password.length > 0,
      bearerTokenConfigured: config.MCP_BEARER_TOKEN.length > 0,
    },
    guardrails,
    imapPool: poolStats(),
  };

  if (probeRequested) {
    try {
      const { folderCount } = await probe();
      report.probe = { attempted: true, ok: true, folderCount };
    } catch (err) {
      report.probe = { attempted: true, ok: false, error: redactSecrets(classifyImapError(err).message) };
    }
  }

  return report;
}
