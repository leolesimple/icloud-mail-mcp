import type { MessageStructureObject, SearchObject } from 'imapflow';

/**
 * Critères texte, réutilisés à l'identique au premier niveau, dans `not`
 * (à exclure) et dans chaque branche de `or` (au moins une doit correspondre).
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

function textObject(criteria: TextCriteria): SearchObject {
  const query: SearchObject = {};
  if (criteria.subject) query.subject = criteria.subject;
  if (criteria.body) query.body = criteria.body;
  if (criteria.from) query.from = criteria.from;
  if (criteria.to) query.to = criteria.to;
  if (criteria.text) query.text = criteria.text;
  return query;
}

function isEmpty(query: SearchObject): boolean {
  return Object.keys(query).length === 0;
}

/**
 * True si au moins un critère de recherche exploitable est fourni. Le curseur
 * `beforeUid` et le dossier n'en sont pas : ils restreignent une recherche, ils
 * ne la définissent pas.
 */
export function hasSearchCriteria(criteria: SearchCriteria): boolean {
  if (!isEmpty(textObject(criteria))) return true;
  if (criteria.unreadOnly || criteria.flagged) return true;
  if (criteria.since || criteria.before) return true;
  if (criteria.not && !isEmpty(textObject(criteria.not))) return true;
  if (criteria.or && criteria.or.some((branch) => !isEmpty(textObject(branch)))) return true;
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
 * Traduit un jeu de critères unifié (liste ET recherche) en `SearchObject`
 * imapflow. Fonction pure : aucun accès IMAP, tout le comportement est
 * vérifiable en isolation. C'est le point de fusion de `ListMessagesOptions` et
 * `SearchMessagesOptions`.
 */
export function buildSearchQuery(criteria: SearchCriteria): SearchObject {
  const query: SearchObject = { all: true, ...textObject(criteria) };

  if (criteria.unreadOnly) query.seen = false;
  if (criteria.flagged) query.flagged = true;
  if (criteria.since) query.since = criteria.since;
  if (criteria.before) query.before = criteria.before;

  // Les UID croissent avec le temps : « avant ce curseur » = UID strictement plus petits.
  // `paginationExhausted` couvre le cas `beforeUid <= 1` en amont.
  if (criteria.beforeUid !== undefined && criteria.beforeUid > 1) {
    query.uid = `1:${criteria.beforeUid - 1}`;
  }

  if (criteria.not) {
    const not = textObject(criteria.not);
    if (!isEmpty(not)) query.not = not;
  }

  if (criteria.or) {
    const branches = criteria.or.map(textObject).filter((branch) => !isEmpty(branch));
    // imapflow exige au moins deux branches pour OR ; une seule = simple critère ET.
    if (branches.length === 1) {
      Object.assign(query, branches[0]);
    } else if (branches.length >= 2) {
      query.or = branches;
    }
  }

  return query;
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
