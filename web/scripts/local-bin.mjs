// Resolving an installed package's executable to a path node can run directly.
//
// The scripts in this directory spawn vitest and astro as child processes, and
// they do it as `node <path-to-entry-point>` rather than by name. That is a
// Windows constraint made explicit: npm installs `vitest.cmd`, `vitest.ps1` and
// a shell script side by side in `node_modules/.bin`, spawning the name needs
// `shell: true` to reach the `.cmd`, and a PowerShell execution policy of
// `Restricted` refuses the `.ps1` outright (issues #581 and #599 record the
// same edge for `npm` itself). Spawning node with a `.mjs` path has none of
// those failure modes and behaves identically on every platform.
//
// The entry point is read from the package's own `bin` field rather than
// written down here, so an upgrade that moves or renames it fails loudly at
// resolution time instead of being pinned to a path this file guessed.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * The absolute path of `binName`'s entry point inside the installed package of
 * the same name.
 *
 * @param {string} binName a package that installs an executable under its own name
 */
export function localBin(binName) {
  const manifestPath = require.resolve(`${binName}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];

  if (typeof entry !== 'string') {
    throw new Error(
      `${binName}'s package.json declares no "${binName}" executable, so there is ` +
        'nothing to run. Reinstall with `npm ci` from web/, and if that does not ' +
        'fix it the package layout has changed and this resolution needs updating.',
    );
  }

  return join(dirname(manifestPath), entry);
}
