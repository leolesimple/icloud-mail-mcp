import type {
  MessageAddressObject,
  MessageEnvelopeObject,
  MessageStructureObject,
  SearchObject,
} from 'imapflow';

/**
 * Critères texte, réutilisés à l'identique au premier niveau, dans `not`
 * (à exclure) et dans chaque branche de `or` (au moins une doit correspondre).
 * `subject`, `from` et `to` sont vérifiés localement, `body` et `text` par IMAP
 * SEARCH : voir `planSearch`.
 */
export interface TextCriteria {
  subject?: string;
  body?: string;
  from?: string;
  to?: string;
  /** SEARCH TEXT : cherche dans les en-têtes ET le corps. */
  text?: string;
}

export interface SearchCriteria extends TextCriteria {
  /** Ne renvoyer que les messages non lus (SEARCH UNSEEN). */
  unreadOnly?: boolean;
  /** Ne renvoyer que les messages favoris (SEARCH FLAGGED). */
  flagged?: boolean;
  /** Messages reçus à partir de cette date, incluse (SEARCH SINCE, à la journée près). */
  since?: Date;
  /** Messages reçus avant cette date, exclue (SEARCH BEFORE, à la journée près). */
  before?: Date;
  /** Curseur de pagination : ne renvoyer que les UID strictement inférieurs à cette valeur. */
  beforeUid?: number;
  /** Critères texte à exclure. */
  not?: TextCriteria;
  /** Branches dont au moins une doit correspondre. */
  or?: TextCriteria[];
  /**
   * Avec (true) ou sans (false) pièce jointe. IMAP SEARCH ne sait pas filtrer
   * là-dessus : filtré côté serveur MCP sur le BODYSTRUCTURE (voir `attachmentFilterOf`).
   */
  hasAttachment?: boolean;
  /**
   * Au moins une pièce jointe de ce type MIME (« application/pdf »), ou de ce
   * préfixe (« image/ », « image/* »). Implique `hasAttachment: true`.
   */
  attachmentType?: string;
}

/** Champs texte vérifiés par le serveur MCP sur l'ENVELOPE, jamais envoyés à IMAP SEARCH. */
const LOCAL_FIELDS = ['subject', 'from', 'to'] as const;
/** Champs texte laissés à IMAP SEARCH (l'ENVELOPE ne contient pas le corps). */
const SERVER_FIELDS = ['body', 'text'] as const;

/** Critères texte vérifiés localement : `subject`, `from`, `to`. */
export type LocalText = Partial<Record<(typeof LOCAL_FIELDS)[number], string>>;

function pick<K extends keyof TextCriteria>(
  criteria: TextCriteria,
  fields: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const field of fields) {
    const value = criteria[field];
    if (value) out[field] = value;
  }
  return out;
}

function serverText(criteria: TextCriteria): SearchObject {
  return pick(criteria, SERVER_FIELDS);
}

function localText(criteria: TextCriteria): LocalText {
  return pick(criteria, LOCAL_FIELDS);
}

function isEmpty(query: object): boolean {
  return Object.keys(query).length === 0;
}

function hasText(criteria: TextCriteria): boolean {
  return !isEmpty(serverText(criteria)) || !isEmpty(localText(criteria));
}

/**
 * True si au moins un critère de recherche exploitable est fourni. Le curseur
 * `beforeUid` et le dossier n'en sont pas : ils restreignent une recherche, ils
 * ne la définissent pas.
 */
export function hasSearchCriteria(criteria: SearchCriteria): boolean {
  if (hasText(criteria)) return true;
  if (criteria.unreadOnly || criteria.flagged) return true;
  if (criteria.since || criteria.before) return true;
  if (criteria.not && hasText(criteria.not)) return true;
  if (criteria.or && criteria.or.some(hasText)) return true;
  if (attachmentFilterOf(criteria)) return true;
  return false;
}

/**
 * True quand le curseur a atteint le début du dossier : les UID commençant à 1,
 * `beforeUid <= 1` ne peut plus rien renvoyer. À court-circuiter avant toute
 * commande IMAP.
 */
export function paginationExhausted(beforeUid: number | undefined): boolean {
  return beforeUid !== undefined && beforeUid <= 1;
}

/**
 * Condition évaluée localement : tous les critères de `text` sur l'ENVELOPE et,
 * si `server` est présent, l'appartenance du message au résultat de ce SEARCH
 * dédié (partie `body`/`text` d'une branche mixte).
 */
export interface LocalCondition {
  text: LocalText;
  server?: SearchObject;
}

/** Filtre appliqué par le serveur MCP aux candidats renvoyés par le SEARCH principal. */
export interface LocalFilter {
  /** Critères de premier niveau (ET). */
  require: LocalText;
  /** Exclusion : le message est écarté s'il satisfait cette condition. */
  exclude?: LocalCondition;
  /** Au moins une de ces conditions doit être satisfaite. */
  anyOf?: LocalCondition[];
}

export interface SearchPlan {
  /** SEARCH principal, sans aucun critère `subject`/`from`/`to`. */
  query: SearchObject;
  /** Critères restant à vérifier sur l'ENVELOPE ; absent s'il n'y en a pas. */
  local?: LocalFilter;
}

function uidRange(beforeUid: number | undefined): string | undefined {
  // Les UID croissent avec le temps : « avant ce curseur » = UID strictement plus petits.
  // `paginationExhausted` couvre le cas `beforeUid <= 1` en amont.
  return beforeUid !== undefined && beforeUid > 1 ? `1:${beforeUid - 1}` : undefined;
}

/**
 * Répartit les critères entre IMAP SEARCH et le serveur MCP. Fonction pure.
 *
 * Le SEARCH d'iCloud n'applique pas FROM en sous-chaîne comme le veut la RFC
 * 3501 : `FROM "apple.com"` rate des expéditeurs `…@email.apple.com` que
 * l'adresse complète retrouve. `subject`, `from` et `to` ne sont donc jamais
 * envoyés à SEARCH, à aucun niveau : ils sont vérifiés sur l'ENVELOPE des
 * candidats (voir `matchesLocalFilter`). SEARCH garde les dates, `unreadOnly`,
 * `flagged`, `body`, `text` et le curseur ; sans critère restant, il part de ALL.
 *
 * Règle pour `not` et `or` :
 * - une négation ou un jeu de branches qui ne contient que `body`/`text` reste
 *   dans le SEARCH principal (NOT, OR) ;
 * - sinon il est évalué localement ; la partie `body`/`text` d'une négation ou
 *   d'une branche mixte devient un SEARCH dédié (borné par le curseur), dont le
 *   résultat sert de test d'appartenance. NOT (A ET B) ne se découpe pas en
 *   NOT A ET NOT B, ni OR en morceaux : la condition est évaluée d'un bloc.
 * - une seule branche `or` non vide vaut un critère ET.
 */
export function planSearch(criteria: SearchCriteria): SearchPlan {
  const query: SearchObject = { all: true, ...serverText(criteria) };
  const require = localText(criteria);
  const local: LocalFilter = { require };

  if (criteria.unreadOnly) query.seen = false;
  if (criteria.flagged) query.flagged = true;
  if (criteria.since) query.since = criteria.since;
  if (criteria.before) query.before = criteria.before;
  const uid = uidRange(criteria.beforeUid);
  if (uid) query.uid = uid;

  const condition = (text: TextCriteria): LocalCondition => {
    const server = serverText(text);
    if (isEmpty(server)) return { text: localText(text) };
    return { text: localText(text), server: uid ? { ...server, uid } : server };
  };

  if (criteria.not && hasText(criteria.not)) {
    if (isEmpty(localText(criteria.not))) query.not = serverText(criteria.not);
    else local.exclude = condition(criteria.not);
  }

  const branches = (criteria.or ?? []).filter(hasText);
  if (branches.length === 1) {
    // imapflow exige au moins deux branches pour OR ; une seule = simple critère ET.
    const [branch] = branches as [TextCriteria];
    Object.assign(query, serverText(branch));
    Object.assign(require, localText(branch));
  } else if (branches.length >= 2) {
    if (branches.every((branch) => isEmpty(localText(branch)))) query.or = branches.map(serverText);
    else local.anyOf = branches.map(condition);
  }

  const needed = !isEmpty(require) || local.exclude !== undefined || local.anyOf !== undefined;
  return needed ? { query, local } : { query };
}

/** SEARCH principal (voir `planSearch`). */
export function buildSearchQuery(criteria: SearchCriteria): SearchObject {
  return planSearch(criteria).query;
}

/** Comparaison sans casse, en forme Unicode composée (« é » saisi ou décomposé). */
function fold(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function includesFolded(haystack: string | undefined, needle: string): boolean {
  return haystack !== undefined && fold(haystack).includes(fold(needle));
}

function addressMatches(list: MessageAddressObject[] | undefined, needle: string): boolean {
  return (list ?? []).some(
    (addr) => includesFolded(addr.name, needle) || includesFolded(addr.address, needle),
  );
}

/**
 * Critères locaux sur une ENVELOPE : sous-chaîne sans casse dans le sujet
 * décodé, ou dans le nom affiché ou l'adresse d'un expéditeur (`from`) ou d'un
 * destinataire du champ To (`to`, comme SEARCH TO).
 */
export function matchesLocalText(
  envelope: MessageEnvelopeObject | undefined,
  text: LocalText,
): boolean {
  if (text.subject !== undefined && !includesFolded(envelope?.subject, text.subject)) return false;
  if (text.from !== undefined && !addressMatches(envelope?.from, text.from)) return false;
  if (text.to !== undefined && !addressMatches(envelope?.to, text.to)) return false;
  return true;
}

/**
 * Applique un `LocalFilter` à un candidat. `serverMatches` donne, pour chaque
 * condition portant une partie `server`, les UID renvoyés par son SEARCH dédié.
 */
export function matchesLocalFilter(
  uid: number,
  envelope: MessageEnvelopeObject | undefined,
  filter: LocalFilter,
  serverMatches: ReadonlyMap<LocalCondition, ReadonlySet<number>>,
): boolean {
  const holds = (condition: LocalCondition): boolean =>
    (!condition.server || serverMatches.get(condition)?.has(uid) === true) &&
    matchesLocalText(envelope, condition.text);
  if (!matchesLocalText(envelope, filter.require)) return false;
  if (filter.exclude && holds(filter.exclude)) return false;
  if (filter.anyOf && !filter.anyOf.some(holds)) return false;
  return true;
}

/** Filtre pièces jointes, appliqué après le SEARCH sur le BODYSTRUCTURE des candidats. */
export interface AttachmentFilter {
  /** true : au moins une pièce jointe (du type demandé) ; false : aucune. */
  present: boolean;
  /** Type MIME exact (« application/pdf ») ou préfixe terminé par « / » (« image/ »), en minuscules. */
  type?: string;
}

/**
 * Extrait le filtre pièces jointes des critères, ou `undefined` s'il n'y en a
 * pas. `attachmentType` implique la présence d'une pièce jointe ; « image/* »
 * est ramené au préfixe « image/ ».
 */
export function attachmentFilterOf(criteria: SearchCriteria): AttachmentFilter | undefined {
  const raw = criteria.attachmentType?.trim().toLowerCase();
  const type = raw ? raw.replace(/\/\*$/, '/') : undefined;
  if (type) return { present: true, type };
  if (criteria.hasAttachment === undefined) return undefined;
  return { present: criteria.hasAttachment };
}

/** Pièce jointe lue dans le BODYSTRUCTURE, telle que la renvoie `find_messages`. */
export interface AttachmentPart {
  /** Type MIME, en minuscules. */
  contentType: string;
  filename?: string;
  /** Taille de la partie encodée (base64…), donc un peu plus que le fichier. */
  size?: number;
  /**
   * Partie affichée dans le corps plutôt que jointe : disposition `inline`, ou
   * Content-ID sans disposition `attachment` (image référencée par le HTML).
   */
  inline: boolean;
}

function isAttachmentPart(node: MessageStructureObject): boolean {
  if (node.disposition?.toLowerCase() === 'attachment') return true;
  return Boolean(node.dispositionParameters?.filename || node.parameters?.name);
}

/**
 * Règle `inline` commune à find_messages (BODYSTRUCTURE) et read_message
 * (mailparser) : disposition `inline`, ou Content-ID sans disposition `attachment`.
 */
export function isInlinePart(
  disposition: string | undefined,
  contentId: string | undefined,
): boolean {
  const kind = disposition?.toLowerCase();
  return kind === 'inline' || (Boolean(contentId) && kind !== 'attachment');
}

/**
 * Pièces jointes d'un BODYSTRUCTURE. Est une pièce jointe toute partie feuille
 * marquée `Content-Disposition: attachment`, ou portant un nom de fichier
 * (`filename` de disposition, `name` de type) : une image intégrée nommée en
 * est donc une, signalée par `inline`. Un message joint (message/rfc822) compte
 * pour une pièce jointe, sans descendre dans ses propres parties.
 */
export function attachmentParts(structure: MessageStructureObject | undefined): AttachmentPart[] {
  if (!structure) return [];
  const parts: AttachmentPart[] = [];
  const visit = (node: MessageStructureObject): void => {
    const isMultipart = node.type.toLowerCase().startsWith('multipart/');
    if (!isMultipart && isAttachmentPart(node)) {
      const filename = node.dispositionParameters?.filename || node.parameters?.name;
      parts.push({
        contentType: node.type.toLowerCase(),
        ...(filename ? { filename } : {}),
        ...(node.size !== undefined ? { size: node.size } : {}),
        inline: isInlinePart(node.disposition, node.id),
      });
      return;
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(structure);
  return parts;
}

/** Types MIME (en minuscules) des pièces jointes d'un BODYSTRUCTURE. */
export function attachmentTypes(structure: MessageStructureObject | undefined): string[] {
  return attachmentParts(structure).map((part) => part.contentType);
}

/** True si le BODYSTRUCTURE d'un message satisfait le filtre pièces jointes. */
export function matchesAttachmentFilter(
  structure: MessageStructureObject | undefined,
  filter: AttachmentFilter,
): boolean {
  const types = attachmentTypes(structure);
  const { type } = filter;
  const found = type
    ? types.some((candidate) =>
        type.endsWith('/') ? candidate.startsWith(type) : candidate === type,
      )
    : types.length > 0;
  return found === filter.present;
}
