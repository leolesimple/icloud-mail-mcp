import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Replace npm's version-only step: no publish, lifecycle scripts, tags or commits. */
export async function prepare(_options, { cwd, nextRelease: { version }, logger }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Invalid release version');
  }
  const packagePath = join(cwd, 'package.json');
  const lockPath = join(cwd, 'package-lock.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (manifest.private !== true || lock.name !== manifest.name || !lock.packages?.['']) {
    throw new Error('Release version hook requires matching private package and lockfile');
  }
  manifest.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  await writeFile(packagePath, JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
  logger.log('Updated application package and lockfile to %s', version);
}
