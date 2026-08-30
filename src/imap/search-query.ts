import type { SearchObject } from 'imapflow';

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
