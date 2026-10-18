// Differential test: the Go server and the reviewed JS server run side by side, each against its own identical mock
// Ethereum node and checkpoint feed, through the same scenarios. Every public endpoint must return the same JSON.
// Usage: (cd server-go && CGO_ENABLED=0 go build -o /tmp/lw-server .) && node test/diff.test.mjs server /tmp/lw-server
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [JSDIR, GOBIN] = process.argv.slice(2).map(p => path.resolve(p));
const C = { PM: '0x000000000004444c5dc75cb358380d2e3de08a90', ROUTER: '0xbe4bf6ac8c6f012e1c8f25747a9fbccb2fdac4c3', CLAUS: '0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8',
  T_STAMP: '0x6cf479a102f1eebc9244f48f8d68f6aa52b4c5a4516318df58ba46614a5b14f2', T_INIT: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  T_MOD: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec', T_OWNER: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
  T_UPGRADED: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', T_ADMIN: '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f',
  T_TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ZERO32: '0x' + '0'.repeat(64) };
const W = a => '0x' + a.slice(2).padStart(64, '0'), H = n => '0x' + n.toString(16), int256 = v => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const LP = '0x' + 'dd'.repeat(20), HOOK = '0x' + 'cc'.repeat(20), WRITER = 'runtime_26f2ea55e7956c83237e03b3f53386ee37b44da53bd7ce28ff1f13e78a96eb56';
const M = v => '0x' + int256(-600) + int256(600) + int256(v) + '00'.repeat(32);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- one mock world per server (identical, so neither server's retries can disturb the other's) ----
function world() {
  const w = { logs: [], head: 999, failOwner: 0, failSlot0: 0, feeOf: {}, records: [], calls: 0 };
  w.add = (block, address, topics, data) => w.logs.push({ blockNumber: H(block), address, topics, data, transactionHash: '0x' + block.toString(16).padStart(64, '0') });
  const match = (l, f) => { const b = parseInt(l.blockNumber, 16); if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false;
    const as = Array.isArray(f.address) ? f.address : [f.address]; if (!as.includes(l.address)) return false;
    return (f.topics || []).every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : l.topics[i] === t)); };
  const rpc = (m, p) => {
    if (m === 'eth_blockNumber') return H(w.head);
    if (m === 'eth_getBlockByNumber') return { timestamp: H(1_800_000_000 + parseInt(p[0], 16) * 12), hash: '0x' + 'ee'.repeat(32) };
    if (m === 'eth_getLogs') { if (w.failOwner > 0 && p[0].topics[0] === C.T_OWNER) { w.failOwner--; throw new Error('rate limited'); } return w.logs.filter(l => match(l, p[0])); }
    if (m === 'eth_call') { const d = p[0].data;
      if (d.startsWith('0x95d89b41')) { const sym = { ['0x' + 'ab'.repeat(20)]: 'TEST', ['0x' + 'ef'.repeat(20)]: 'BÆR,X' }[p[0].to] || 'ZZ'; const b = Buffer.from(sym); return '0x' + '20'.padStart(64, '0') + b.length.toString(16).padStart(64, '0') + b.toString('hex').padEnd(64, '0'); }
      if (d.startsWith('0x8da5cb5b')) { if (p[0].to === '0x' + 'ef'.repeat(20)) throw new Error('execution reverted'); return W(LP); }
      if (d.startsWith('0x18160ddd')) return '0x' + (10n ** 27n).toString(16).padStart(64, '0');
      if (d.startsWith('0xc815641c')) { if (w.failSlot0 > 0) { w.failSlot0--; throw new Error('slot0 down'); } const fee = w.feeOf[d.slice(10)] || 0; return '0x' + '0'.repeat(64 * 3) + fee.toString(16).padStart(64, '0'); }
      return '0x' + '0'.repeat(64); }
    if (m === 'eth_getStorageAt') return p[1].startsWith('0x3608') && p[0] === '0x' + 'ef'.repeat(20) ? W('0x' + '77'.repeat(20)) : C.ZERO32;
    throw new Error('unexpected ' + m);
  };
  w.server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ items: w.records }));
      w.calls++; const j = JSON.parse(body);
      try { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: rpc(j.method, j.params) })); }
      catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: e.message } })); }
    });
  });
  return w;
}
const worlds = { js: world(), go: world() };
const both = f => { for (const w of Object.values(worlds)) f(w); };
const TOKEN = '0x' + 'ab'.repeat(20), POOL = '0x' + '11'.repeat(32), T2 = '0x' + 'ef'.repeat(20), P2 = '0x' + '22'.repeat(32);
both(w => {
  w.add(1005, C.ROUTER, [C.T_STAMP, '0x' + '99'.repeat(32), W(TOKEN), W(HOOK)], '0x' + '0'.repeat(24) + C.PM.slice(2) + POOL.slice(2) + '00'.repeat(32));
  w.add(1005, TOKEN, [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(10n ** 27n));
  w.add(1005, TOKEN, [C.T_OWNER, C.ZERO32, W(LP)], '0x');
  w.add(1005, C.PM, [C.T_MOD, POOL, W(LP)], M(1000));
  w.add(1030, C.PM, [C.T_MOD, POOL, W(LP)], M(200));        // inside the baseline window: L0 = 1200
  w.add(1500, C.PM, [C.T_MOD, POOL, W(LP)], M(100));
  w.add(1600, C.PM, [C.T_MOD, POOL, W(LP)], M(-340));
  w.add(2600, C.PM, [C.T_MOD, POOL, W(LP)], M(-120));       // net 360/1200 = 30% -> alert
  w.add(2700, TOKEN, [C.T_OWNER, W(LP), C.ZERO32], '0x');
  w.add(2800, TOKEN, [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(5));
  w.add(2850, TOKEN, [C.T_UPGRADED, W('0x' + '55'.repeat(20))], '0x');
  w.add(2860, TOKEN, [C.T_ADMIN], '0x' + '00'.repeat(12) + '44'.repeat(20) + '00'.repeat(12) + '66'.repeat(20));
  // a CLAUS pair launch (Initialize with CLAUS as currency1) with a tricky symbol and an upgradeable token, no owner()
  w.add(2900, C.PM, [C.T_INIT, P2, W(T2), W(C.CLAUS)], '0x' + int256(60) + int256(60) + '00'.repeat(12) + HOOK.slice(2) + '00'.repeat(64));
  // a WETH/CLAUS pool is ignored
  w.add(2950, C.PM, [C.T_INIT, '0x' + '33'.repeat(32), W(C.CLAUS), W('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')], '0x' + int256(60) + int256(60) + '00'.repeat(12) + HOOK.slice(2) + '00'.repeat(64));
});

// ---- servers ----
const procs = {}, ports = { js: 18601, go: 18602 }, mocks = { js: 18611, go: 18612 }, out = { js: [], go: [] };
const jsServer = path.join(JSDIR, '.diff-server.mjs');
fs.writeFileSync(jsServer, fs.readFileSync(path.join(JSDIR, 'server.mjs'), 'utf8')
  .replace(/const PORT = 8080;/, 'const PORT = +process.env.LW_PORT;')
  .replace(/const INTERVAL_MS = [^;]+;/, 'const INTERVAL_MS = +process.env.LW_INTERVAL_MS;')
  .replace(/const RPCS = \[[^\]]+\];/, "const RPCS = process.env.LW_RPCS.split(',');")
  .replace(/const CHECKPOINTS = '[^']+';/, 'const CHECKPOINTS = process.env.LW_CHECKPOINTS;'));
function startServer(k) {
  const env = { ...process.env, LW_PORT: String(ports[k]), LW_INTERVAL_MS: '250', LW_RPCS: 'http://127.0.0.1:' + mocks[k], LW_CHECKPOINTS: 'http://127.0.0.1:' + mocks[k] + '/records' };
  procs[k] = k === 'js' ? spawn(process.execPath, [jsServer], { env }) : spawn(GOBIN, [], { env });
  procs[k].stdout.on('data', d => out[k].push(String(d))); procs[k].stderr.on('data', d => out[k].push(String(d)));
}
const stop = async k => { procs[k].kill('SIGKILL'); await sleep(200); };
const get = async (k, p) => { const r = await fetch('http://127.0.0.1:' + ports[k] + p); return { status: r.status, json: await r.json() }; };
async function waitFor(pred, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await pred()) return true; } catch {} await sleep(150); } return false; }
const atBlock = n => waitFor(async () => { for (const k of ['js', 'go']) { const h = await get(k, '/health'); if (h.json.lastBlock !== n) return false; } await sleep(700); return true; });

let fails = 0;
const ok = (n, c, extra) => { if (!c) { fails++; console.log('FAIL', n, extra ? JSON.stringify(extra).slice(0, 1500) : ''); } else console.log('ok  ', n); };
// Key order carries no meaning in JSON; everything else (values, types, nulls, missing keys, array order) must match.
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
// eth_blockNumber counts idle head checks, which depend on each server's own timer, not on logic: excluded. Every other call count must match.
const norm = j => canon(JSON.parse(JSON.stringify(j, (k, v) => (k === 'boot' ? { from: v.from } : k === 'rpcCalls' ? { ...v, eth_blockNumber: 'timer-dependent' } : v))));
async function same(label, p) {
  const a = await get('js', p), b = await get('go', p);
  const A = JSON.stringify(norm(a.json)), B = JSON.stringify(norm(b.json));
  ok(label + ' ' + p, a.status === b.status && A === B, a.status !== b.status ? { js: a.status, go: b.status } : diffAt(A, B));
  return a.json;
}
const diffAt = (A, B) => { let i = 0; while (i < A.length && A[i] === B[i]) i++; return { at: i, js: A.slice(Math.max(0, i - 120), i + 200), go: B.slice(Math.max(0, i - 120), i + 200) }; };
async function compareAll(label) {
  const st = await same(label, '/state.json');
  await same(label, '/coverage.json');
  await same(label, '/health');
  const pages = Math.max(1, Math.ceil(st.pools.length / 9));
  for (let p = 0; p < pages; p++) await same(label, '/checkpoint.json?page=' + p);
  // walk the bridge the way the runtime does: alerts by cursor, then checkpoint pages
  let after = '';
  for (let i = 0; i < 12; i++) { const j = await same(label + ' bridge', '/bridge.json?after=' + encodeURIComponent(after) + '&page=0'); if (!j.alert) break; after = j.alert.key; }
  for (let p = 0; p < pages; p++) await same(label + ' bridge', '/bridge.json?after=' + encodeURIComponent(after) + '&page=' + p);
  return st;
}

for (const k of ['js', 'go']) await new Promise(r => worlds[k].server.listen(mocks[k], r));
try {
  for (const k of ['js', 'go']) startServer(k);
  ok('both cold-start at 999', await atBlock(999), out);
  await compareAll('cold start');
  both(w => { w.failOwner = 2; w.head = 3000; });      // first catch-up read fails once (both tries), then succeeds
  ok('both reach 3000 after a retried range', await atBlock(3000), out);
  const st = await compareAll('after launches');
  ok('scenario sanity: 2 pools, liquidity+owner+mint+upgrade+admin alerts, WETH pair ignored', st.pools.length === 2 && ['liquidity', 'owner', 'mint', 'upgrade'].every(k => st.alerts.some(a => a.kind === k)) && st.alerts.filter(a => a.kind === 'upgrade').length === 2 && !st.pools.some(p => p.poolId === '0x' + '33'.repeat(32)), st.alerts.map(a => a.key));
  both(w => { w.feeOf[POOL.slice(2)] = 3000; w.add(3500, C.PM, [C.T_MOD, POOL, W(LP)], M(-10)); w.head = 4000; });
  ok('both reach 4000', await atBlock(4000));
  await compareAll('after more blocks');
  // walk forward until a fee read happens (every 12 cycles) and the fee alert fires
  for (let h = 4100; h <= 6400; h += 100) { both(w => { w.head = h; }); await atBlock(h); }
  const st2 = await compareAll('after fee checks');
  ok('fee alert fired on both', st2.alerts.some(a => a.kind === 'fee'), st2.alerts.map(a => a.key));
  both(w => { w.failSlot0 = 99; });
  for (let h = 6500; h <= 7800; h += 100) { both(w => { w.head = h; }); await atBlock(h); }
  both(w => { w.failSlot0 = 0; });
  const st3 = await compareAll('after failed fee reads');
  ok('failed fee reads recorded as gaps', st3.gaps.some(g => g.kind === 'fee'));
  // a range that keeps failing becomes a stated gap after six tries
  both(w => { w.failOwner = 1e9; w.head = 9000; });
  ok('both record the failing range as a gap', await waitFor(async () => { for (const k of ['js', 'go']) { const s = (await get(k, '/state.json')).json; if (!s.gaps.some(g => g.kind === 'all')) return false; } return true; }, 60000));
  both(w => { w.failOwner = 0; });
  ok('both recover to 9000', await atBlock(9000));
  await compareAll('after a gap');

  // restart: feed both the JS server's checkpoint pages (plus an incomplete newer set) as runtime records
  const pagesJs = [];
  const n = Math.max(1, Math.ceil((await get('js', '/state.json')).json.pools.length / 9));
  for (let p = 0; p < n; p++) pagesJs.push((await get('js', '/bridge.json?after=zzzz&page=' + p)).json.checkpoint);
  const recs = pagesJs.map((d, i) => ({ authorId: WRITER, createdAt: 1000 + i, data: d }));
  const newer = { ...pagesJs[0], lastBlock: pagesJs[0].lastBlock + 50, pages: n + 1 };
  recs.push({ authorId: WRITER, createdAt: 5000, data: newer });                            // newer but incomplete: skipped
  recs.push({ authorId: 'usr_someone_else', createdAt: 6000, data: { ...pagesJs[0], lastBlock: 99999999 } }); // not our runtime: ignored
  both(w => { w.records = recs.slice().reverse(); w.head = 9000; });
  await stop('js'); await stop('go');
  for (const k of ['js', 'go']) startServer(k);
  ok('both restore the complete set at 9000', await atBlock(9000), out);
  const r = await compareAll('after restart');
  const h = (await get('go', '/health')).json;
  ok('restored from the complete set, not the newer partial one', /complete checkpoint set at block 9000/.test(h.boot.from) && r.pools.length === 2, h.boot);
  both(w => { w.add(9100, C.PM, [C.T_MOD, POOL, W(LP)], M(-5)); w.head = 9500; });
  ok('both continue after restart', await atBlock(9500));
  await compareAll('after restart + more blocks');
  const sizes = []; for (let p = 0; p < n; p++) sizes.push(JSON.stringify((await get('go', '/bridge.json?after=zzzz&page=' + p)).json).length);
  ok('Go bridge responses under 4,000 chars (max ' + Math.max(...sizes) + ')', Math.max(...sizes) < 4000);
} finally {
  for (const k of ['js', 'go']) try { procs[k].kill('SIGKILL'); } catch {}
  for (const k of ['js', 'go']) worlds[k].server.close();
  fs.rmSync(jsServer, { force: true });
}
console.log(fails ? fails + ' FAILED' : 'ALL MATCH');
process.exit(fails ? 1 : 0);
