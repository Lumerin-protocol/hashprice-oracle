# Futures Subgraph

This subgraph indexes the Futures contract and HashrateOracle contract to track positions, orders, and hashrate data.

## Hashprice chart reorg limitation

`HashpriceBtc` is append-only. After a Bitcoin reorg, corrected values are added alongside
the values originally published for the displaced chain. The native `hashpriceBtcCandles`
aggregation counts both, so its sum/count average is publication history rather than a strictly
canonical Bitcoin-chain average. Catch-up batches also place multiple updates at the same EVM
timestamp, giving those transactions proportionally more weight in a candle.

A future canonical chart implementation should deduplicate raw `hashpriceBtcs` by
`confirmedHeight` before constructing candles. This is intentionally not implemented yet.

## Entities

### Futures Contract Entities

- **Participant**: Tracks users who create positions or orders

  - `id`: Participant address
  - `positions`: Array of position IDs
  - `orders`: Array of order IDs
  - `positionCount`: Number of positions
  - `orderCount`: Number of orders
  - `totalVolume`: Total volume traded

- **Position**: Tracks individual futures positions

  - `id`: Position ID (bytes32)
  - `participant`: Participant who created the position
  - `price`: Position price
  - `deliveryDate`: Delivery date for the position
  - `isBuy`: Whether this is a buy (long) or sell (short) position
  - `timestamp`: When the position was created
  - `isActive`: Whether the position is still active
  - `closedAt`: When the position was closed (if closed)
  - `closedBy`: Who closed the position

- **Order**: Tracks futures orders between participants
  - `id`: Order ID (bytes32)
  - `seller`: Seller participant
  - `buyer`: Buyer participant
  - `price`: Order price
  - `startTime`: When the order starts
  - `timestamp`: When the order was created
  - `isActive`: Whether the order is still active
  - `closedAt`: When the order was closed (if closed)
  - `closedBy`: Who closed the order

### HashrateOracle Timeseries Entities

- **HashesForBTC**: Tracks updates to the hashes per BTC value

  - `id`: Unique identifier (block number + log index)
  - `value`: Number of hashes required per BTC
  - `updatedAt`: When the value was updated
  - `ttl`: Time-to-live for the value
  - `blockNumber`: Block number of the update
  - `transactionHash`: Transaction hash

- **HashesForToken**: Tracks calculated hashes per token values
  - `id`: Unique identifier (block number + log index)
  - `value`: Calculated hashes per token value
  - `calculatedAt`: When the calculation was performed
  - `blockNumber`: Block number
  - `transactionHash`: Transaction hash
  - `btcPrice`: BTC price at time of calculation
  - `hashesForBTC`: Hashes per BTC value used in calculation

## Event Handlers

### Futures Contract Events

1. **Initialized**: Creates the root Futures entity when the contract is initialized
2. **PositionCreated**: Creates a new position entity and updates participant stats
3. **PositionClosed**: Marks a position as closed and updates stats
4. **OrderCreated**: Creates a new order entity and updates participant stats
5. **OrderClosed**: Marks an order as closed and updates stats

### HashrateOracle Events

1. **Initialized**: Initializes contract instance and creates initial timeseries data point
2. **HashesForBTCUpdated**: Creates a new HashesForBTC entity and collects comprehensive hashrate data
3. **Block Handler**: Collects hashrate data on every block for comprehensive timeseries coverage

## Timeseries Collection

The subgraph collects timeseries data for `hashesForBTC` and `hashesForToken` using multiple approaches:

1. **Event-based Collection**: Data is collected when `HashesForBTCUpdated` events are emitted
2. **Block-based Collection**: Data is collected on every block to ensure comprehensive coverage
3. **Futures Event Integration**: Data is collected when Futures contract events occur

This multi-layered approach ensures we have a complete historical record of hashrate calculations and their relationship to market activity.

## Configuration

The subgraph is configured in `subgraph.template.yaml` with:

- Futures contract address and ABI
- HashrateOracle contract address and ABI
- Event handlers for all relevant events

## Usage

1. Deploy the subgraph using the template configuration
2. The subgraph will automatically index all Futures and HashrateOracle events
3. Query the entities to get position, order, and hashrate data
4. Use the timeseries data to analyze hashrate trends over time

## Versioning and deploys

`deploy-subgraph.yml` runs the unit and integration tests, then deploys, on changes to the source,
schema, manifest template, package files, tests, `contracts/` sources, ABIs or `config/`,
as `v<package.json version>-<env>-<commit>` (git tag `indexer-v<version>-<env>-<commit>`). Consumers query the rolling tag (`dev-latest`,
`lmn-latest`), which the workflow moves to the new version.

- **Same compiled build** as the previous version (comments and docs don't count): nothing
  is deployed. The build hash is stored in the git tag.
- **Same major**: grafts onto the environment's previous version, keeping its history, and
  moves the tag once it has caught up. The schema must stay graft-compatible (see
  [Graft-compatible schema changes](#graft-compatible-schema-changes)), else the deploy fails.
- **Major bump**: full redeploy from the manifest's start blocks; the tag stays on the old
  version until a manual run with `promote=<version>` once it has synced. History from
  contracts no longer in the manifest (the pre-reset `HashpriceBTC`) is lost.
- **Manual run**: `graft_from` deploys even if unchanged, from `<name>/<version>` or, with
  `none`, from the start blocks.

A graft starts at the base's latest block, not at a chosen one: Goldsky prunes history.
A handler fix therefore applies only from the graft onwards; rewriting old rows needs a
major bump, or a one-time rewrite by the first handler after the graft. Versions are never
deleted.

Oracle events emitted before the graft block are never indexed. Graft onto a new
`HashpriceBTC` while the keeper still feeds the old one, then switch the keeper: if the new
oracle accepts heights first, they are missing from `BtcBlock`. Since v3.7.0 a gap of fewer
than 2,016 heights is bridged: its work follows from the neighbouring blocks' `nBits`, and
the median time past of the 10 blocks after it is approximate (`medianTimeApproximate`), as
are the hashrate rows whose window starts or ends on one of them (`exact: false`).

### Graft-compatible schema changes

A graft copies every row of the base as it is and runs handlers only from the graft block,
so the schema may only grow: new entity types and new nullable fields. Removing or retyping
a field or type, making a field required, or changing an entity's `immutable` flag fails
the deploy. Changes that need more go through a compatible form until the next major:

- **New required field**: add it nullable. Rows copied from the base have no value; every
  row indexed since does. Comment the field `# Nullable for graft compatibility with
  v<base>.` so the cleanup can find it. Consumers must treat it as optional until then.
- **Row describing current state** (contract addresses, decimals) that a graft copies
  stale, e.g. after a graft onto new contracts: an immutable row can't be rewritten, and
  the flag can't be changed. Add a mutable successor type, `<Name>V2 @entity(immutable:
  false)`, as a singleton the handler rewrites whenever its data source names different
  contracts. Mark the old type deprecated in a schema comment, stop writing it, and move
  consumers to the successor once an indexer with it is deployed.

  The successor is mutable because it describes the present, not history: immutable rows
  are write-once, so each change would append a row and every reader would have to find
  the newest one. A mutable singleton is updated in place and read by its fixed id; the
  block-range versioning a mutable entity costs is negligible for one row. Event and
  timeseries entities stay immutable.

**Cleanup**: a major bump redeploys from scratch with no base to stay compatible with, so do
the cleanup in the same release: delete deprecated types and make the compatibility-nullable
fields required again, then update consumers that guarded against the missing values.
Keep the `V2` names; renaming them back breaks every consumer. Currently outstanding:

- `BtcBlock`: `blockHash`, `coinbaseValue`, `fees`, `target`, `difficulty` and
  `impliedHashrateHpS` are nullable for grafts from v3.3.4.
- `HashpriceMeta`: deprecated by `HashpriceMetaV2` in v3.6.0.
- `NetworkHashrate1d`, `NetworkHashrate7d`: `exact` is nullable for grafts from v3.6.0.
  `BtcBlock.medianTimeApproximate` stays nullable (null with `medianTime`).

## Example Queries

```graphql
# Get all active positions
{
  positions(where: { isActive: true }) {
    id
    participant
    price
    deliveryDate
    isBuy
  }
}

# Get hashrate timeseries data
{
  hashesForTokens(orderBy: calculatedAt, orderDirection: desc, first: 100) {
    value
    calculatedAt
    btcPrice
    hashesForBTC
  }
}

# Get participant activity
{
  participants {
    id
    positionCount
    orderCount
    totalVolume
  }
}
```
