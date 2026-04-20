/**
 * Invokes the Lambda handler from source against the local environment.
 *
 * Mirrors what AWS Lambda does at runtime (single handler() call) without
 * any bundling, so iteration is fast. For an end-to-end check against the
 * actual deploy artifact, use invoke-bundle.ts instead.
 *
 * Usage:
 *   node --env-file=../.env scripts/invoke-lambda.ts
 */

import { handler } from "../src/adapters/lambda.ts";

const result = await handler();
console.log(JSON.stringify(result, null, 2));
process.exit(result.statusCode === 200 ? 0 : 1);
