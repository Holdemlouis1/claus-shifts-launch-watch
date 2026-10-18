// Multi-page restore test: 22 to 26 watched pools, so the checkpoint spans three runtime records (9 + 9 + rest).
// The Go server and the reviewed JS server run side by side against identical mock nodes and checkpoint feeds and
// must agree on every endpoint. Covers: a set copied page by page while the server keeps scanning (every page of a
// set describes one block), duplicate page copies, a newer set with its middle page missing (skipped whole), a
// foreign author's newer set (ignored), restore from a 3-page set back to 22 and to 25 pools, re-discovery of
// launches after the restored block, the 25-pool cap after restart, the fee trigger on restored pools (a malformed
// slot0 reply is "could not check"; the first good read is the baseline; one alert per pool, even when token addresses
// share a long prefix), and a cold start when no set is complete.
// Usage: (cd server-go && CGO_ENABLED=0 go build -o /tmp/lw-server .) && node test/restore-multipage.test.mjs server /tmp/lw-server
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [JSDIR, GOBIN] = process.argv.slice(2).map(p => path.resolve(p));
const C = { PM: '0x000000000004444c5dc75cb358380d2e3de08a90', ROUTER: '0xbe4bf6ac8c6f012e1c8f25747a9fbccb2fdac4c3',
  T_STAMP: '0x6cf479a102f1eebc9244f48f8d68f6aa52b4c5a4516318df58ba46614a5b14f2', T_MOD: '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec',
  T_OWNER: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0', T_TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  ZERO32: '0x' + '0'.repeat(64) };
const W = a => '0x' + a.slice(2).padStart(64, '0'), H = n => '0x' + n.toString(16), int256 = v => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const LP = '0x' + 'dd'.repeat(20), HOOK = '0x' + 'cc'.repeat(20);
const WRITER = 'runtime_26f2ea55e7956c83237e03b3f53386ee37b44da53bd7ce28ff1f13e78a96eb56', WRITER2 = 'runtime_ed17cd2c1102a32befbbec6e223f1a3724bb837b9d145da92314eb10a1c994ba';
const M = v => '0x' + int256(-600) + int256(600) + int256(v) + '00'.repeat(32);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = i => '0x' + (0xa000 + i).toString(16).padStart(40, '0'), pool = i => '0x' + (0xb000 + i).toString(16).padStart(64, '0');

function world() {
  const w = { logs: [], head: 1000, records: [], goodSlot0: false, feeShift: 0 };
  w.add = (block, address, topics, data) => w.logs.push({ blockNumber: H(block), address, topics, data, transactionHash: '0x' + block.toString(16).padStart(64, '0') });
  w.launch = (i, block) => {
    w.add(block, C.ROUTER, [C.T_STAMP, '0x' + (0xc000 + i).toString(16).padStart(64, '0'), W(tok(i)), W(HOOK)], '0x' + '0'.repeat(24) + C.PM.slice(2) + pool(i).slice(2) + '00'.repeat(32));
    w.add(block, tok(i), [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(10n ** 27n));
    w.add(block, C.PM, [C.T_MOD, pool(i), W(LP)], M(1000 + i));
  };
  const match = (l, f) => { const b = parseInt(l.blockNumber, 16); if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false;
    const as = Array.isArray(f.address) ? f.address : [f.address]; if (!as.includes(l.address)) return false;
    return (f.topics || []).every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : l.topics[i] === t)); };
  const rpc = (m, p) => {
    if (m === 'eth_blockNumber') return H(w.head);
    if (m === 'eth_getBlockByNumber') return { timestamp: H(1_800_000_000 + parseInt(p[0], 16) * 12), hash: '0x' + 'ee'.repeat(32) };
    if (m === 'eth_getLogs') return w.logs.filter(l => match(l, p[0]));
    if (m === 'eth_call') { const d = p[0].data;
      if (d.startsWith('0x95d89b41')) { const b = Buffer.from('T' + parseInt(p[0].to.slice(-4), 16).toString(16)); return '0x' + '20'.padStart(64, '0') + b.length.toString(16).padStart(64, '0') + b.toString('hex').padEnd(64, '0'); }
      if (d.startsWith('0x8da5cb5b')) return W(LP);
      if (d.startsWith('0x18160ddd')) return '0x' + (10n ** 27n).toString(16).padStart(64, '0');
      if (d.startsWith('0xc815641c')) { const i = parseInt(d.slice(-4), 16) - 0xb000; if (!w.goodSlot0) return '0x' + '0'.repeat(64);
        return '0x' + '0'.repeat(64 * 3) + (w.feeShift + 3000 + i).toString(16).padStart(64, '0'); }
      return '0x' + '0'.repeat(64); }
    if (m === 'eth_getStorageAt') return C.ZERO32;
    throw new Error('unexpected ' + m);
  };
  w.server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET') return res.end(JSON.stringify({ items: w.records }));
      const j = JSON.parse(body);
      try { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: rpc(j.method, j.params) })); }
      catch (e) { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: e.message } })); }
    });
  });
  return w;
}
const worlds = { js: world(), go: world() };
const both = f => { for (const w of Object.values(worlds)) f(w); };

const procs = {}, ports = { js: 18701, go: 18702 }, mocks = { js: 18711, go: 18712 }, out = { js: [], go: [] };
const jsServer = path.join(JSDIR, '.restore-server.mjs');
fs.writeFileSync(jsServer, fs.readFileSync(path.join(JSDIR, 'server.mjs'), 'utf8')
  .replace(/const PORT = 8080;/, 'const PORT = +process.env.LW_PORT;')
  .replace(/const INTERVAL_MS = [^;]+;/, 'const INTERVAL_MS = +process.env.LW_INTERVAL_MS;')
  .replace(/const RPCS = \[[^\]]+\];/, "const RPCS = process.env.LW_RPCS.split(',');")
  .replace(/const CHECKPOINTS = '[^']+';/, 'const CHECKPOINTS = process.env.LW_CHECKPOINTS;'));
function startServer(k) {
  out[k] = [];
  const env = { ...process.env, LW_PORT: String(ports[k]), LW_INTERVAL_MS: '250', LW_RPCS: 'http://127.0.0.1:' + mocks[k], LW_CHECKPOINTS: 'http://127.0.0.1:' + mocks[k] + '/records' };
  procs[k] = k === 'js' ? spawn(process.execPath, [jsServer], { env }) : spawn(GOBIN, [], { env });
  procs[k].stdout.on('data', d => out[k].push(String(d))); procs[k].stderr.on('data', d => out[k].push(String(d)));
}
const stop = async k => { procs[k].kill('SIGKILL'); await sleep(200); };
const restartBoth = async () => { await stop('js'); await stop('go'); startServer('js'); startServer('go'); };
const get = async (k, p) => { const r = await fetch('http://127.0.0.1:' + ports[k] + p); return { status: r.status, json: await r.json() }; };
async function waitFor(pred, ms = 30000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await pred()) return true; } catch {} await sleep(150); } return false; }
const atBlock = n => waitFor(async () => { for (const k of ['js', 'go']) { const h = await get(k, '/health'); if (h.json.lastBlock !== n) return false; } await sleep(700); return true; });

let fails = 0, checks = 0;
const ok = (n, c, extra) => { checks++; if (!c) { fails++; console.log('FAIL', n, extra ? JSON.stringify(extra).slice(0, 1500) : ''); } else console.log('ok  ', n); };
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const norm = j => canon(JSON.parse(JSON.stringify(j, (k, v) => (k === 'boot' ? { from: v.from } : k === 'rpcCalls' ? { ...v, eth_blockNumber: 'timer-dependent' } : v))));
const diffAt = (A, B) => { let i = 0; while (i < A.length && A[i] === B[i]) i++; return { at: i, js: A.slice(Math.max(0, i - 120), i + 200), go: B.slice(Math.max(0, i - 120), i + 200) }; };
async function same(label, p) {
  const a = await get('js', p), b = await get('go', p);
  const A = JSON.stringify(norm(a.json)), B = JSON.stringify(norm(b.json));
  ok(label + ' ' + p, a.status === b.status && A === B, a.status !== b.status ? { js: a.status, go: b.status } : diffAt(A, B));
  return a.json;
}
async function compareState(label) {
  const st = await same(label, '/state.json');
  await same(label, '/coverage.json');
  await same(label, '/health');
  const pages = Math.max(1, Math.ceil(st.pools.length / 9));
  for (let p = 0; p < pages; p++) await same(label, '/checkpoint.json?page=' + p);
  return st;
}
// Copy one full set the way the runtime does: page 0 first (freezes the snapshot), then the others. The optional callback runs
// after page 0 is copied, e.g. to let the server scan on before the remaining pages are read.
async function copySet(k, between) {
  const p0 = (await get(k, '/bridge.json?after=zzzz&page=0')).json.checkpoint, set = [p0];
  if (between) await between();
  for (let p = 1; p < p0.pages; p++) set.push((await get(k, '/bridge.json?after=zzzz&page=' + p)).json.checkpoint);
  return set;
}
const rec = (data, createdAt, authorId = WRITER) => ({ authorId, createdAt, data });
const ids = st => st.pools.map(p => p.poolId);
const dupFree = a => new Set(a).size === a.length;

for (const k of ['js', 'go']) await new Promise(r => worlds[k].server.listen(mocks[k], r));
try {
  for (const k of ['js', 'go']) startServer(k);
  ok('both cold-start at 1000', await atBlock(1000), out);

  // 22 launches -> 3 checkpoint pages (9, 9, 4)
  both(w => { for (let i = 0; i < 22; i++) w.launch(i, 1005 + i * 10); w.head = 1400; });
  ok('both reach 1400', await atBlock(1400), out);
  const st22 = await compareState('22 pools');
  ok('22 pools watched, 3 pages', st22.pools.length === 22 && (await get('go', '/checkpoint.json?page=0')).json.pages === 3);
  ok('a short slot0 reply is "could not check" (lpFee -1), never a fee of 0', st22.pools.every(p => p.lpFee === -1) && st22.xrays.every(x => x.lpFee === -1 && x.couldNotCheck.includes('pool slot0')), st22.pools.map(p => p.lpFee));

  // Copy set A page by page while 3 more launches arrive and the server scans on to 1600.
  const sets = {};
  for (const k of ['js', 'go']) sets[k] = [(await get(k, '/bridge.json?after=zzzz&page=0')).json.checkpoint];
  both(w => { for (let i = 22; i < 25; i++) w.launch(i, 1500 + (i - 22) * 10); w.head = 1600; });
  ok('both reach 1600 mid-copy', await atBlock(1600), out);
  for (const k of ['js', 'go']) for (let p = 1; p < 3; p++) sets[k].push((await get(k, '/bridge.json?after=zzzz&page=' + p)).json.checkpoint);
  ok('set A identical on both servers', JSON.stringify(canon(sets.js)) === JSON.stringify(canon(sets.go)), diffAt(JSON.stringify(canon(sets.js)), JSON.stringify(canon(sets.go))));
  const A = sets.go, poolsA = A.flatMap(p => p.pools.map(t => '0x' + t.split(',')[0]));
  ok('set A: every page describes block 1400 although the server is at 1600', A.length === 3 && A.every(p => p.lastBlock === 1400 && p.pages === 3), A.map(p => [p.page, p.lastBlock, p.pages]));
  ok('set A: pages hold 9 + 9 + 4 pools, no overlap, exactly the 22 pools at 1400', A.map(p => p.pools.length).join() === '9,9,4' && dupFree(poolsA) && poolsA.join() === ids(st22).join());
  ok('set A: every page under 4,000 characters (max ' + Math.max(...A.map(p => JSON.stringify({ alert: null, checkpoint: p }).length)) + ')', A.every(p => JSON.stringify({ alert: null, checkpoint: p }).length < 4000));
  const st25 = await compareState('25 pools live');
  ok('live state has 25 pools while set A still says 22', st25.pools.length === 25);

  // Set B at 1600 (25 pools), copied in full.
  const B = await copySet('go');
  ok('set B: 3 pages at 1600, 9 + 9 + 7 pools', B.length === 3 && B.every(p => p.lastBlock === 1600 && p.pages === 3) && B.map(p => p.pools.length).join() === '9,9,7');

  // Restart 1: complete set A (with duplicate copies of page 1), plus a newer set B missing its middle page, plus a
  // complete newer set from an author that is not our runtime. Expect: restore A (22 pools at 1400), then re-scan
  // 1401..1600 and re-discover the 3 later launches.
  const recs1 = [rec(A[0], 100), rec(A[1], 101), rec(A[2], 102), rec(A[1], 150, WRITER2), rec(A[1], 160),
    rec(B[0], 200), rec(B[2], 202),
    ...B.map((p, i) => rec({ ...p, lastBlock: 99999 }, 300 + i, 'usr_not_our_runtime'))];
  both(w => { w.records = recs1.slice().reverse(); });
  await restartBoth();
  ok('restart 1: both back at 1600', await atBlock(1600), out);
  const r1 = await compareState('restart 1');
  const h1 = (await get('go', '/health')).json, h1js = (await get('js', '/health')).json;
  ok('restart 1: restored the complete 3-page set at 1400 (22 pools), skipped the newer partial set and the foreign set',
    /complete checkpoint set at block 1400 \(22 pools\)/.test(h1.boot.from) && h1.boot.from === h1js.boot.from, [h1.boot, h1js.boot]);
  ok('restart 1: 25 pools after re-scan, same pools as before the restart, no duplicates', r1.pools.length === 25 && dupFree(ids(r1)) && ids(r1).join() === ids(st25).join(), ids(r1));
  ok('restart 1: restored pools keep their baseline and window', r1.pools.slice(0, 22).every((p, i) => p.L0 === st25.pools[i].L0 && p.baseBlock === st25.pools[i].baseBlock && p.untilAt === st25.pools[i].untilAt && p.startBlock === st25.pools[i].startBlock));

  // Restart 2: add the missing page of set B. Now B is the newest complete set: restore 25 pools at 1600 directly.
  both(w => { w.records = [...recs1, rec(B[1], 400)].reverse(); });
  await restartBoth();
  ok('restart 2: both at 1600', await atBlock(1600), out);
  const r2 = await compareState('restart 2');
  const h2 = (await get('go', '/health')).json;
  ok('restart 2: restored the complete 3-page set at 1600 (25 pools)', /complete checkpoint set at block 1600 \(25 pools\)/.test(h2.boot.from), h2.boot);
  ok('restart 2: pools identical to before the restarts', JSON.stringify(canon(r2.pools)) === JSON.stringify(canon(st25.pools)), diffAt(JSON.stringify(canon(r2.pools)), JSON.stringify(canon(st25.pools))));

  // The cap still holds after a restore: a 26th launch is X-rayed but listed as a capacity gap.
  both(w => { w.launch(25, 1700); w.head = 1800; });
  ok('both reach 1800', await atBlock(1800), out);
  const r3 = await compareState('26th launch after restore');
  ok('26th launch is a capacity gap, still 25 pools', r3.pools.length === 25 && r3.gaps.some(g => g.kind === 'capacity'), r3.gaps);

  // Fee trigger on restored pools: slot0 recovers, the first good hourly read sets the baseline without an alert,
  // then a real fee change on every pool fires one fee alert per pool.
  both(w => { w.goodSlot0 = true; });
  for (let h = 1900; h <= 3300; h += 100) { both(w => { w.head = h; }); await atBlock(h); }
  const f1 = await compareState('fee baseline after restore');
  ok('first good fee read becomes the baseline, no fee alerts', f1.pools.every((p, i) => p.lpFee === 3000 + parseInt(p.poolId.slice(-4), 16) - 0xb000) && !f1.alerts.some(a => a.kind === 'fee'), f1.pools.map(p => p.lpFee));
  both(w => { w.feeShift = 100; });
  for (let h = 3400; h <= 4800; h += 100) { both(w => { w.head = h; }); await atBlock(h); }
  const f2 = await compareState('fee change after restore');
  ok('a fee change fires one fee alert on each of the 25 pools (tokens share a 36-character prefix: keys use the full address)', f2.alerts.filter(a => a.kind === 'fee').length === 25, f2.alerts.filter(a => a.kind === 'fee').length);

  // Restart 3: only incomplete sets (A without page 2, B without page 1) -> no complete set -> cold start, stated as a gap.
  both(w => { w.records = [rec(A[0], 100), rec(A[1], 101), rec(B[0], 200), rec(B[2], 202)].reverse(); });
  await restartBoth();
  ok('restart 3: both at 4800', await atBlock(4800), out);
  const r4 = await compareState('restart 3');
  const h4 = (await get('go', '/health')).json;
  ok('restart 3: no complete set -> cold start at head with a cold-start gap', /cold start at block 4800/.test(h4.boot.from) && r4.gaps.some(g => g.kind === 'cold-start') && r4.pools.length === 0, h4.boot);
} finally {
  for (const k of ['js', 'go']) try { procs[k].kill('SIGKILL'); } catch {}
  for (const k of ['js', 'go']) worlds[k].server.close();
  fs.rmSync(jsServer, { force: true });
}
console.log(checks + ' checks, ' + (fails ? fails + ' FAILED' : 'ALL MATCH'));
process.exit(fails ? 1 : 0);
