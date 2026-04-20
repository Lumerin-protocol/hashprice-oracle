/**
 * Bundles the Lambda handler into a single ESM file and packages it as a
 * zip ready for `aws lambda update-function-code`.
 *
 * Output:
 *   dist/index.mjs       - bundled handler (entrypoint: `handler`)
 *   dist/index.mjs.map   - source map
 *   dist/index.zip       - deployment artifact
 *
 * Usage:
 *   node scripts/build-lambda.ts
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const keeperRoot = resolve(here, "..");
const distDir = resolve(keeperRoot, "dist");
const outfile = resolve(distDir, "index.mjs");
const zipfile = resolve(distDir, "index.zip");

// Bundled CJS dependencies (e.g. pino) call require() at runtime. ESM has no
// require, so esbuild emits a stub that throws "Dynamic require of ...".
// Inject a real require derived from import.meta.url to fix that.
const cjsRequireShim = [
  "import { createRequire as __createRequire } from 'module';",
  "const require = __createRequire(import.meta.url);",
].join("");

rmSync(zipfile, { force: true });

await build({
  entryPoints: [resolve(keeperRoot, "src/adapters/lambda.ts")],
  outfile,
  bundle: true,
  minify: true,
  sourcemap: true,
  platform: "node",
  target: "es2024",
  format: "esm",
  banner: { js: cjsRequireShim },
  logLevel: "info",
});

const zip = spawnSync("zip", ["-r", "index.zip", "index.mjs", "index.mjs.map"], {
  cwd: distDir,
  stdio: "inherit",
});
if (zip.status !== 0) {
  throw new Error(`zip exited with status ${zip.status}`);
}

console.log(`✅ Built ${zipfile}`);
