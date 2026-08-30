import type { FullMessage, MessageAddress } from './messages.js';

/** Les champs d'un message original nécessaires pour construire une réponse. */
export type ThreadableMessage = Pick<FullMessage, 'subject' | 'messageId' | 'references' | 'from'> &
  Partial<Pick<FullMessage, 'to' | 'cc'>>;

export interface ReplyHeaders {
  subject: string;
  inReplyTo?: string;
  references: string[];
  to: string[];
  cc?: string[];
}

/** Options de `buildReplyHeaders` pour une réponse « à tous ». */
export interface BuildReplyOptions {
  /** Inclure les autres destinataires du message d'origine (To + Cc). */
  replyAll?: boolean;
  /** Adresse du compte, retirée de `to` et `cc` et utilisée pour le dédoublonnage. */
  selfAddress: string;
  /** `cc` explicite fourni par l'appelant : l'emporte sur le `cc` déduit. */
  cc?: string[];
}

const FALLBACK_SUBJECT = '(sans objet)';

/** Préfixe "Re: " sauf si le sujet en porte déjà un. */
export function replySubject(originalSubject: string | undefined): string {
  const subject = originalSubject ?? FALLBACK_SUBJECT;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Préfixe "Fwd: " sauf si le sujet en porte déjà un. Idempotent, comme `replySubject`. */
export function forwardSubject(originalSubject: string | undefined): string {
  const subject = originalSubject ?? FALLBACK_SUBJECT;
  return /^fwd:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

/** Adresses exploitables d'une liste d'expéditeurs (celles sans adresse sont ignorées). */
export function addressList(addresses: MessageAddress[]): string[] {
  return addresses
    .map((address) => address.address)
    .filter((address): address is string => Boolean(address));
}

/** Dédoublonne une liste d'adresses en ignorant la casse, en gardant la première graphie vue. */
function dedupeAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const address of addresses) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address);
  }
  return result;
}

/**
 * Chaîne de References conforme à la RFC 5322 : les références du message
 * original, suivies de son propre Message-ID, sans doublon.
 */
export function replyReferences(original: ThreadableMessage): string[] {
  const references = [...original.references];
  if (original.messageId && !references.includes(original.messageId)) {
    references.push(original.messageId);
  }
  return references;
}

/**
 * Construit les en-têtes d'une réponse à `original`. Partagé par l'envoi SMTP
 * (`sendReply`) et le brouillon IMAP (`saveDraft`) pour que les deux produisent
 * exactement le même threading.
 *
 * Sans `options`, comportement historique : `to` = expéditeur d'origine, pas de `cc`.
 * Avec `options`, l'adresse du compte est retirée et, en mode `replyAll`, les
 * autres destinataires d'origine sont répartis entre `to` et `cc`.
 */
export function buildReplyHeaders(original: ThreadableMessage, options?: BuildReplyOptions): ReplyHeaders {
  const base = {
    subject: replySubject(original.subject),
    inReplyTo: original.messageId,
    references: replyReferences(original),
  };

  if (!options) {
    return { ...base, to: addressList(original.from) };
  }

  const self = options.selfAddress.toLowerCase();
  const isSelf = (address: string): boolean => address.toLowerCase() === self;

  const derivedTo = dedupeAddresses([
    ...addressList(original.from),
    ...(options.replyAll ? addressList(original.to ?? []) : []),
  ]).filter((address) => !isSelf(address));
  // Ne jamais vider `to` : si le message vient de nous, on garde l'expéditeur d'origine.
  const to = derivedTo.length > 0 ? derivedTo : addressList(original.from);

  let cc: string[] | undefined;
  if (options.cc !== undefined) {
    cc = options.cc.length > 0 ? options.cc : undefined;
  } else if (options.replyAll) {
    const inTo = new Set(to.map((address) => address.toLowerCase()));
    const derivedCc = dedupeAddresses(addressList(original.cc ?? [])).filter(
      (address) => !isSelf(address) && !inTo.has(address.toLowerCase()),
    );
    cc = derivedCc.length > 0 ? derivedCc : undefined;
  }

  return cc ? { ...base, to, cc } : { ...base, to };
}
