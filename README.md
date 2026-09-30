# Solace Verification Layer

Independent verification of the Solace decision ledger.

Hermes writes each decision to a hash-chained ledger. Solace also publishes snapshots of the chain head. Separately, Hermes stamps opens and flattens on Polygon through vBase. Those stamps are a second record. They are not one stamp per ledger row. This repository recomputes the ledger hashes and reads the Polygon transactions.

The rows are served by Solace. The stamp index is served by vBase. The transaction bytes are read from Polygon. Publishing this code means a reader can check the hashing and the chain walk instead of trusting a closed program.

## What this verifies

- **Row integrity.** Each ledger row has a SHA-256 hash. The hash covers the decision, the note, the posture, the previous row's hash, the record id, and the sealed time.
- **Chain integrity.** The rows are a single chain. Editing, removing, or inserting a row breaks the chain at that row.
- **Resolution integrity.** When a row has an outcome and a resolution hash, that hash covers the outcome, the profit or loss to two decimals, the resolved time, and the row hash.
- **Chain-head snapshots.** Solace publishes snapshots of the chain head. Each snapshot names the previous head. The head is a ledger row hash.
- **vBase stamps.** The public book and the private book are stamped on Polygon. This tool reads the public stamp index, then reads each transaction from Polygon. The transaction must contain the content id, the collection id, and the stamper address.

## What this does not verify

- The engine, the strategy, or the trading logic
- Whether any decision was the right decision
- Whether the record made money
- The private clip bytes. Those stamps are content ids only. This repository cannot recompute them.
- That every ledger row has a vBase stamp. The ledger and the clip tape are different records.

Verification of integrity is not verification of judgment. This tool confirms the published record has not been altered. It does not confirm the record is good.

These fields are stored on a ledger row and are not part of the row hash: row class, event type, ref, and Hermes version. A close that names an open must name an earlier open. A close written before that link existed does not fail the check.

## Install

```bash
git clone https://github.com/Solacefyi/solace-verify.git
cd solace-verify
npm install
```

Requires Node 20 or newer. The tool has no dependencies.

## Usage

Verify the live ledger, the published chain-head snapshots, and the vBase stamps:

```bash
npm run verify
```

Verify one ledger row. The walk still starts at the first row, because that is how the row's previous hash is known:

```bash
npm run verify -- --row HMS-T-32730541
```

Verify one chain head. A chain head is 64 hex characters and has no `0x` prefix:

```bash
npm run verify -- --anchor 7abc7e7f878dc82af6fd936353bf8b502f458440342f8eb841d080b2b8e59c12
```

Verify one vBase content id. A content id is `0x` plus 64 hex characters:

```bash
npm run verify -- --anchor 0x0dfd758433ff842069a1788fd019ce422bc432cc37b45f1b4c1feb28ca1c68ba
```

Recompute the public clip tape from a local file, one JSON object per line:

```bash
npm run verify -- --tape public.jsonl
```

The public tape is not downloaded by this tool. Without the file, the vBase check shows that each content id is inside a Polygon transaction. With the file, the tool also recomputes each public content id from the bytes.

## What success looks like

Counts move as Hermes seals decisions. This is the output of one live run:

```
Decision ledger
Source            https://www.solace.fyi/api/hermes/decision-ledger
Chain traversal   670 rows
Genesis prev      GENESIS
Head hash         653ab3336830df4630b374fae3e2fbfeac138241e9346c063c33614ff67ff9fa
Rows verified     670 / 670
Classes           sealed 660 · backfill 9 · system 1
Result            VERIFIED

Anchor chain
Source            https://www.solace.fyi/api/anchor
Anchors           189
Continuity        continuous
Latest anchor     2026-09-29T09:01:04.062Z
Anchor head       7abc7e7f878dc82af6fd936353bf8b502f458440342f8eb841d080b2b8e59c12
Row number        667
Anchor in ledger  yes
Live head         is later than the latest anchor
Result            VERIFIED

vBase
User              Solace
Address           0xc7f6A73D3450c5F7035e63A73D232c055EDa79fB
Public book       Hermes Public Book, 42 stamps
Private book      Hermes Private Book, 41 stamps, content id only
Polygon           83 / 83 transactions include the content id
Contract          0x80d2ab15ee5b91cd7a183b8938dc277fe6191f7d
Result            VERIFIED

Result            VERIFIED
```

The process exits 0.

`Live head is later than the latest anchor` means decisions have been sealed since the newest published snapshot. That is not a broken chain. The snapshot head is still a row hash in the ledger.

The private book line says `content id only` because those bytes are not published.

## What failure looks like

```
Decision ledger
Source            examples/broken-ledger.json
Chain traversal   2 rows
Genesis prev      GENESIS
Head hash         0000000000000000000000000000000000000000000000000000000000000000
Rows verified     1 / 2
Classes           sealed 2
Mismatch at       row 2 (HMS-2)
Field             row_hash
Stored            0000000000000000000000000000000000000000000000000000000000000000
Computed          c8767d5346ed4ca0901499463828860f305cf46278faa287a0f2d0d9f9c85fb5
Result            FAILED — chain broken at row 2

Result            FAILED
```

A broken chain means a published row does not hash to the hash stored on it. The process exits 1. If a source cannot be read, the process exits 2.

The sample above is `examples/broken-ledger.json`:

```bash
npm run verify -- --ledger examples/broken-ledger.json
```

## How the ledger hash works

The first row's previous hash is the string `GENESIS`. It is not a hex digest.

```
row_hash = SHA-256(utf8(JSON.stringify({
  decision,
  note,
  posture,
  prev_hash,
  record_id,
  sealed_at
})))
```

`sealed_at` is `new Date(value).toISOString()`. The keys are in the order above. They are not sorted.

```
resolution_hash = SHA-256(utf8(JSON.stringify({
  outcome,
  pnl,
  resolved_at,
  row_hash
})))
```

`pnl` is `null`, or the number written with two decimal places (`1.25`, `-0.50`). The resolution hash uses the stored row hash.

After a hashed row, the next row's previous hash is the stored row hash.

## How a chain-head snapshot works

Each snapshot records the ledger head, the time, the row count, and the previous snapshot's head. The first snapshot's previous head is null. Every later snapshot must name the head of the snapshot before it.

The snapshot is published by Solace. It is not the Polygon stamp.

## How a vBase stamp works

A public clip is SHA3-256 of canonical JSON, written as `0x` plus 64 hex characters.

Canonical JSON has sorted keys, no spaces, and no null object fields. Floats are rounded to 8 decimal places and written the way Python's `json.dumps` writes a float, so `1.0` stays `1.0`.

The first public record's previous hash is 32 zero bytes, `0x` plus 64 zeros. Each later record's previous hash is the previous record's content id.

A public record hashes these fields:

- Genesis: `decision_id`, `note`, `prev_hash`, `seq`, `targets`, `timestamp`
- Later rows: `decision_id`, `prev_hash`, `private_hash`, `seq`, `targets`, `timestamp`

`entry_hash` and the vBase receipt are stored beside the body. They are not inside the hash. `private_hash` is the content id of the private record. This repository does not contain the private record.

The public collection is `Hermes Public Book`. The private collection is `Hermes Private Book`. The stamper address on the current record is `0xc7f6A73D3450c5F7035e63A73D232c055EDa79fB`. The transactions are on Polygon, chain id 137.

This repository does not create stamps and does not read an API key.

## Scope

This repository contains:

- The ledger hashing functions
- The public clip hashing function
- The chain walks
- The vBase lookup and the Polygon transaction check
- The command-line tool

It does not contain:

- The engine
- The signal logic
- The consumer application
- Customer data
- API keys or the stamping key

The verification layer is the part that should be inspectable. The engine is the part that should not be.

## License

MIT
