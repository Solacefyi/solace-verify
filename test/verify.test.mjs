import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyAnchorContinuity } from '../src/anchor.mjs';
import { canonicalBytes, hashPublicRecord, sha3Cid } from '../src/clip.mjs';
import {
  computeLedgerResolutionHash,
  computeLedgerRowHash,
  verifyLedger,
} from '../src/ledger.mjs';
import { run } from '../src/run.mjs';

test('ledger row hash matches the pinned SHA-256 vector', () => {
  const hash = computeLedgerRowHash({
    decision: 'hold',
    note: 'example',
    posture: 'FLAT',
    prevHash: 'GENESIS',
    recordId: 'HMS-1',
    sealedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(hash, '5d251627765c49d96872533cca9de50cc58a2651329a83cf8849bf653c083c4b');
});

test('resolution hash uses a two-decimal pnl string', () => {
  const rowHash = '5d251627765c49d96872533cca9de50cc58a2651329a83cf8849bf653c083c4b';
  const hash = computeLedgerResolutionHash({
    outcome: 'win',
    pnl: 1.25,
    resolvedAt: '2026-01-02T00:00:00.000Z',
    rowHash,
  });

  assert.equal(hash, '6212252d6cdce71cb87688c50a721ed89b83fe49f134146153c89994996a6264');
});

test('a two-row chain verifies and a changed field breaks the second row', () => {
  const first = {
    recordId: 'HMS-1',
    sealedAt: '2026-01-01T00:00:00.000Z',
    decision: 'hold',
    posture: 'FLAT',
    note: 'example',
    outcome: null,
    pnl: null,
    prevHash: 'GENESIS',
    rowHash: null,
    resolutionHash: null,
  };
  first.rowHash = computeLedgerRowHash({ ...first, prevHash: 'GENESIS' });

  const second = {
    recordId: 'HMS-2',
    sealedAt: '2026-01-02T00:00:00.000Z',
    decision: 'flatten',
    posture: 'FLAT',
    note: 'example',
    outcome: 'win',
    pnl: 1.5,
    resolvedAt: '2026-01-02T00:00:00.000Z',
    prevHash: first.rowHash,
    rowHash: null,
    resolutionHash: null,
  };
  second.rowHash = computeLedgerRowHash({ ...second, prevHash: first.rowHash });
  second.resolutionHash = computeLedgerResolutionHash({
    outcome: second.outcome,
    pnl: second.pnl,
    resolvedAt: second.resolvedAt,
    rowHash: second.rowHash,
  });

  const ok = verifyLedger([first, second]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.verifiedRows, 2);
  assert.equal(ok.head, second.rowHash);

  const broken = verifyLedger([first, { ...second, note: 'changed' }]);
  assert.equal(broken.errors[0].field, 'row_hash');
  assert.equal(broken.errors[0].recordId, 'HMS-2');
  assert.equal(broken.verifiedRows, 1);
});

test('public clip bytes match the Python canonical form', () => {
  const record = {
    decision_id: 'hermes-example-0002',
    seq: 2,
    timestamp: '2026-01-01T00:01:00.000Z',
    targets: [{ symbol: 'BTC-USDT', side: 'LONG', event: 'open', weight: 0.20222992438910795 }],
    private_hash: `0x${'ab'.repeat(32)}`,
    prev_hash: `0x${'11'.repeat(32)}`,
    entry_hash: 'ignored',
    vbase: { tx: 'no' },
  };

  const hashed = hashPublicRecord(record);
  assert.equal(
    hashed.bytes,
    '{"decision_id":"hermes-example-0002","prev_hash":"0x1111111111111111111111111111111111111111111111111111111111111111","private_hash":"0xabababababababababababababababababababababababababababababababab","seq":2,"targets":[{"event":"open","side":"LONG","symbol":"BTC-USDT","weight":0.20222992}],"timestamp":"2026-01-01T00:01:00.000Z"}',
  );
  assert.equal(hashed.cid, '0xe00aa8babd36ea2caa35c2adb64ad1231d5515f915248422f1192fc9bb860fa3');
  assert.equal(sha3Cid(hashed.bytes), hashed.cid);
});

test('canonical form drops nulls, sorts keys, and keeps whole floats', () => {
  assert.equal(canonicalBytes({ b: null, a: 1, c: 'x' }), '{"a":1,"c":"x"}');
  assert.equal(canonicalBytes({ weight: { __pyFloat: 1 } }), '{"weight":1.0}');
});

test('anchor continuity requires a null genesis link', () => {
  const head = 'a'.repeat(64);
  const next = 'b'.repeat(64);
  const ok = verifyAnchorContinuity([
    {
      date: '2026-01-02T00:00:00Z',
      chainHead: next,
      rowNumber: 2,
      sealedAt: '2026-01-02T00:00:00Z',
      previousAnchor: head,
      sourceUrl: 'https://solace.fyi/anchor/2',
    },
    {
      date: '2026-01-01',
      chainHead: head,
      rowNumber: 1,
      sealedAt: '2026-01-01T00:00:00Z',
      previousAnchor: null,
      sourceUrl: 'https://solace.fyi/anchor/1',
    },
  ]);

  assert.equal(ok.ok, true);
  assert.equal(ok.head.chainHead, next);

  const broken = verifyAnchorContinuity([
    {
      date: '2026-01-01',
      chain_head: head,
      row_number: 1,
      sealed_at: '2026-01-01T00:00:00Z',
      previous_anchor: next,
      source_url: 'https://solace.fyi/anchor/1',
    },
  ]);

  assert.equal(broken.ok, false);
  assert.match(broken.breaks[0].reason, /previous_anchor must be null/);
});

test('the broken example exits 1 and names the row', async () => {
  const { code, text } = await run(['--ledger', new URL('../examples/broken-ledger.json', import.meta.url).pathname]);
  assert.equal(code, 1);
  assert.match(text, /HMS-2/);
  assert.match(text, /row_hash/);
  assert.match(text, /FAILED — chain broken at row 2/);
  assert.match(text, /^Result\s+FAILED$/m);
  assert.doesNotMatch(text, /vBase/);
});
