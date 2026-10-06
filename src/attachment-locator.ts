/**
 * Désignation d'une pièce jointe dans un message, sous l'une de deux formes :
 *
 * - `index` : position dans la liste de `read_message`, c'est-à-dire dans les
 *   pièces jointes de mailparser après téléchargement du message entier ;
 * - `part` : numéro de partie IMAP (« 2 », « 1.3 »), lu dans le BODYSTRUCTURE
 *   et renvoyé par `find_messages` ; seule cette partie est téléchargée.
 *
 * Les deux listes ne coïncident pas toujours (mailparser compte par exemple
 * les images intégrées sans nom) : un `index` ne se déduit pas d'un `part`.
 * Module pur, partagé par les outils, les liens signés et `compose_message`.
 */

/** Numéro de partie IMAP : entiers séparés par des points. */
export const PART_PATTERN = /^\d+(\.\d+)*$/;

export type AttachmentLocator =
  { index: number; part?: undefined } | { part: string; index?: undefined };

/** Motif de refus si l'entrée ne porte pas exactement un de `index` ou `part`. */
export function locatorProblem(value: { index?: unknown; part?: unknown }): string | undefined {
  const given = [value.index, value.part].filter((v) => v !== undefined).length;
  if (given === 1) return undefined;
  return (
    'exactement un de index (position dans read_message) ou part (numéro de partie IMAP, ' +
    `voir find_messages) est requis (reçu : ${given === 0 ? 'aucun' : 'les deux'})`
  );
}

/** Ramène une entrée validée par `locatorProblem` à la forme discriminée. */
export function toLocator(value: { index?: number; part?: string }): AttachmentLocator {
  return value.part !== undefined ? { part: value.part } : { index: value.index as number };
}

/** Libellé court (« #1 », « partie 2 ») pour les messages d'erreur et les noms par défaut. */
export function locatorLabel(locator: AttachmentLocator): string {
  return locator.part !== undefined ? `partie ${locator.part}` : `#${locator.index}`;
}
