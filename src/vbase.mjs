// Read-only check of the public vBase record.
// The stamp index is the public verify page. Each content id is then read
// back from the Polygon transaction, so a stamp is not accepted on vBase's
// word alone. This file does not stamp and does not read an API key.

const VERIFY_PAGE = 'https://app.vbase.com/verify/user-data/';
const USER_OBJECTS = 'https://app.vbase.com/verify/find-user-objects/';
const VERIFY_CID = 'https://app.vbase.com/verify/cid/';

const POLYGON_RPCS = [
  'https://1rpc.io/matic',
  'https://polygon.llamarpc.com',
  'https://polygon-bor-rpc.publicnode.com',
];

export const PUBLIC_COLLECTION = 'Hermes Public Book';
export const PRIVATE_COLLECTION = 'Hermes Private Book';

async function session() {
  const page = await fetch(`${VERIFY_PAGE}?user=Solace`, {
    headers: { 'user-agent': 'solace-verify', accept: 'text/html' },
    signal: AbortSignal.timeout(30_000),
  });

  if (!page.ok) {
    throw new Error(`vBase verify page returned ${page.status}.`);
  }

  const html = await page.text();
  const token = html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/)?.[1];
  if (!token) {
    throw new Error('vBase verify page did not include a CSRF token.');
  }

  const setCookie = typeof page.headers.getSetCookie === 'function' ? page.headers.getSetCookie() : [];
  const cookie = setCookie.map((item) => item.split(';')[0]).join('; ');

  return { token, cookie };
}

async function postJson(url, body, auth) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': 'solace-verify',
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrftoken': auth.token,
      cookie: auth.cookie,
      referer: VERIFY_PAGE,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`vBase ${url} returned ${response.status}.`);
  }

  return JSON.parse(text);
}

export async function fetchUserStamps(userName = 'Solace') {
  const auth = await session();
  const payload = await postJson(USER_OBJECTS, { user_name: userName.toLowerCase() }, auth);
  const info = payload.user_info_data ?? {};
  const receipts = Array.isArray(payload.commitment_receipts_data) ? payload.commitment_receipts_data : [];

  return {
    userName: info.user_name ?? userName,
    address: info.user_address ?? '',
    collections: Array.isArray(payload.collection_data) ? payload.collection_data : [],
    receipts: receipts.map(readReceipt),
  };
}

export async function fetchCid(cid) {
  const auth = await session();
  const payload = await postJson(VERIFY_CID, { cids: [cid] }, auth);
  const stamp = payload.stamp_list?.[0];
  if (!stamp) return null;
  return readReceipt(stamp);
}

function readReceipt(raw) {
  return {
    objectCid: String(raw.objectCid ?? ''),
    setCid: String(raw.setCid ?? raw.collection_hash ?? ''),
    collectionName: String(raw.collection_name ?? ''),
    timestamp: String(raw.timestamp ?? ''),
    transactionHash: String(raw.transactionHash ?? ''),
    chainId: Number(raw.chainId),
    userAddress: String(raw.user_id ?? ''),
    blockExplorerUrl: `${raw.blockExplorerUrl ?? 'https://polygonscan.com/tx/'}${raw.transactionHash ?? ''}`,
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function polygonTransaction(hash) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const url of POLYGON_RPCS) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'solace-verify' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getTransactionByHash',
            params: [hash],
          }),
          signal: AbortSignal.timeout(12_000),
        });

        if (!response.ok) {
          lastError = new Error(`Polygon returned ${response.status}.`);
          continue;
        }

        const payload = await response.json();
        if (payload.error) {
          lastError = new Error(payload.error.message || 'Polygon RPC error.');
          continue;
        }

        if (payload.result) return payload.result;
        lastError = new Error('Polygon has no transaction with this hash.');
      } catch (error) {
        lastError = error;
      }
    }

    await wait(400 * (attempt + 1));
  }

  throw lastError ?? new Error('Polygon lookup failed.');
}

function hexIn(input, value) {
  const needle = value.trim().toLowerCase().replace(/^0x/, '');
  return needle.length > 0 && input.toLowerCase().includes(needle);
}

export async function confirmStampOnPolygon(receipt) {
  if (!receipt.transactionHash) {
    return { ok: false, kind: 'mismatch', reason: 'Stamp has no transaction hash.' };
  }

  if (receipt.chainId && receipt.chainId !== 137) {
    return { ok: false, kind: 'mismatch', reason: `Stamp is on chain ${receipt.chainId}, not Polygon.` };
  }

  const tx = await polygonTransaction(receipt.transactionHash);
  if (!tx) {
    return { ok: false, kind: 'mismatch', reason: 'Polygon has no transaction with this hash.' };
  }

  if (!tx.blockNumber) {
    return { ok: false, kind: 'mismatch', reason: 'Transaction is not mined.' };
  }

  const input = String(tx.input ?? '');
  if (!hexIn(input, receipt.objectCid)) {
    return { ok: false, kind: 'mismatch', reason: 'Transaction does not include the content id.' };
  }
  if (receipt.setCid && !hexIn(input, receipt.setCid)) {
    return { ok: false, kind: 'mismatch', reason: 'Transaction does not include the collection id.' };
  }
  if (receipt.userAddress && !hexIn(input, receipt.userAddress)) {
    return { ok: false, kind: 'mismatch', reason: 'Transaction does not include the stamper address.' };
  }

  return { ok: true, kind: 'match', contract: String(tx.to ?? ''), from: String(tx.from ?? '') };
}

export async function confirmStamps(receipts, limit = 2) {
  const results = new Array(receipts.length);
  let cursor = 0;

  async function worker() {
    while (cursor < receipts.length) {
      const index = cursor;
      cursor += 1;
      const receipt = receipts[index];
      try {
        results[index] = { receipt, ...(await confirmStampOnPolygon(receipt)) };
      } catch (error) {
        results[index] = {
          receipt,
          ok: false,
          kind: 'lookup',
          reason: error instanceof Error ? error.message : 'Polygon lookup failed.',
        };
      }
    }
  }

  const workers = Math.min(limit, receipts.length || 1);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  for (let index = 0; index < results.length; index += 1) {
    if (results[index]?.kind !== 'lookup') continue;
    try {
      results[index] = { receipt: receipts[index], ...(await confirmStampOnPolygon(receipts[index])) };
    } catch (error) {
      results[index] = {
        receipt: receipts[index],
        ok: false,
        kind: 'lookup',
        reason: error instanceof Error ? error.message : 'Polygon lookup failed.',
      };
    }
  }

  return results;
}
