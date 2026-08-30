/**
 * `html-to-text` (10.0.1) ne fournit pas de types et `@types/html-to-text`
 * serait une dépendance nouvelle (interdit par CLAUDE.md). On ne se sert que de
 * `convert`, dont voici la signature minimale.
 */
declare module 'html-to-text' {
  export function convert(html: string, options?: Record<string, unknown>): string;
  export function compile(options?: Record<string, unknown>): (html: string) => string;
  export { convert as htmlToText };
}
