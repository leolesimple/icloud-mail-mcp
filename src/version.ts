import { readFileSync } from 'node:fs';

/**
 * Version du serveur, lue une fois depuis `package.json`. Source unique :
 * `src/mcp/server.ts` et l'outil `whoami` s'appuient dessus plutôt que de
 * répéter un littéral qui finirait par diverger du champ `version`.
 *
 * Lecture par `fs` (et non `import ... with { type: 'json' }`) : `package.json`
 * est hors de `rootDir`, un import le ferait entrer dans la compilation.
 */
const pkgUrl = new URL('../package.json', import.meta.url);

interface PackageJson {
  version?: string;
}

const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as PackageJson;

export const serverVersion: string = pkg.version ?? '0.0.0';
