// Paginate every collection in the local hashprice subgraph and dump each one
// into its own JSON file under contracts/seed/. Pagination is cursor-based on
// `timestamp` (rather than `skip`) to bypass graph-node's 5000-skip cap and
// scale to arbitrarily large datasets.
//
// Usage:
//   pnpm dump-subgraph
//
// Override the endpoint or output dir:
//   SUBGRAPH_URL=http://localhost:8000/subgraphs/name/hashprice \
//   OUT_DIR=./seed pnpm dump-subgraph

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SUBGRAPH_URL = process.env.SUBGRAPH_URL ?? "http://localhost:8000/subgraphs/name/hashprice";
const OUT_DIR = resolve(process.cwd(), process.env.OUT_DIR ?? "seed");
const PAGE_SIZE = 1000;

type Row = Record<string, unknown> & { timestamp: string };

interface CollectionSpec {
  /** GraphQL field name. */
  field: string;
  /** Space-separated selection set. */
  fields: string;
  /** Output filename (relative to OUT_DIR). */
  outFile: string;
  /** Optional `interval:` arg required for timeseries aggregation entities. */
  interval?: "hour" | "day" | "minute";
}

const COLLECTIONS: CollectionSpec[] = [
  { field: "btcUsds", fields: "id price timestamp", outFile: "btcUsds.json" },
  { field: "btcUsdCandles", fields: "id high low sum count timestamp", outFile: "btcUsdCandles-hour.json", interval: "hour" },
  { field: "btcUsdCandles", fields: "id high low sum count timestamp", outFile: "btcUsdCandles-day.json", interval: "day" },
  { field: "hashpriceBtcs", fields: "id price timestamp", outFile: "hashpriceBtcs.json" },
  { field: "hashpriceBtcCandles", fields: "id high low sum count timestamp", outFile: "hashpriceBtcCandles-hour.json", interval: "hour" },
  { field: "hashpriceBtcCandles", fields: "id high low sum count timestamp", outFile: "hashpriceBtcCandles-day.json", interval: "day" },
  { field: "hashpriceUsds", fields: "id price timestamp", outFile: "hashpriceUsds.json" },
  { field: "hashpriceUsdCandles", fields: "id high low sum count timestamp", outFile: "hashpriceUsdCandles-hour.json", interval: "hour" },
  { field: "hashpriceUsdCandles", fields: "id high low sum count timestamp", outFile: "hashpriceUsdCandles-day.json", interval: "day" },
];

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} from ${SUBGRAPH_URL}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) {
    throw new Error("GraphQL response missing data");
  }
  return body.data;
}

async function dumpCollection(spec: CollectionSpec): Promise<Row[]> {
  // Cursor on `timestamp_gt` lets us walk past graph-node's 5000-skip cap.
  // Two rows can share a timestamp (especially in candle aggregations), so we
  // also de-dupe by `id` to avoid double-counting at chunk boundaries.
  const intervalArg = spec.interval ? `interval: ${spec.interval}, ` : "";
  const query = `
    query Page($cursor: BigInt!, $first: Int!) {
      ${spec.field}(
        ${intervalArg}where: { timestamp_gte: $cursor }
        orderBy: timestamp
        orderDirection: asc
        first: $first
      ) { ${spec.fields} }
    }
  `;

  const out: Row[] = [];
  const seen = new Set<string>();
  let cursor = "0";
  let pageCount = 0;

  while (true) {
    const data = await gql<Record<string, Row[]>>(query, { cursor, first: PAGE_SIZE });
    const rows = data[spec.field] ?? [];
    pageCount++;

    let added = 0;
    for (const r of rows) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
      added++;
    }

    process.stdout.write(
      `\r  ${spec.field.padEnd(22)} page ${String(pageCount).padStart(3)}  +${String(added).padStart(4)}  total=${out.length}`,
    );

    if (rows.length < PAGE_SIZE) break;
    if (added === 0) {
      // Every row in this page was a duplicate — bump cursor past the last
      // timestamp to make forward progress instead of looping forever.
      cursor = String(BigInt(rows[rows.length - 1].timestamp) + 1n);
    } else {
      cursor = String(rows[rows.length - 1].timestamp);
    }
  }

  process.stdout.write("\n");
  return out;
}

async function main(): Promise<void> {
  console.log(`Dumping subgraph: ${SUBGRAPH_URL}`);
  console.log(`Output dir:       ${OUT_DIR}\n`);

  const meta = await gql<{ _meta: { block: { number: number }; hasIndexingErrors: boolean } }>(
    `{ _meta { block { number } hasIndexingErrors } }`,
    {},
  );
  console.log(`Subgraph at block ${meta._meta.block.number}, hasIndexingErrors=${meta._meta.hasIndexingErrors}\n`);

  mkdirSync(OUT_DIR, { recursive: true });

  for (const spec of COLLECTIONS) {
    const rows = await dumpCollection(spec);
    // Match the original query's desc-by-timestamp shape for downstream use.
    rows.sort((a, b) => Number(BigInt(b.timestamp) - BigInt(a.timestamp)));
    const path = resolve(OUT_DIR, spec.outFile);
    writeFileSync(path, JSON.stringify(rows, null, 2));
    console.log(`  → wrote ${rows.length.toLocaleString()} rows to ${path}\n`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
