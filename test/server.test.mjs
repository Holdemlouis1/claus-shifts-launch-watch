import { C, emptyState, cycle, checkpoint, restore, coverage, addr, bridge } from '../server/watch.mjs';
const W = a => '0x' + a.slice(2).padStart(64, '0'), H = n => '0x' + n.toString(16);
const TOKEN = '0x' + 'ab'.repeat(20), HOOK = '0x' + 'cc'.repeat(20), POOL = '0x' + '11'.repeat(32), LP = '0x' + 'dd'.repeat(20);
const int256 = v => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
let logs = [], head = 1000, failLeft = 0;
const add = (block, address, topics, data) => logs.push({ blockNumber: H(block), address, topics, data, transactionHash: '0x' + block.toString(16).padStart(64, '0') });
// launch at 1005: stamp, initial mint, first owner set, baseline liquidity +1000
add(1005, C.ROUTER, [C.T_STAMP, '0x' + '99'.repeat(32), W(TOKEN), W(HOOK)], '0x' + '0'.repeat(24) + C.PM.slice(2) + POOL.slice(2) + '00'.repeat(32));
add(1005, TOKEN, [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(10n ** 27n));
add(1005, TOKEN, [C.T_OWNER, C.ZERO32, W(LP)], '0x');
add(1005, C.PM, [C.T_MOD, POOL, W(LP)], '0x' + int256(-600) + int256(600) + int256(1000) + '00'.repeat(32));
// later: someone adds 100, removes 340 (net 240 = 24% -> no alert), then removes 20 more (net 260 = 26% -> alert)
add(1500, C.PM, [C.T_MOD, POOL, W(LP)], '0x' + int256(-600) + int256(600) + int256(100) + '00'.repeat(32));
add(1600, C.PM, [C.T_MOD, POOL, W(LP)], '0x' + int256(-600) + int256(600) + int256(-340) + '00'.repeat(32));
add(2600, C.PM, [C.T_MOD, POOL, W(LP)], '0x' + int256(-600) + int256(600) + int256(-20) + '00'.repeat(32));
add(2700, TOKEN, [C.T_OWNER, W(LP), C.ZERO32], '0x');   // renounce later -> owner alert
add(2800, TOKEN, [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(5));  // later mint -> alert
const match = (l, f) => {
  const b = parseInt(l.blockNumber, 16); if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false;
  const as = Array.isArray(f.address) ? f.address : [f.address]; if (!as.includes(l.address)) return false;
  return (f.topics || []).every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : l.topics[i] === t));
};
const calls = {};
const rpc = async (m, p) => {
  calls[m] = (calls[m] || 0) + 1;
  if (m === 'eth_blockNumber') return H(head);
  if (m === 'eth_getBlockByNumber') return { timestamp: H(1_800_000_000 + parseInt(p[0], 16) * 12), hash: '0x' + 'ee'.repeat(32) };
  if (m === 'eth_getLogs') { const to = parseInt(p[0].toBlock, 16); if (failLeft > 0 && p[0].topics[0] === C.T_OWNER) { failLeft--; throw new Error('rate limited'); } return logs.filter(l => match(l, p[0])); }
  if (m === 'eth_call') { const d = p[0].data; if (d.startsWith('0x95d89b41')) return '0x' + '20'.padStart(64, '0') + '4'.padStart(64, '0') + Buffer.from('TEST').toString('hex').padEnd(64, '0'); if (d.startsWith('0x8da5cb5b')) return W(LP); if (d.startsWith('0xc815641c')) return '0x' + '0'.repeat(64 * 4); return '0x' + '0'.repeat(64); }
  if (m === 'eth_getStorageAt') return C.ZERO32;
  throw new Error('unexpected ' + m);
};
const ok = (n, c) => { if (!c) { console.log('FAIL', n); process.exitCode = 1; } else console.log('ok  ', n); };
let s = emptyState(999); head = 3000; failLeft = 2;
for (let i = 0; i < 5; i++) { try { await cycle(rpc, s); } catch (e) {} }   // first two attempts fail, then the same range succeeds
ok('launch discovered via router stamp', s.pools.length === 1 && s.pools[0].token === TOKEN && s.pools[0].symbol === 'TEST');
ok('baseline L0 = 1000 from the launch block only', s.pools[0].L0 === '1000');
ok('deployment mint and first owner are not alerts', !s.alerts.some(a => a.block === 1005));
ok('liquidity alert fires at 26% net, not at 24%', s.alerts.filter(a => a.kind === 'liquidity').length === 1 && s.alerts.find(a => a.kind === 'liquidity').block === 2600);
ok('later owner change and mint alert', s.alerts.some(a => a.kind === 'owner' && a.block === 2700) && s.alerts.some(a => a.kind === 'mint' && a.block === 2800));
ok('two failures are retried, not skipped', s.gaps.length === 0 && s.lastBlock === 3000 && s.pools[0].ok >= 1);
const g = emptyState(999); head = 1500; failLeft = 99; for (let i = 0; i < 6; i++) { try { await cycle(rpc, g); } catch (e) {} } failLeft = 0;
ok('six failures of one range become a stated gap', g.gaps.some(x => x.kind === 'all' && x.from === 1000 && x.to === 1500) && g.lastBlock === 1500);
// restart: restore from checkpoint, continue, nothing double counted
const cp = JSON.parse(JSON.stringify(checkpoint(s, 0)));
const s2 = restore([cp]); head = 4000; add(3500, C.PM, [C.T_MOD, POOL, W(LP)], '0x' + int256(-600) + int256(600) + int256(-10) + '00'.repeat(32));
await cycle(rpc, s2);
ok('restart resumes at the checkpoint block', s2.lastBlock === 4000 && s2.pools[0].removed === '370' && s2.pools[0].added === '100' && s2.pools[0].baseBlock === 1055);
ok('restart does not re-fire the liquidity alert', !s2.alerts.some(a => a.kind === 'liquidity'));
ok('restart does not rediscover the same launch', s2.pools.length === 1);
// 25 pools fit an 8 KB record
const big = emptyState(26_300_000); for (let i = 0; i < 25; i++) big.pools.push({ poolId: '0x' + String(i).padStart(64, 'f'), token: '0x' + String(i).padStart(40, 'a'), symbol: 'SYMBOL123456', startBlock: 26_200_000 + i, baseBlock: 26_200_000 + i, untilAt: 1_800_000_000, L0: '9'.repeat(26), added: '9'.repeat(26), removed: '9'.repeat(26), lpFee: 8388608, fired: 31, ok: 4032, failed: 120, closed: false });
for (let i = 0; i < 30; i++) big.gaps.push({ kind: 'liquidity', from: 26_200_000 + i, to: 26_202_000 + i });
const pages = checkpoint(big, 0).pages, sizes = [...Array(pages)].map((_, i) => JSON.stringify(checkpoint(big, i)).length);
ok('25 pools checkpoint in ' + pages + ' pages, largest ' + Math.max(...sizes) + ' chars (< 3900)', Math.max(...sizes) < 3900);
const back = restore([...Array(pages)].map((_, i) => JSON.parse(JSON.stringify(checkpoint(big, i)))));
ok('all 25 pools restore from pages with values intact', back.pools.length === 25 && back.pools[24].L0 === '9'.repeat(26) && back.pools[24].fired === 31);
// Claus review fix 2: restore only a complete checkpoint set
const J = x => JSON.parse(JSON.stringify(x));
ok('an incomplete set alone is not restored (null, server cold-starts and states the gap)', restore([J(checkpoint(big, 0)), J(checkpoint(big, 2))]) === null);
const older = [0, 1, 2].map(i => J(checkpoint(big, i))); big.lastBlock += 100;
const newerIncomplete = [J(checkpoint(big, 2)), J(checkpoint(big, 0))];
const fb = restore([...newerIncomplete, ...older]);
ok('a newer incomplete set is skipped; the older complete set restores all 25 pools', fb && fb.lastBlock === 26_300_000 && fb.pools.length === 25);
const dupes = restore([...[0, 1, 2].map(i => J(checkpoint(big, i))), ...[0, 1, 2].map(i => J(checkpoint(big, i)))]);
ok('repeated copies of a set never duplicate pools', dupes && dupes.pools.length === 25);
// closed windows are pruned two days after they end
const pr = emptyState(5000); pr.pools.push({ poolId: POOL, token: TOKEN, symbol: 'X', startBlock: 1, baseBlock: 1, untilAt: 1, L0: '1', added: '0', removed: '0', lpFee: 0, fired: 0, ok: 1, failed: 0, closed: true }); head = 5100; await cycle(rpc, pr);
ok('closed pool pruned after KEEP_CLOSED', pr.pools.length === 0);
// Claus review fix 1: baseline is launch block + 50 even when the first scan ends earlier
const T2 = '0x' + 'ef'.repeat(20), P2 = '0x' + '22'.repeat(32), M = v => '0x' + int256(-600) + int256(600) + int256(v) + '00'.repeat(32);
add(10005, C.ROUTER, [C.T_STAMP, '0x' + '98'.repeat(32), W(T2), W(HOOK)], '0x' + '0'.repeat(24) + C.PM.slice(2) + P2.slice(2) + '00'.repeat(32));
add(10005, C.PM, [C.T_MOD, P2, W(LP)], M(1000));
add(10030, C.PM, [C.T_MOD, P2, W(LP)], M(500));    // still inside the baseline window
add(10040, C.PM, [C.T_MOD, P2, W(LP)], M(-300));   // still inside the baseline window
add(10050, T2, [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(7)); // mint inside the window: baseline, not an alert
add(10100, C.PM, [C.T_MOD, P2, W(LP)], M(-400));   // after the window: 400 / 1200 = 33% -> alert
const st = emptyState(10000); head = 10020; await cycle(rpc, st); head = 10200; await cycle(rpc, st);
const q = st.pools.find(p => p.poolId === P2);
ok('baseline block stays launch + 50 when the first scan ends at +15', q && q.baseBlock === 10055);
ok('liquidity inside the window after the first scan is baseline: L0 = 1200', q && q.L0 === '1200' && q.added === '0' && q.removed === '400');
ok('no alert inside the window; liquidity alert after it', !st.alerts.some(a => a.block <= 10055) && st.alerts.some(a => a.kind === 'liquidity' && a.block === 10100));
// snapshot: every page of one set comes from one frozen state, even while the server keeps scanning
const big2 = emptyState(20000); big2.pools = big.pools.map(p => ({ ...p })); const a0 = bridge(big2, 'z', 0).checkpoint;
big2.lastBlock = 20500; big2.pools.pop(); const a1 = bridge(big2, 'z', 1).checkpoint, a2 = bridge(big2, 'z', 2).checkpoint;
ok('pages 1..n of a set come from the page-0 snapshot', a0.lastBlock === 20000 && a1.lastBlock === 20000 && a2.lastBlock === 20000 && a2.pools.length === 7);
ok('the snapshot set restores complete', restore([J(a2), J(a1), J(a0)]).pools.length === 25);
ok('the next page 0 starts a new snapshot', bridge(big2, 'z', 0).checkpoint.lastBlock === 20500);
console.log('coverage sample', JSON.stringify(coverage(s2, s2.pools[0])).slice(0, 300));
console.log('rpc calls for 4 cycles:', JSON.stringify(calls));
