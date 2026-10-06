import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';

/**
 * Téléchargement HTTPS protégé contre la SSRF, pour les pièces jointes fournies
 * par URL. Le serveur tourne à côté d'autres services (réseau Docker, LAN) : une
 * URL choisie par le modèle — ou dictée par un email piégé — ne doit jamais lui
 * faire joindre une adresse interne.
 *
 * - `https:` uniquement, à chaque saut ;
 * - le nom est résolu UNE fois, toutes les adresses obtenues sont vérifiées, et
 *   la connexion part vers l'adresse vérifiée (pas de seconde résolution : un
 *   DNS rebinding ne peut pas substituer une IP interne entre contrôle et
 *   connexion) ;
 * - redirections suivies au plus `maxRedirects` fois, chacune re-vérifiée ;
 * - délai global, et flux coupé dès que `maxBytes` est dépassé.
 */

/** Levée quand une URL est refusée ou que son téléchargement échoue. */
export class UrlFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlFetchError';
  }
}

/** Levée quand la réponse dépasse le plafond d'octets : le flux est coupé. */
export class UrlTooLargeError extends UrlFetchError {
  constructor(message: string) {
    super(message);
    this.name = 'UrlTooLargeError';
  }
}

// ---------------------------------------------------------------------------
// Classification des adresses
// ---------------------------------------------------------------------------

/** Plages IPv4 refusées : [adresse de réseau, longueur de préfixe, motif]. */
const BLOCKED_V4: [string, number, string][] = [
  ['0.0.0.0', 8, 'réseau « this host »'],
  ['10.0.0.0', 8, 'réseau privé'],
  ['100.64.0.0', 10, 'CGNAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local'],
  ['172.16.0.0', 12, 'réseau privé'],
  ['192.0.0.0', 24, 'réservé IETF'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, 'relais 6to4'],
  ['192.168.0.0', 16, 'réseau privé'],
  ['198.18.0.0', 15, 'banc de test'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'réservé / broadcast'],
];

function parseIPv4(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const byte = Number(part);
    if (byte > 255) return undefined;
    value = value * 256 + byte;
  }
  return value;
}

function v4Reason(value: number): string | undefined {
  for (const [network, prefix, reason] of BLOCKED_V4) {
    const size = 2 ** (32 - prefix);
    const start = parseIPv4(network) as number;
    if (value >= start && value < start + size) return reason;
  }
  return undefined;
}

/** IPv6 → 16 octets (gère `::`, une zone `%eth0` et une fin en notation pointée). */
function parseIPv6(address: string): number[] | undefined {
  let text = address.split('%')[0] as string;
  const tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (text.includes('.', lastColon)) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail.push(v4 >>> 24, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
    // On ne garde que la partie hexadécimale : « ::ffff: » → « ::ffff », « :: » reste « :: ».
    const prefix = text.slice(0, lastColon + 1);
    text = prefix.endsWith('::') ? prefix : prefix.slice(0, -1);
  }

  const groupsWanted = (16 - tail.length) / 2;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0] as string);
  const rest = halves.length === 2 ? parse(halves[1] as string) : [];
  const missing = groupsWanted - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;

  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const value = parseInt(group, 16);
    bytes.push(value >>> 8, value & 0xff);
  }
  return [...bytes, ...tail];
}

function startsWith(bytes: number[], prefix: number[], bits: number): boolean {
  for (let bit = 0; bit < bits; bit++) {
    const mask = 0x80 >>> (bit % 8);
    if (((bytes[bit >> 3] as number) & mask) !== ((prefix[bit >> 3] ?? 0) & mask)) return false;
  }
  return true;
}

function embeddedV4(bytes: number[], offset: number): number {
  return (
    (bytes[offset] as number) * 2 ** 24 +
    ((bytes[offset + 1] as number) << 16) +
    ((bytes[offset + 2] as number) << 8) +
    (bytes[offset + 3] as number)
  );
}

function v6Reason(bytes: number[]): string | undefined {
  // ::ffff:a.b.c.d (IPv4 mappée), ::a.b.c.d (IPv4 compatible, dont :: et ::1),
  // 64:ff9b::a.b.c.d (NAT64) : on juge l'IPv4 qu'elles portent.
  const zeros80 = bytes.slice(0, 10).every((b) => b === 0);
  if (zeros80 && bytes[10] === 0xff && bytes[11] === 0xff) {
    const reason = v4Reason(embeddedV4(bytes, 12));
    return reason && `IPv4 mappée (${reason})`;
  }
  if (bytes.slice(0, 12).every((b) => b === 0)) {
    if (bytes.slice(12, 15).every((b) => b === 0) && (bytes[15] as number) <= 1) {
      return bytes[15] === 1 ? 'loopback' : 'adresse non spécifiée';
    }
    return 'IPv4 compatible (obsolète)';
  }
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b], 96)) {
    const reason = v4Reason(embeddedV4(bytes, 12));
    return reason && `NAT64 (${reason})`;
  }
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return 'NAT64 local';

  // Hors 2000::/3 (unicast global) : ULA fc00::/7, link-local fe80::/10,
  // multicast ff00::/8, site-local, réservés…
  if (startsWith(bytes, [0xfc], 7)) return 'adresse locale unique (ULA)';
  if (startsWith(bytes, [0xfe, 0x80], 10)) return 'link-local';
  if (startsWith(bytes, [0xff], 8)) return 'multicast';
  if (!startsWith(bytes, [0x20], 3)) return 'hors unicast global';

  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x00], 32)) return 'Teredo';
  if (startsWith(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return 'documentation';
  if (startsWith(bytes, [0x3f, 0xff], 20)) return 'documentation';
  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x10], 28)) return 'ORCHID';
  if (startsWith(bytes, [0x20, 0x02], 16)) {
    const reason = v4Reason(embeddedV4(bytes, 2));
    return reason && `6to4 (${reason})`;
  }
  return undefined;
}

/**
 * Motif du refus si `address` n'est pas une adresse publique joignable
 * (privée, locale, loopback, link-local, CGNAT, multicast, réservée…), sinon
 * `undefined`. Une chaîne qui n'est pas une IP est refusée.
 */
export function forbiddenAddressReason(address: string): string | undefined {
  const family = isIP(address.split('%')[0] as string);
  if (family === 4) {
    const value = parseIPv4(address);
    return value === undefined ? 'adresse illisible' : v4Reason(value);
  }
  if (family === 6) {
    const bytes = parseIPv6(address);
    return bytes === undefined ? 'adresse illisible' : v6Reason(bytes);
  }
  return 'adresse illisible';
}

// ---------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Requête GET vers une adresse déjà vérifiée. */
export interface PinnedRequest {
  url: URL;
  /** Adresse IP vérifiée vers laquelle se connecter (jamais re-résolue). */
  address: ResolvedAddress;
  signal: AbortSignal;
}

export interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Buffer>;
  /** Ferme la connexion (flux trop gros, redirection, erreur). */
  close(): void;
}

export interface GuardedFetchDeps {
  /** Résolution DNS : toutes les adresses du nom. */
  resolveHost?: (hostname: string) => Promise<ResolvedAddress[]>;
  /** GET HTTPS vers l'adresse vérifiée, sans suivre les redirections. */
  request?: (request: PinnedRequest) => Promise<PinnedResponse>;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface GuardedFetchResult {
  /** URL finale, après redirections. */
  url: URL;
  headers: IncomingHttpHeaders;
  content: Buffer;
}

export const URL_FETCH_TIMEOUT_MS = 15_000;
export const URL_MAX_REDIRECTS = 3;

async function defaultResolveHost(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
}

/**
 * GET HTTPS vers `address`, en conservant le nom d'hôte pour SNI, la
 * vérification du certificat et l'en-tête Host. Le `lookup` imposé court-
 * circuite le DNS : le socket ne peut joindre que l'adresse vérifiée.
 */
function defaultRequest({ url, address, signal }: PinnedRequest): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        headers: { 'user-agent': 'icloud-mail-mcp', accept: '*/*', 'accept-encoding': 'identity' },
        lookup: (_hostname, options, callback) => {
          const cb = callback as (
            err: Error | null,
            address: string | LookupAddress[],
            family?: number,
          ) => void;
          if ((options as { all?: boolean }).all) {
            cb(null, [{ address: address.address, family: address.family }]);
          } else {
            cb(null, address.address, address.family);
          }
        },
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          close: () => res.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Vérifie l'URL, résout l'hôte une fois et renvoie l'adresse à utiliser. */
async function checkTarget(
  url: URL,
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]>,
): Promise<ResolvedAddress> {
  if (url.protocol !== 'https:') {
    throw new UrlFetchError(`seules les URL https:// sont acceptées (reçu ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new UrlFetchError('les identifiants dans l’URL ne sont pas acceptés');
  }

  // `URL` garde les crochets d'une IPv6 littérale.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literal) {
    addresses = [{ address: hostname, family: literal as 4 | 6 }];
  } else {
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new UrlFetchError(`nom d’hôte introuvable : ${hostname}`);
    }
  }
  if (addresses.length === 0) {
    throw new UrlFetchError(`nom d’hôte introuvable : ${hostname}`);
  }

  // Une seule adresse interne suffit à refuser : on ne choisit pas « la bonne ».
  for (const entry of addresses) {
    const reason = forbiddenAddressReason(entry.address);
    if (reason) {
      throw new UrlFetchError(`adresse refusée pour ${hostname} : ${entry.address} (${reason})`);
    }
  }
  return addresses[0] as ResolvedAddress;
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

/**
 * Télécharge `rawUrl` avec les protections décrites en tête de module.
 * `maxBytes` : au-delà, le flux est coupé et `UrlTooLargeError` levée.
 */
export async function fetchHttpsGuarded(
  rawUrl: string,
  maxBytes: number,
  deps: GuardedFetchDeps = {},
): Promise<GuardedFetchResult> {
  const resolveHost = deps.resolveHost ?? defaultResolveHost;
  const request = deps.request ?? defaultRequest;
  const timeoutMs = deps.timeoutMs ?? URL_FETCH_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? URL_MAX_REDIRECTS;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UrlFetchError('URL illisible');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const timedOut = () => new UrlFetchError(`délai de ${Math.round(timeoutMs / 1000)} s dépassé`);

  try {
    for (let hop = 0; ; hop++) {
      let address;
      try {
        address = await abortable(checkTarget(url, resolveHost), controller.signal);
      } catch (err) {
        if (controller.signal.aborted) throw timedOut();
        throw err;
      }
      if (controller.signal.aborted) throw timedOut();

      let response: PinnedResponse;
      try {
        response = await abortable(
          request({ url, address, signal: controller.signal }),
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) throw timedOut();
        throw new UrlFetchError(`échec de la connexion : ${(err as Error).message}`);
      }

      if (isRedirect(response.status)) {
        response.close();
        const location = response.headers.location;
        if (!location) throw new UrlFetchError(`redirection ${response.status} sans Location`);
        if (hop >= maxRedirects) {
          throw new UrlFetchError(`trop de redirections (maximum ${maxRedirects})`);
        }
        try {
          url = new URL(location, url);
        } catch {
          throw new UrlFetchError('redirection vers une URL illisible');
        }
        continue;
      }

      if (response.status < 200 || response.status >= 300) {
        response.close();
        throw new UrlFetchError(`le serveur a répondu ${response.status}`);
      }

      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.close();
        throw new UrlTooLargeError(
          `${declared} octets annoncés, au-delà des ${maxBytes} octets encore disponibles ` +
            '(ATTACHMENT_MAX_BYTES)',
        );
      }

      const chunks: Buffer[] = [];
      let received = 0;
      try {
        for await (const chunk of response.body) {
          received += chunk.length;
          if (received > maxBytes) {
            response.close();
            throw new UrlTooLargeError(
              `plus de ${maxBytes} octets reçus, au-delà de ce qui reste disponible ` +
                '(ATTACHMENT_MAX_BYTES) : téléchargement interrompu',
            );
          }
          chunks.push(chunk);
          if (controller.signal.aborted) {
            response.close();
            throw timedOut();
          }
        }
      } catch (err) {
        if (err instanceof UrlFetchError) throw err;
        if (controller.signal.aborted) throw timedOut();
        throw new UrlFetchError(`lecture interrompue : ${(err as Error).message}`);
      }
      return { url, headers: response.headers, content: Buffer.concat(chunks) };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Rejette dès que `signal` est levé, même si `promise` ne se résout jamais. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
