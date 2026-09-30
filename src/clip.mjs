import { createHash } from 'node:crypto';

// Public clip-tape bytes. SHA3-256, 0x-prefixed.
// Same rules as Hermes vbase_canon.py: sorted keys, no spaces, null object
// fields omitted, floats rounded to 8 decimal places and then written the way
// Python's json.dumps writes a float (1.0 stays "1.0").
//
// The hashed body is a fixed field set. entry_hash, vbase, and the genesis
// flag are stored beside the body and are not part of the content id.

export const CLIP_GENESIS_PREV_HASH = `0x${'00'.repeat(32)}`;
export const CLIP_GENESIS_DECISION_ID = 'hermes-genesis-0001';

export function asFloat(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error('non-finite float cannot be canonicalized');
  }
  return { __pyFloat: n };
}

function isFloat(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.__pyFloat === 'number';
}

function roundHalfEvenUnits(value) {
  if (!Number.isFinite(value)) {
    throw new Error('non-finite float cannot be canonicalized');
  }

  const negative = value < 0 || Object.is(value, -0);
  const scaled = Math.abs(value) * 1e8;
  const base = Math.floor(scaled + 1e-10);
  const fraction = scaled - base;
  let whole = base;

  if (fraction > 0.5) whole = base + 1;
  else if (fraction < 0.5) whole = base;
  else whole = base % 2 === 0 ? base : base + 1;

  return negative ? -whole : whole;
}

// Python json.dumps of a float that has already been rounded to 8 dp.
// Magnitudes in the clip tape are ordinary decimals. Very small and very
// large values follow Python's exponent form (1e-08, 1e+20).
export function formatPythonFloat(value) {
  if (Object.is(value, -0)) return '-0.0';

  const units = roundHalfEvenUnits(value);
  const negative = units < 0 || Object.is(units, -0);
  const abs = Math.abs(units);

  if (abs === 0) return negative ? '-0.0' : '0.0';

  const magnitude = abs / 1e8;
  if (magnitude >= 1e16 || magnitude < 1e-4) {
    const exp = Math.floor(Math.log10(magnitude));
    const coeff = magnitude / 10 ** exp;
    let coeffText = coeff.toPrecision(12).replace(/0+$/, '').replace(/\.$/, '');
    if (!coeffText.includes('.')) coeffText += '.0';
    const sign = exp < 0 ? '-' : '+';
    const body = `${coeffText}e${sign}${String(Math.abs(exp)).padStart(2, '0')}`;
    return negative ? `-${body}` : body;
  }

  const digits = String(abs).padStart(9, '0');
  const intPart = digits.slice(0, -8).replace(/^0+(?=\d)/, '') || '0';
  const frac = digits.slice(-8).replace(/0+$/, '') || '0';
  const body = `${intPart}.${frac}`;
  return negative ? `-${body}` : body;
}

function encode(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (isFloat(value)) return formatPythonFloat(value.__pyFloat);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('non-finite float cannot be canonicalized');
    }
    if (Number.isInteger(value)) return String(value);
    return formatPythonFloat(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item) ?? 'null').join(',')}]`;
  }
  if (typeof value === 'object') {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const encoded = encode(value[key]);
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export function canonicalBytes(value) {
  return encode(value);
}

export function sha3Cid(payload) {
  const bytes = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return `0x${createHash('sha3-256').update(bytes).digest('hex')}`;
}

function target(raw) {
  return {
    event: String(raw?.event ?? ''),
    side: String(raw?.side ?? ''),
    symbol: String(raw?.symbol ?? ''),
    weight: asFloat(raw?.weight ?? 0),
  };
}

export function isGenesisRecord(record) {
  return record?.decision_id === CLIP_GENESIS_DECISION_ID || record?.genesis === true;
}

export function publicBody(record) {
  const targets = Array.isArray(record?.targets) ? record.targets.map(target) : [];
  if (isGenesisRecord(record)) {
    return {
      decision_id: String(record.decision_id ?? ''),
      note: String(record.note ?? ''),
      prev_hash: String(record.prev_hash ?? CLIP_GENESIS_PREV_HASH),
      seq: Number(record.seq),
      targets,
      timestamp: String(record.timestamp ?? ''),
    };
  }

  return {
    decision_id: String(record.decision_id ?? ''),
    prev_hash: String(record.prev_hash ?? CLIP_GENESIS_PREV_HASH),
    private_hash: String(record.private_hash ?? ''),
    seq: Number(record.seq),
    targets,
    timestamp: String(record.timestamp ?? ''),
  };
}

export function hashPublicRecord(record) {
  const bytes = canonicalBytes(publicBody(record));
  return { bytes, cid: sha3Cid(bytes) };
}

export function verifyPublicTape(records) {
  const errors = [];
  let prev = CLIP_GENESIS_PREV_HASH;

  records.forEach((record, index) => {
    const position = index + 1;
    const hashed = hashPublicRecord(record);
    if (String(record.prev_hash ?? '') !== prev) {
      errors.push({
        index: position,
        decisionId: record.decision_id,
        field: 'prev_hash',
        stored: record.prev_hash ?? null,
        computed: prev,
      });
    }
    if (record.entry_hash && record.entry_hash !== hashed.cid) {
      errors.push({
        index: position,
        decisionId: record.decision_id,
        field: 'entry_hash',
        stored: record.entry_hash,
        computed: hashed.cid,
      });
    }
    prev = record.entry_hash || hashed.cid;
  });

  return {
    rows: records.length,
    head: prev,
    errors,
    ok: errors.length === 0,
  };
}
