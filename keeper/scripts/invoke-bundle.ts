/**
 * Invokes the bundled Lambda artifact (dist/index.mjs) against the local
 * environment. This catches packaging-level bugs that source-mode invocation
 * cannot, such as esbuild's "Dynamic require of ..." errors, missing
 * externals, or top-level-await issues.
 *
 * Run `pnpm build:lambda` first, or use the `invoke:bundle` script which
 * chains them together.
 *
 * Usage:
 *   node --env-file=../.env scripts/invoke-bundle.ts
 */

import { handler } from "../dist/index.mjs";

const result = await handler();
console.log(JSON.stringify(result, null, 2));
process.exit(result.statusCode === 200 ? 0 : 1);
