/**
 * Renders `subgraph.template.yaml` into `subgraph.test.yaml` with the addresses of the
 * contracts a test deployed, so the mapping's `dataSource.context()` points at them.
 * `matchstick.yaml` and the Hardhat `matchstick` config both read this file.
 *
 * Run directly to render placeholder addresses, which is all `graph codegen` needs.
 */
import { readFileSync, writeFileSync } from "node:fs";

export const TEST_MANIFEST = new URL("../subgraph.test.yaml", import.meta.url);
const TEMPLATE = new URL("../subgraph.template.yaml", import.meta.url);

export interface ManifestVars {
  HASHPRICE_BTC_ADDRESS: string;
  HASHPRICE_USD_ADDRESS: string;
  BTC_USD_ADDRESS: string;
  HASHPRICE_START_BLOCK: bigint | number;
}

export function renderManifest(vars: ManifestVars): void {
  const values: Record<string, string> = { NETWORK: "base" };
  for (const [name, value] of Object.entries(vars)) values[name] = String(value);

  const rendered = readFileSync(TEMPLATE, "utf8").replace(/\$\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`subgraph.template.yaml uses unknown variable ${name}`);
    return value;
  });
  writeFileSync(TEST_MANIFEST, rendered);
}

if (import.meta.main) {
  const zero = "0x0000000000000000000000000000000000000000";
  renderManifest({
    HASHPRICE_BTC_ADDRESS: zero,
    HASHPRICE_USD_ADDRESS: zero,
    BTC_USD_ADDRESS: zero,
    HASHPRICE_START_BLOCK: 0,
  });
}
