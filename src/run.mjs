import { readFile } from 'node:fs/promises';

import { findAnchor, verifyAnchorContinuity } from './anchor.mjs';
import { verifyPublicTape } from './clip.mjs';
import { findLedgerRow, LEDGER_GENESIS_PREV_HASH, verifyLedger } from './ledger.mjs';
import { confirmStamps, fetchCid, fetchUserStamps, PRIVATE_COLLECTION, PUBLIC_COLLECTION } from './vbase.mjs';

export const DEFAULT_LEDGER_URL = 'https://www.solace.fyi/api/hermes/decision-ledger';
export const DEFAULT_ANCHOR_URL = 'https://www.solace.fyi/api/anchor';

const LABEL = 18;

function field(label, value) {
  return `${label.padEnd(LABEL)}${value}`;
}

function section(title, lines) {
  return [title, ...lines.filter((line) => line !== null && line !== undefined)];
}

async function readJson(source) {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const response = await fetch(source, {
      headers: { accept: 'application/json', 'user-agent': 'solace-verify' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`${source} returned ${response.status} ${response.statusText}.`);
    }
    return response.json();
  }

  return JSON.parse(await readFile(source, 'utf8'));
}

function classLine(classes) {
  const order = ['sealed', 'backfill', 'system', 'unclassified'];
  return order
    .filter((key) => classes[key])
    .map((key) => `${key} ${classes[key]}`)
    .join(' · ');
}

function ledgerSection(source, result, rowFocus) {
  const lines = [
    field('Source', source),
    field('Chain traversal', `${result.rows} rows`),
    field('Genesis prev', result.genesisPrevHash),
    field('Head hash', result.head),
    field('Rows verified', `${result.verifiedRows} / ${result.rows}`),
  ];

  const classes = classLine(result.classes);
  if (classes) lines.push(field('Classes', classes));
  if (result.unhashed) lines.push(field('Unhashed', String(result.unhashed)));

  if (rowFocus) {
    const match = result.errors.find((error) => error.recordId === rowFocus.row.recordId);
    lines.push(field('Row', rowFocus.row.recordId));
    lines.push(field('Row index', String(rowFocus.index)));
    lines.push(field('Row check', match ? 'mismatch' : 'matches'));
  }

  if (result.errors.length) {
    const first = result.errors[0];
    lines.push(field('Mismatch at', `row ${first.index} (${first.recordId})`));
    lines.push(field('Field', first.field));
    if (first.detail && first.field === 'ref') {
      lines.push(field('Detail', first.detail));
    } else {
      lines.push(field('Stored', first.stored ?? 'null'));
      lines.push(field('Computed', first.computed ?? 'null'));
    }
    lines.push(field('Result', `FAILED — chain broken at row ${first.index}`));
  } else {
    lines.push(field('Result', 'VERIFIED'));
  }

  return { ok: result.errors.length === 0, lines: section('Decision ledger', lines) };
}

function anchorSection(source, chain, ledgerHead, ledgerHashes) {
  const lines = [field('Source', source), field('Anchors', String(chain.anchors.length))];

  if (!chain.anchors.length) {
    lines.push(field('Result', 'FAILED — no anchors published'));
    return { ok: false, lines: section('Anchor chain', lines) };
  }

  lines.push(field('Continuity', chain.ok ? 'continuous' : `${chain.breaks.length} break(s)`));
  lines.push(field('Latest anchor', chain.head.date));
  lines.push(field('Anchor head', chain.head.chainHead));
  lines.push(field('Row number', String(chain.head.rowNumber)));

  const headInLedger = ledgerHashes.has(chain.head.chainHead.toLowerCase());
  lines.push(field('Anchor in ledger', headInLedger ? 'yes' : 'no'));

  if (ledgerHead === chain.head.chainHead) {
    lines.push(field('Live head', 'matches the anchor head'));
  } else {
    lines.push(field('Live head', 'is later than the latest anchor'));
  }

  if (!chain.ok) {
    lines.push(field('Break', chain.breaks[0].reason));
    lines.push(field('Result', 'FAILED — anchor chain is not continuous'));
  } else if (!headInLedger) {
    lines.push(field('Result', 'FAILED — anchor head is not a ledger row hash'));
  } else {
    lines.push(field('Result', 'VERIFIED'));
  }

  return {
    ok: chain.ok && headInLedger,
    lines: section('Anchor chain', lines),
  };
}

function collectionCount(record, name) {
  const match = record.collections.find((item) => item.collection_name === name);
  return match ? Number(match.count) : record.receipts.filter((item) => item.collectionName === name).length;
}

function vbaseSection(record, checks, focusCid) {
  const failed = checks.filter((item) => !item.ok);
  const lookupFailed = failed.filter((item) => item.kind === 'lookup');
  const mismatched = failed.filter((item) => item.kind !== 'lookup');
  const contract = checks.find((item) => item.contract)?.contract ?? '';
  const confirmed = checks.length - failed.length;
  const lines = [];

  if (focusCid) {
    const match = checks.find((item) => item.receipt.objectCid.toLowerCase() === focusCid.toLowerCase());
    lines.push(field('Content id', focusCid));
    lines.push(field('Collection', match?.receipt.collectionName || 'not published'));
    lines.push(field('Address', match?.receipt.userAddress || record.address));
    if (match?.receipt.timestamp) lines.push(field('Stamped', match.receipt.timestamp));
    if (match?.receipt.transactionHash) lines.push(field('Transaction', match.receipt.transactionHash));
  } else {
    lines.push(field('User', record.userName));
    lines.push(field('Address', record.address));
    lines.push(field('Public book', `${PUBLIC_COLLECTION}, ${collectionCount(record, PUBLIC_COLLECTION)} stamps`));
    lines.push(
      field('Private book', `${PRIVATE_COLLECTION}, ${collectionCount(record, PRIVATE_COLLECTION)} stamps, content id only`),
    );
  }

  lines.push(field('Polygon', `${confirmed} / ${checks.length} transactions include the content id`));
  if (contract) lines.push(field('Contract', contract));

  if (!checks.length) {
    lines.push(field('Result', 'FAILED — no stamps published'));
    return { ok: false, unavailable: false, lines: section('vBase', lines) };
  }

  if (mismatched.length) {
    const first = mismatched[0];
    lines.push(field('Mismatch at', first.receipt.objectCid));
    lines.push(field('Detail', first.reason));
    lines.push(field('Result', 'FAILED — a stamp is not in its Polygon transaction'));
    return { ok: false, unavailable: false, lines: section('vBase', lines) };
  }

  if (lookupFailed.length) {
    lines.push(field('Detail', `Polygon did not answer for ${lookupFailed.length} transaction(s).`));
    lines.push(field('Result', 'FAILED — Polygon lookup did not finish'));
    return { ok: false, unavailable: true, lines: section('vBase', lines) };
  }

  lines.push(field('Result', 'VERIFIED'));
  return { ok: true, unavailable: false, lines: section('vBase', lines) };
}

function tapeSection(result) {
  const lines = [
    field('Rows', String(result.rows)),
    field('Head', result.head),
  ];

  if (result.errors.length) {
    const first = result.errors[0];
    lines.push(field('Mismatch at', `row ${first.index} (${first.decisionId})`));
    lines.push(field('Field', first.field));
    lines.push(field('Stored', first.stored ?? 'null'));
    lines.push(field('Computed', first.computed ?? 'null'));
    lines.push(field('Result', `FAILED — public tape broken at row ${first.index}`));
  } else {
    lines.push(field('Result', 'VERIFIED'));
  }

  return { ok: result.ok, lines: section('Public tape', lines) };
}

function parseArgs(argv) {
  const options = {
    ledger: DEFAULT_LEDGER_URL,
    anchors: DEFAULT_ANCHOR_URL,
    row: null,
    anchor: null,
    tape: null,
    user: 'Solace',
    ledgerSet: false,
    anchorsSet: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--row') {
      options.row = next ?? '';
      i += 1;
    } else if (arg === '--anchor') {
      options.anchor = next ?? '';
      i += 1;
    } else if (arg === '--ledger') {
      options.ledger = next ?? '';
      options.ledgerSet = true;
      i += 1;
    } else if (arg === '--anchors') {
      options.anchors = next ?? '';
      options.anchorsSet = true;
      i += 1;
    } else if (arg === '--tape') {
      options.tape = next ?? '';
      i += 1;
    } else if (arg === '--user') {
      options.user = next ?? 'Solace';
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument ${arg}.`);
    }
  }

  return options;
}

function helpText() {
  return [
    'Usage',
    '  npm run verify',
    '  npm run verify -- --row HMS-T-32730541',
    '  npm run verify -- --anchor <chain-head>',
    '  npm run verify -- --anchor <vbase-content-id>',
    '',
    'A chain head is 64 hex characters. A vBase content id is 0x followed by 64 hex characters.',
    '',
    '  --ledger <url-or-file>    Decision ledger JSON. Default: the live ledger.',
    '  --anchors <url-or-file>   Anchor index JSON. Default: the live anchor index.',
    '  --tape <file.jsonl>       Public clip tape. Recomputes each content id.',
    '  --user <name>             vBase user. Default: Solace.',
  ].join('\n');
}

function isContentId(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function isChainHead(value) {
  return /^[0-9a-fA-F]{64}$/.test(value.trim());
}

export async function run(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return { code: 2, text: error.message };
  }

  if (options.help) return { code: 0, text: helpText() };

  const blocks = [];
  let ok = true;
  let unavailable = false;

  const ledgerIsRemote = options.ledger.startsWith('http://') || options.ledger.startsWith('https://');
  const full = !options.row && !options.anchor;
  const focusedCid = Boolean(options.anchor && isContentId(options.anchor));
  const focusedHead = Boolean(options.anchor && !focusedCid);
  const wantLedger = full || Boolean(options.row) || focusedHead || options.ledgerSet;
  const wantAnchors = (full && ledgerIsRemote) || focusedHead || options.anchorsSet;
  const wantVbase = (full && ledgerIsRemote) || focusedCid;
  const showLedger = !focusedHead || options.ledgerSet;

  let ledgerResult = null;
  let ledgerHashes = new Set();

  if (wantLedger || (options.anchor && isChainHead(options.anchor))) {
    try {
      const payload = await readJson(options.ledger);
      const rows = Array.isArray(payload) ? payload : payload.rows;
      if (!Array.isArray(rows)) {
        throw new Error('Ledger JSON has no rows array.');
      }
      const genesis = payload.chain?.genesisPrevHash ?? LEDGER_GENESIS_PREV_HASH;
      ledgerResult = verifyLedger(rows, genesis);
      ledgerHashes = new Set(rows.map((row) => String(row.rowHash ?? '').toLowerCase()).filter(Boolean));

      let rowFocus;
      if (options.row) {
        rowFocus = findLedgerRow(rows, options.row);
        if (!rowFocus) {
          blocks.push(
            section('Decision ledger', [
              field('Source', options.ledger),
              field('Row', options.row),
              field('Result', 'FAILED — row is not in the ledger'),
            ]),
          );
          ok = false;
        }
      }

      if (showLedger && !(options.row && !rowFocus)) {
        const sectionResult = ledgerSection(options.ledger, ledgerResult, options.row ? rowFocus : undefined);
        if (options.row && rowFocus && ledgerResult.errors.some((error) => error.recordId === options.row)) {
          sectionResult.ok = false;
        }
        blocks.push(sectionResult.lines);
        ok &&= sectionResult.ok;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ledger fetch failed.';
      blocks.push(section('Decision ledger', [field('Source', options.ledger), field('Result', `FAILED — ${message}`)]));
      ok = false;
      unavailable = true;
    }
  }

  if (wantAnchors) {
    try {
      const payload = await readJson(options.anchors);
      const list = Array.isArray(payload) ? payload : payload.anchors ?? payload.recent ?? [];
      const chain = verifyAnchorContinuity(list);

      if (options.anchor && isChainHead(options.anchor)) {
        const found = findAnchor(chain.anchors, options.anchor);
        const inLedger = ledgerHashes.has(options.anchor.trim().toLowerCase());
        const lines = [
          field('Source', options.anchors),
          field('Chain head', options.anchor.trim()),
          field('In anchors', found ? `yes, ${found.date}, row ${found.rowNumber}` : 'no'),
          field('In ledger', inLedger ? 'yes' : 'no'),
          field('Continuity', chain.ok ? 'continuous' : `${chain.breaks.length} break(s)`),
          field('Result', found && inLedger && chain.ok ? 'VERIFIED' : 'FAILED — anchor was not found'),
        ];
        blocks.push(section('Anchor chain', lines));
        ok &&= Boolean(found && inLedger && chain.ok);
      } else if (ledgerResult) {
        const sectionResult = anchorSection(options.anchors, chain, ledgerResult.head, ledgerHashes);
        blocks.push(sectionResult.lines);
        ok &&= sectionResult.ok;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Anchor fetch failed.';
      blocks.push(section('Anchor chain', [field('Source', options.anchors), field('Result', `FAILED — ${message}`)]));
      ok = false;
      unavailable = true;
    }
  }

  if (wantVbase) {
    try {
      if (options.anchor && isContentId(options.anchor)) {
        const receipt = await fetchCid(options.anchor.trim());
        if (!receipt) {
          blocks.push(
            section('vBase', [
              field('Content id', options.anchor.trim()),
              field('Result', 'FAILED — no stamp for this content id'),
            ]),
          );
          ok = false;
        } else {
          const [check] = await confirmStamps([receipt]);
          const record = {
            userName: 'Solace',
            address: receipt.userAddress,
            collections: receipt.collectionName ? [{ collection_name: receipt.collectionName, count: 1 }] : [],
            receipts: [receipt],
          };
          const sectionResult = vbaseSection(record, [check], options.anchor.trim());
          blocks.push(sectionResult.lines);
          ok &&= sectionResult.ok;
          unavailable ||= sectionResult.unavailable;
        }
      } else {
        const record = await fetchUserStamps(options.user);
        const checks = await confirmStamps(record.receipts);
        const sectionResult = vbaseSection(record, checks, null);
        blocks.push(sectionResult.lines);
        ok &&= sectionResult.ok;
        unavailable ||= sectionResult.unavailable;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'vBase lookup failed.';
      blocks.push(section('vBase', [field('Result', `FAILED — ${message}`)]));
      ok = false;
      unavailable = true;
    }
  }

  if (options.tape) {
    try {
      const text = await readFile(options.tape, 'utf8');
      const records = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const sectionResult = tapeSection(verifyPublicTape(records));
      blocks.push(sectionResult.lines);
      ok &&= sectionResult.ok;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tape read failed.';
      blocks.push(section('Public tape', [field('Result', `FAILED — ${message}`)]));
      ok = false;
    }
  }

  const overall = ok ? 'VERIFIED' : 'FAILED';
  const text = [...blocks.map((lines) => lines.join('\n')), field('Result', overall)].join('\n\n');
  const integrityFailure = text.includes('chain broken') || text.includes('not in its Polygon') || text.includes('not a ledger') || text.includes('not continuous') || text.includes('was not found') || text.includes('is not in the ledger') || text.includes('no stamp');
  return { code: ok ? 0 : unavailable && !integrityFailure ? 2 : 1, text };
}
