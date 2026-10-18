// Claus Shifts · Launch Watch server (pilot). MIT. No dependencies, no keys, no wallet, no disk.
// Reads Ethereum through public RPC, finds new launches (Programmable's launch router, and any Uniswap v4
// pool paired with CLAUS), X-rays each one at a pinned block, and watches it for 14 days against five fixed
// triggers. Everything is served as public JSON. Claus Shifts' managed runtime copies the compact checkpoint
// and each alert into public records; on restart the server reloads the newest checkpoint and re-scans from
// its block, so a restart delays checks but never skips blocks. Spec: claus.si/c/claus-shifts/pages/launch-watch.html

export const C = {
  PM: '0x000000000004444c5dc75cb358380d2e3de08a90',
  STATEVIEW: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227',
  ROUTER: '0xbe4bf6ac8c6f012e1c8f25747a9fbccb2fdac4c3',
  CLAUS: '0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8',
  WELL_KNOWN: ['0x0000000000000000000000000000000000000000', '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f', '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'],
  T_STAMP: '0x6cf479a102f1eebc9244f48f8d68f6aa52b4c5a4516318df58ba46614a5b14f2', // ProgrammableLaunchStampedV1(launchId, token, hook, poolManager, poolId, stampHash)
  T_INIT: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',  // Uniswap v4 Initialize
  T_MOD: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',   // Uniswap v4 ModifyLiquidity
  T_OWNER: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0', // OwnershipTransferred
  T_UPGRADED: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', // EIP-1967 Upgraded
  T_ADMIN: '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f',    // EIP-1967 AdminChanged
  T_TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  SLOT_IMPL: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  SLOT_ADMIN: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  ZERO32: '0x' + '0'.repeat(64),
  WATCH_SECONDS: 14 * 86400,
  MAX_RANGE: 2000,   // blocks per cycle; after an outage the server catches up in steps of this size
  MAX_WATCHED: 25,   // keeps RPC use bounded; the checkpoint is paged so each page fits one runtime record
  PAGE: 9,           // pools per checkpoint page (each page stays under the runtime's 4,000-character web read)
  BASE_BLOCKS: 50,   // the baseline window: liquidity provided within 50 blocks (~10 min) of the launch is L0; later changes are counted
  KEEP_CLOSED: 2 * 86400, // a closed window stays in state this long so its coverage report can be copied out
  FEE_EVERY: 12,     // cycles between slot0 fee reads (12 x 5 min = hourly)
  RETRIES: 6         // consecutive failures of one range (30 min) before it is recorded as a gap and skipped
};
const Z = '0x' + '0'.repeat(40);
export const addr = h => '0x' + String(h).slice(-40).toLowerCase();
const hex = n => '0x' + BigInt(n).toString(16);
const sint = (h, bits) => BigInt.asIntN(bits, BigInt('0x' + h)).toString();
const str = h => { try { const x = h.slice(2); if (x.length < 128) return ''; const len = parseInt(x.slice(64, 128), 16); return decodeURIComponent(x.slice(128, 128 + len * 2).replace(/../g, '%$&')).slice(0, 40); } catch { return ''; } };
const TRIGGERS = ['liquidity', 'owner', 'upgrade', 'mint', 'fee'];

// ---------- RPC with per-method call counts (the pilot budget is computed from these counters) ----------
export function makeRpc(urls, fetchImpl = fetch, counts = {}) {
  let id = 1;
  return async function rpc(method, params) {
    let last;
    for (let i = 0; i < urls.length * 2; i++) {
      const url = urls[i % urls.length];
      try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(15000) });
        counts[method] = (counts[method] || 0) + 1;
        const j = await r.json();
        if (j && j.result !== undefined && !j.error) return j.result;
        last = new Error(method + ': ' + JSON.stringify(j && j.error || j).slice(0, 120));
      } catch (e) { last = e; }
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
    throw last;
  };
}

// ---------- X-ray at one block B (same fields as the launches records) ----------
export async function xray(rpc, l, block) {
  const B = hex(block), call = (to, data) => rpc('eth_call', [{ to, data }, B]);
  const couldNotCheck = [], tryRead = async (label, f) => { try { return await f(); } catch { couldNotCheck.push(label); return null; } };
  const symbol = await tryRead('token symbol()', async () => str(await call(l.token, '0x95d89b41')));
  const supply = await tryRead('token totalSupply()', async () => BigInt(await call(l.token, '0x18160ddd')).toString());
  let owner = '', hasOwner = false;
  try { const o = await call(l.token, '0x8da5cb5b'); if (o && o.length >= 66) { owner = addr(o); hasOwner = true; } } catch { /* no owner() is a fact, not a failure */ }
  const impl = await tryRead('EIP-1967 implementation slot', async () => addr(await rpc('eth_getStorageAt', [l.token, C.SLOT_IMPL, B])));
  const admin = await tryRead('EIP-1967 admin slot', async () => addr(await rpc('eth_getStorageAt', [l.token, C.SLOT_ADMIN, B])));
  const s0 = await tryRead('pool slot0', async () => slot0Fee(await call(C.STATEVIEW, '0xc815641c' + l.poolId.slice(2))));
  couldNotCheck.push('hook buy/sell fee values (no standard getter)');
  return { token: l.token, symbol: symbol || '', poolId: l.poolId, hook: l.hook, source: l.source, launchTx: l.tx, launchBlock: l.block, block,
    supply: supply || '', owner, hasOwner, proxyImpl: impl && impl !== Z ? impl : '', proxyAdmin: admin && admin !== Z ? admin : '',
    lpFee: s0 === null ? -1 : s0, couldNotCheck };
}
// StateView.getSlot0 returns four words; the LP fee is the fourth. A short or malformed reply (some public nodes
// answer "0x") is a failed read, never a fee of 0.
function slot0Fee(h) {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]{256,}$/.test(h)) throw new Error('malformed slot0 reply');
  return parseInt(h.slice(194, 258), 16);
}

// ---------- State. `checkpoint()` is the compact form copied into a public record; `restore()` reads it back. ----------
export function emptyState(lastBlock) { return { v: 1, lastBlock, cycles: 0, lastAt: 0, pools: [], seen: [], alerts: [], gaps: [], xrays: [] }; }
// One pool is one comma-joined string (the network's record schema allows arrays of one type only; strings keep it small).
const enc = p => [p.poolId.slice(2), p.token.slice(2), p.symbol.replace(/[,|]/g, '').slice(0, 12), p.startBlock, p.baseBlock, p.untilAt, p.L0, p.added, p.removed, p.lpFee, p.fired, p.ok, p.failed, p.closed ? 1 : 0].join(',');
const dec = t => { const a = t.split(','); return { poolId: '0x' + a[0], token: '0x' + a[1], symbol: a[2], startBlock: +a[3], baseBlock: +a[4], untilAt: +a[5], L0: a[6], added: a[7], removed: a[8], lpFee: +a[9], fired: +a[10], ok: +a[11], failed: +a[12], closed: a[13] === '1' }; };
export function checkpoint(s, page = 0) {
  const pages = Math.max(1, Math.ceil(s.pools.length / C.PAGE));
  return { v: 1, lastBlock: s.lastBlock, lastAt: s.lastAt, cycles: s.cycles, page, pages,
    pools: s.pools.slice(page * C.PAGE, (page + 1) * C.PAGE).map(enc),
    gaps: page === 0 ? s.gaps.slice(-8).map(g => [g.kind, g.from, g.to].join(',')) : [] };
}
// Restore only from a COMPLETE set: every page 0..pages-1 of one snapshot (one lastBlock, one page count). The newest
// complete set wins; an incomplete newer set is skipped, never partly used, so a missing page cannot drop watched
// pools. Re-scanning from an older complete set is safe: alerts keep their keys, so nothing is copied twice.
// Returns null when no complete set exists (the server then cold-starts and states the gap).
export function restore(pages) {
  // `pages` must be newest first. Pages are re-copied many times; the newest copy of each page in a set is used.
  const blocks = [...new Set(pages.map(p => p.lastBlock))].sort((a, b) => b - a);
  for (const top of blocks) {
    const set = pages.filter(p => p.lastBlock === top), n = set[0].pages || 1, use = new Map();
    if (set.some(p => (p.pages || 1) !== n)) continue;            // two different snapshots at one block: not a set
    for (const p of set) if (Number.isInteger(p.page) && p.page >= 0 && p.page < n && !use.has(p.page)) use.set(p.page, p);
    if (use.size !== n) continue;                                    // a page is missing: skip the whole set
    const ordered = [...use.values()].sort((a, b) => a.page - b.page), s = emptyState(top);
    s.lastAt = ordered[0].lastAt || 0; s.cycles = ordered[0].cycles || 0;
    s.gaps = (ordered[0].gaps || []).map(g => { const a = g.split(','); return { kind: a[0], from: +a[1], to: +a[2] }; });
    s.pools = ordered.flatMap(p => p.pools.map(dec));
    s.seen = s.pools.map(p => p.poolId);
    return s;
  }
  return null;
}
// A frozen copy of the state for checkpointing. The runtime copies one page per read, hours apart, while the server
// keeps scanning; serving every page of one set from the same snapshot is what makes a complete set possible.
function snapshot(s) { return { lastBlock: s.lastBlock, lastAt: s.lastAt, cycles: s.cycles, gaps: s.gaps.map(g => ({ ...g })), pools: s.pools.map(p => ({ ...p })) }; }

// ---------- One cycle over the block range (lastBlock, to] ----------
export async function cycle(rpc, s, log = () => {}) {
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const from = s.lastBlock + 1, to = Math.min(head, s.lastBlock + C.MAX_RANGE);
  if (to < from) return { head, idle: true };
  const range = { fromBlock: hex(from), toBlock: hex(to) };
  const at = parseInt((await rpc('eth_getBlockByNumber', [hex(to), false])).timestamp, 16);
  const W = l => '0x' + l.slice(2).padStart(64, '0');

  // 1. Read everything for the range first; change nothing unless every query succeeded. A failing range is
  //    retried whole on the next cycle (late, never skipped); only after RETRIES failures is it recorded as a gap.
  let stamps, mods, owns, ups, mints, found = [], live;
  try {
    stamps = await rpc('eth_getLogs', [{ address: C.ROUTER, ...range, topics: [C.T_STAMP] }]);
    for (const l of stamps) found.push({ token: addr(l.topics[2]), hook: addr(l.topics[3]), poolId: '0x' + l.data.slice(2).slice(64, 128), tx: l.transactionHash, block: parseInt(l.blockNumber, 16), source: 'programmable' });
    for (const pos of [2, 3]) {
      const topics = [C.T_INIT, null, null, null]; topics[pos] = W(C.CLAUS);
      for (const l of await rpc('eth_getLogs', [{ address: C.PM, ...range, topics }])) {
        const other = addr(l.topics[pos === 2 ? 3 : 2]);
        if (!C.WELL_KNOWN.includes(other)) found.push({ token: other, hook: addr(l.data.slice(2).slice(128, 192)), poolId: l.topics[1], tx: l.transactionHash, block: parseInt(l.blockNumber, 16), source: 'claus-pair' });
      }
    }
    found = found.filter((f, i) => !s.seen.includes(f.poolId) && found.findIndex(g => g.poolId === f.poolId) === i);
    const room = Math.max(0, C.MAX_WATCHED - s.pools.filter(p => !p.closed).length);
    live = [...s.pools.filter(p => !p.closed), ...found.slice(0, room).map(f => ({ poolId: f.poolId, token: f.token, startBlock: f.block }))];
    if (live.length) {
      const tokens = live.map(p => p.token), pools = live.map(p => p.poolId);
      mods = await rpc('eth_getLogs', [{ ...range, address: C.PM, topics: [C.T_MOD, pools] }]);
      owns = await rpc('eth_getLogs', [{ ...range, address: tokens, topics: [C.T_OWNER] }]);
      ups = await rpc('eth_getLogs', [{ ...range, address: tokens, topics: [[C.T_UPGRADED, C.T_ADMIN]] }]);
      mints = await rpc('eth_getLogs', [{ ...range, address: tokens, topics: [C.T_TRANSFER, C.ZERO32] }]);
    }
    s.retries = 0;
  } catch (e) {
    s.retries = (s.retries || 0) + 1;
    log('range ' + from + '-' + to + ' failed (' + s.retries + '/' + C.RETRIES + '): ' + e.message);
    if (s.retries < C.RETRIES) throw e;
    s.gaps.push({ kind: 'all', from, to }); s.pools.filter(p => !p.closed).forEach(p => p.failed++);
    s.retries = 0; s.lastBlock = to; s.lastAt = at; s.cycles++;
    return { head, from, to, gap: true, behind: head - to };
  }

  // 2. Apply: X-ray and start watching new launches, then evaluate the five triggers.
  for (const f of found) {
    s.seen.push(f.poolId); if (s.seen.length > 500) s.seen.splice(0, s.seen.length - 500);
    const x = await xray(rpc, f, head); // pinned to the head: public nodes serve contract state for recent blocks only
    s.xrays.push(x); if (s.xrays.length > 50) s.xrays.shift();
    log('launch ' + (x.symbol || '?') + ' ' + x.token + ' via ' + f.source);
    if (live.some(p => p.poolId === f.poolId))
      s.pools.push({ poolId: f.poolId, token: f.token, symbol: x.symbol || '?', startBlock: f.block, baseBlock: f.block + C.BASE_BLOCKS, untilAt: at + C.WATCH_SECONDS, L0: '0', added: '0', removed: '0', lpFee: x.lpFee, fired: 0, ok: 0, failed: 0, closed: false });
    else s.gaps.push({ kind: 'capacity', token: f.token, from: f.block, to: f.block });
  }
  live = s.pools.filter(p => !p.closed);
  if (live.length) {
    for (const p of live) {
      const after = l => parseInt(l.blockNumber, 16) > p.baseBlock; // events inside the baseline window (launch block + 50) are baseline, not alerts; the window is fixed, so a catch-up after an outage cannot widen it
      for (const l of mods.filter(m => m.topics[1] === p.poolId)) {
        const x = BigInt.asIntN(256, BigInt('0x' + l.data.slice(2).slice(128, 192)));
        // Liquidity provided inside the baseline window is L0; everything after counts toward net removals.
        if (!after(l)) p.L0 = (BigInt(p.L0) + x).toString();
        else if (x > 0n) p.added = (BigInt(p.added) + x).toString(); else p.removed = (BigInt(p.removed) - x).toString();
      }
      const L0 = BigInt(p.L0), net = BigInt(p.removed) - BigInt(p.added);
      if (L0 > 0n && net * 4n >= L0 && !(p.fired & 1)) { p.fired |= 1; alert(s, p, 'liquidity', 'Net removals since the X-ray reached ' + (Number(net * 1000n / L0) / 10) + '% of baseline liquidity L0', mods.filter(m => m.topics[1] === p.poolId).at(-1), at); }
      for (const l of owns.filter(m => addr(m.address) === p.token && after(m))) { p.fired |= 2; alert(s, p, 'owner', 'Owner changed to ' + addr(l.topics[2]), l, at); }
      for (const l of ups.filter(m => addr(m.address) === p.token && after(m))) { p.fired |= 4; alert(s, p, 'upgrade', (l.topics[0] === C.T_UPGRADED ? 'Implementation upgraded to ' + addr(l.topics[1]) : 'Proxy admin changed to ' + addr(l.data)), l, at); }
      for (const l of mints.filter(m => addr(m.address) === p.token && after(m))) { p.fired |= 8; alert(s, p, 'mint', 'Mint of ' + BigInt(l.data).toString() + ' base units to ' + addr(l.topics[2]), l, at); }
      p.ok++;
    }
    if (s.cycles % C.FEE_EVERY === 0) for (const p of live) {
      try {
        const s0 = await rpc('eth_call', [{ to: C.STATEVIEW, data: '0xc815641c' + p.poolId.slice(2) }, hex(head)]);
        const fee = slot0Fee(s0);
        if (!(p.lpFee >= 0)) p.lpFee = fee;                     // the X-ray could not read it: the first good read is the baseline
        else if (fee !== p.lpFee) { p.fired |= 16; alert(s, p, 'fee', 'Pool LP fee changed from ' + p.lpFee + ' to ' + fee + ' pips', null, at, head); p.lpFee = fee; }
      } catch { s.gaps.push({ kind: 'fee', token: p.token, from: head, to: head }); }
    }
    for (const p of live) if (at >= p.untilAt) { p.closed = true; log('window closed ' + p.symbol + ': coverage report due'); }
  }
  s.pools = s.pools.filter(p => !p.closed || at < p.untilAt + C.KEEP_CLOSED);
  s.lastBlock = to; s.lastAt = at; s.cycles++;
  if (s.alerts.length > 100) s.alerts.splice(0, s.alerts.length - 100);
  if (s.gaps.length > 100) s.gaps.splice(0, s.gaps.length - 100);
  return { head, from, to, found: found.length, live: live.length, behind: head - to };
}

// Each alert has a stable key (block, kind, token) so a re-scan after a restart re-finds the same key and the
// runtime's copy cursor never duplicates it.
function alert(s, p, kind, line, l, at, blockIfNoLog = 0) {
  const block = l ? parseInt(l.blockNumber, 16) : blockIfNoLog;
  const key = String(block).padStart(10, '0') + ':' + kind + ':' + p.token.slice(2); // the full address: vanity tokens can share a long prefix
  if (s.alerts.some(a => a.key === key)) return;
  s.alerts.push({ key, kind, token: p.token, symbol: p.symbol, poolId: p.poolId, line: line.slice(0, 300), tx: l ? l.transactionHash : '', block, at });
  s.alerts.sort((a, b) => (a.key < b.key ? -1 : 1));
}
// What the managed runtime copies next: the oldest alert after its cursor, else one checkpoint page. Under 4,000 characters.
// Page 0 starts a new snapshot; pages 1..n-1 come from that same snapshot. If the server restarted mid-set there is no
// snapshot for that set, so a fresh one is taken: that set is incomplete and restore() skips it.
export function bridge(s, after = '', page = 0) {
  const alert = s.alerts.find(a => a.key > after) || null;
  if (alert) return { alert, checkpoint: null };
  if (page === 0 || !s.snap) s.snap = snapshot(s);
  return { alert: null, checkpoint: checkpoint(s.snap, page) };
}

// ---------- Coverage report (spec: delivered after the 14 days, alerts or not) ----------
export function coverage(s, p) {
  const gaps = s.gaps.filter(g => !g.token || g.token === p.token);
  return { token: p.token, symbol: p.symbol, poolId: p.poolId, startBlock: p.startBlock, baseBlock: p.baseBlock, untilAt: p.untilAt, closed: p.closed,
    checks: { completeCycles: p.ok, failedQueries: p.failed }, gaps, fired: TRIGGERS.filter((t, i) => p.fired & (1 << i)),
    liquidity: { baselineL0: p.L0, addedAfter: p.added, removedAfter: p.removed }, lpFee: p.lpFee };
}
