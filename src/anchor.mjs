// Continuity of the published anchor files.
// Each anchor's previous_anchor must equal the previous anchor's chain_head.
// The chain_head is a decision-ledger row hash.

export function readAnchor(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Anchor record is not an object.');
  }

  const previous = raw.previousAnchor ?? raw.previous_anchor ?? null;

  return {
    date: String(raw.date ?? ''),
    chainHead: String(raw.chainHead ?? raw.chain_head ?? ''),
    rowNumber: Number(raw.rowNumber ?? raw.row_number),
    sealedAt: String(raw.sealedAt ?? raw.sealed_at ?? ''),
    previousAnchor: previous === null || previous === undefined || previous === '' ? null : String(previous),
    sourceUrl: String(raw.sourceUrl ?? raw.source_url ?? ''),
  };
}

function sortAnchors(a, b) {
  const byDate = a.date.localeCompare(b.date);
  if (byDate !== 0) return byDate;
  return a.sealedAt.localeCompare(b.sealedAt);
}

export function verifyAnchorContinuity(anchors) {
  const sorted = anchors.map(readAnchor).sort(sortAnchors);
  const breaks = [];

  for (let i = 0; i < sorted.length; i += 1) {
    const anchor = sorted[i];
    if (i === 0) {
      if (anchor.previousAnchor !== null) {
        breaks.push({
          index: i + 1,
          reason: `Genesis anchor ${anchor.date} has previous_anchor ${anchor.previousAnchor}. The first anchor's previous_anchor must be null.`,
        });
      }
      continue;
    }

    const prev = sorted[i - 1];
    if (anchor.previousAnchor !== prev.chainHead) {
      breaks.push({
        index: i + 1,
        reason: `Anchor ${anchor.date} previous_anchor does not equal the chain head sealed on ${prev.date}.`,
      });
    }
  }

  return {
    anchors: sorted,
    breaks,
    ok: breaks.length === 0 && sorted.length > 0,
    head: sorted.at(-1) ?? null,
  };
}

export function findAnchor(anchors, chainHead) {
  const wanted = chainHead.trim().toLowerCase();
  return anchors.find((anchor) => anchor.chainHead.toLowerCase() === wanted) ?? null;
}
