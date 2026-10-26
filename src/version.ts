import { createRequire } from 'node:module';

/** Package version, read from package.json (one level above both `src/` and `dist/`). */
export const VERSION: string = (() => {
  const pkg: unknown = createRequire(import.meta.url)('../package.json');
  return typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string'
    ? pkg.version
    : '0.0.0';
})();
