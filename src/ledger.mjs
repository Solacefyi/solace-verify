import { createHash } from 'node:crypto';

// Byte-identical to features/hermes-ledger/hash.ts.
// Timestamps go through Date#toISOString. Resolution pnl is a two-decimal
// string, or null. Key order is the order written below, not alphabetical.
// row_class, event_type, ref, and hermes_version are not hashed.

export const LEDGER_GENESIS_PREV_HASH = 'GENESIS';

export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalTimestamp(value) {
  return new Date(value).toISOString();
}

export function computeLedgerRowHash(input) {
  return sha256Hex(
    JSON.stringify({
      decision: input.decision,
      note: input.note,
      posture: input.posture,
      prev_hash: input.prevHash,
      record_id: input.recordId,
      sealed_at: canonicalTimestamp(input.sealedAt),
    }),
  );
}

export function computeLedgerResolutionHash(input) {
  return sha256Hex(
    JSON.stringify({
      outcome: input.outcome,
      pnl: input.pnl === null || input.pnl === undefined ? null : Number(input.pnl).toFixed(2),
      resolved_at: canonicalTimestamp(input.resolvedAt),
      row_hash: input.rowHash,
    }),
  );
}

function classKey(row) {
  return row.rowClass ?? 'unclassified';
}

/**
 * Walk rows in published order.
 * A null rowHash is a row sealed before the chain existed: it is reported,
 * not failed, and the running prev becomes the hash those fields would have.
 * After a hashed row, the running prev is the stored rowHash.
 */
export function verifyLedger(rows, genesisPrevHash = LEDGER_GENESIS_PREV_HASH) {
  let prevHash = genesisPrevHash || LEDGER_GENESIS_PREV_HASH;
  const errors = [];
  const classes = { sealed: 0, backfill: 0, system: 0, unclassified: 0 };
  const openRows = new Map();
  const voidedOpens = new Set();
  let unhashed = 0;
  let verifiedRows = 0;

  rows.forEach((row, index) => {
    const position = index + 1;
    const key = classKey(row);
    classes[key] = (classes[key] ?? 0) + 1;
    const rowErrors = [];

    if (row.eventType === 'open') {
      openRows.set(row.recordId, row);
    }

    if ((row.eventType === 'close' || row.eventType === 'void') && row.ref) {
      if (!openRows.has(row.ref)) {
        rowErrors.push({
          index: position,
          recordId: row.recordId,
          field: 'ref',
          stored: row.ref,
          computed: null,
          detail: `ref ${row.ref} does not match any earlier open row`,
        });
      } else if (row.eventType === 'void') {
        voidedOpens.add(row.ref);
      } else {
        openRows.delete(row.ref);
      }
    }

    const expectedRowHash = computeLedgerRowHash({
      decision: row.decision,
      note: row.note,
      posture: row.posture,
      prevHash,
      recordId: row.recordId,
      sealedAt: row.sealedAt,
    });

    if (row.rowHash == null) {
      unhashed += 1;
      prevHash = expectedRowHash;
      if (rowErrors.length) errors.push(...rowErrors);
      else verifiedRows += 1;
      return;
    }

    if (row.prevHash !== prevHash) {
      rowErrors.push({
        index: position,
        recordId: row.recordId,
        field: 'prev_hash',
        stored: row.prevHash,
        computed: prevHash,
        detail: 'prev_hash does not match the previous row',
      });
    }

    if (row.rowHash !== expectedRowHash) {
      rowErrors.push({
        index: position,
        recordId: row.recordId,
        field: 'row_hash',
        stored: row.rowHash,
        computed: expectedRowHash,
        detail: 'row_hash does not match the sealed fields',
      });
    }

    if (row.outcome !== null && row.outcome !== undefined && row.resolutionHash) {
      const expectedResolutionHash = computeLedgerResolutionHash({
        outcome: row.outcome,
        pnl: row.pnl,
        resolvedAt: row.resolvedAt,
        rowHash: row.rowHash,
      });

      if (row.resolutionHash !== expectedResolutionHash) {
        rowErrors.push({
          index: position,
          recordId: row.recordId,
          field: 'resolution_hash',
          stored: row.resolutionHash,
          computed: expectedResolutionHash,
          detail: 'resolution_hash does not match the outcome or pnl',
        });
      }
    }

    if (rowErrors.length === 0) {
      verifiedRows += 1;
    } else {
      errors.push(...rowErrors);
    }

    prevHash = row.rowHash;
  });

  const unresolvedOpens = [...openRows.keys()].filter((id) => !voidedOpens.has(id));

  return {
    rows: rows.length,
    verifiedRows,
    unhashed,
    head: prevHash,
    genesisPrevHash: genesisPrevHash || LEDGER_GENESIS_PREV_HASH,
    classes,
    unresolvedOpens,
    errors,
  };
}

export function findLedgerRow(rows, recordId) {
  const index = rows.findIndex((row) => row.recordId === recordId);
  if (index === -1) return null;
  return { index: index + 1, row: rows[index] };
}
