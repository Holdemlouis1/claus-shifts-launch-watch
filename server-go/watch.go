// Claus Shifts · Launch Watch server (pilot), Go port. MIT. Standard library only: no keys, no wallet, no disk.
// A line-for-line port of server/watch.mjs (the version Claus reviewed at e491bcb), so the image fits the network's
// 32 MiB build limit. Reads Ethereum through public RPC, finds new launches (Programmable's launch router, and any
// Uniswap v4 pool paired with CLAUS), X-rays each one at the current head, and watches it for 14 days against five
// fixed triggers. Everything is served as public JSON. Claus Shifts' managed runtime copies the compact checkpoint and
// each alert into public records; on restart the server reloads the newest complete checkpoint set and re-scans from
// its block, so a restart delays checks but never skips blocks. Spec: claus.si/c/claus-shifts/pages/launch-watch.html
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	PM         = "0x000000000004444c5dc75cb358380d2e3de08a90"
	STATEVIEW  = "0x7ffe42c4a5deea5b0fec41c94c136cf115597227"
	ROUTER     = "0xbe4bf6ac8c6f012e1c8f25747a9fbccb2fdac4c3"
	CLAUS      = "0x1b54e762aa34cf6e28e9c082f2848e28e45da6b8"
	T_STAMP    = "0x6cf479a102f1eebc9244f48f8d68f6aa52b4c5a4516318df58ba46614a5b14f2" // ProgrammableLaunchStampedV1
	T_INIT     = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" // Uniswap v4 Initialize
	T_MOD      = "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec" // Uniswap v4 ModifyLiquidity
	T_OWNER    = "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0" // OwnershipTransferred
	T_UPGRADED = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b" // EIP-1967 Upgraded
	T_ADMIN    = "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f" // EIP-1967 AdminChanged
	T_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
	SLOT_IMPL  = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
	SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"

	WATCH_SECONDS = 14 * 86400
	MAX_RANGE     = 2000      // blocks per cycle; after an outage the server catches up in steps of this size
	MAX_WATCHED   = 25        // keeps RPC use bounded; the checkpoint is paged so each page fits one runtime record
	PAGE          = 9         // pools per checkpoint page (each page stays under the runtime's 4,000-character web read)
	BASE_BLOCKS   = 50        // baseline window: liquidity provided within 50 blocks (~10 min) of the launch is L0
	KEEP_CLOSED   = 2 * 86400 // a closed window stays in state this long so its coverage report can be copied out
	FEE_EVERY     = 12        // cycles between slot0 fee reads (12 x 5 min = hourly)
	RETRIES       = 6         // consecutive failures of one range (30 min) before it is recorded as a gap
)

var (
	ZERO32     = "0x" + strings.Repeat("0", 64)
	Z          = "0x" + strings.Repeat("0", 40)
	WELL_KNOWN = []string{"0x0000000000000000000000000000000000000000", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0x6b175474e89094c44da98b954eedeac495271d0f", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"}
	TRIGGERS   = []string{"liquidity", "owner", "upgrade", "mint", "fee"}
	two256     = new(big.Int).Lsh(big.NewInt(1), 256)
)

func addr(h string) string {
	if len(h) > 40 {
		h = h[len(h)-40:]
	}
	return "0x" + strings.ToLower(h)
}
func hexOf(n int64) string { return "0x" + strconv.FormatInt(n, 16) }

// StateView.getSlot0 returns four words; the LP fee is the fourth. A short or malformed reply (some public nodes
// answer "0x") is a failed read, never a fee of 0.
func slot0Fee(h string) (int64, bool) {
	if len(h) < 258 || !strings.HasPrefix(h, "0x") {
		return 0, false
	}
	for _, c := range h[2:] {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return 0, false
		}
	}
	return parseHex(sub(h, 194, 258)), true
}

func parseHex(h string) int64 {
	v, err := strconv.ParseInt(strings.TrimPrefix(h, "0x"), 16, 64)
	if err != nil {
		return 0
	}
	return v
}
func sub(s string, a, b int) string { // JS String.prototype.slice(a, b) for non-negative a, b
	if a > len(s) {
		a = len(s)
	}
	if b > len(s) {
		b = len(s)
	}
	if b < a {
		return ""
	}
	return s[a:b]
}
func int256(h string) *big.Int { // BigInt.asIntN(256, BigInt('0x' + h))
	v, ok := new(big.Int).SetString(h, 16)
	if !ok {
		v = new(big.Int)
	}
	if v.Bit(255) == 1 {
		v.Sub(v, two256)
	}
	return v
}
func bigOf(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return new(big.Int)
	}
	return v
}
func bigHex(h string) (*big.Int, error) { // BigInt('0x…'), which throws on an empty or malformed value
	t := strings.TrimPrefix(h, "0x")
	if t == "" || !strings.HasPrefix(h, "0x") {
		return nil, errors.New("not a number")
	}
	v, ok := new(big.Int).SetString(t, 16)
	if !ok {
		return nil, errors.New("not a number")
	}
	return v, nil
}

// ABI-decoded string (as the JS `str`), at most 40 characters; ” when it is not a valid string.
func str(h string) string {
	if !strings.HasPrefix(h, "0x") {
		return ""
	}
	x := h[2:]
	if len(x) < 128 {
		return ""
	}
	n, err := strconv.ParseInt(x[64:128], 16, 64)
	if err != nil || n < 0 {
		return ""
	}
	raw, err := hex.DecodeString(sub(x, 128, 128+int(n)*2))
	if err != nil || !utf8.Valid(raw) {
		return ""
	}
	r := []rune(string(raw))
	if len(r) > 40 {
		r = r[:40]
	}
	return string(r)
}

// ---------- RPC with per-method call counts (the pilot budget is computed from these counters) ----------
type Log struct {
	Address         string   `json:"address"`
	Topics          []string `json:"topics"`
	Data            string   `json:"data"`
	BlockNumber     string   `json:"blockNumber"`
	TransactionHash string   `json:"transactionHash"`
}
type RPC struct {
	URLs   []string
	Client *http.Client
	mu     sync.Mutex
	Counts map[string]int
	id     int
}

func (r *RPC) count(m string) { r.mu.Lock(); r.Counts[m]++; r.mu.Unlock() }
func (r *RPC) CountsCopy() map[string]int {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := map[string]int{}
	for k, v := range r.Counts {
		c[k] = v
	}
	return c
}

// Call tries each endpoint twice in turn, as makeRpc does, and returns the raw `result`.
func (r *RPC) Call(method string, params interface{}) (json.RawMessage, error) {
	var last error
	n := len(r.URLs) * 2
	for i := 0; i < n; i++ {
		url := r.URLs[i%len(r.URLs)]
		r.mu.Lock()
		r.id++
		id := r.id
		r.mu.Unlock()
		body, _ := json.Marshal(map[string]interface{}{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
		req.Header.Set("content-type", "application/json")
		resp, err := r.Client.Do(req)
		if err == nil {
			r.count(method)
			var j struct {
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			derr := json.NewDecoder(resp.Body).Decode(&j)
			resp.Body.Close()
			cancel()
			if derr == nil && len(j.Result) > 0 && (len(j.Error) == 0 || string(j.Error) == "null") {
				return j.Result, nil
			}
			msg := string(j.Error)
			if msg == "" || msg == "null" {
				msg = "no result"
			}
			if len(msg) > 120 {
				msg = msg[:120]
			}
			last = fmt.Errorf("%s: %s", method, msg)
		} else {
			cancel()
			last = err
		}
		time.Sleep(time.Duration(400*(i+1)) * time.Millisecond)
	}
	return nil, last
}
func (r *RPC) Str(method string, params interface{}) (string, error) {
	raw, err := r.Call(method, params)
	if err != nil {
		return "", err
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", fmt.Errorf("%s: unexpected result", method)
	}
	return s, nil
}
func (r *RPC) Logs(filter map[string]interface{}) ([]Log, error) {
	raw, err := r.Call("eth_getLogs", []interface{}{filter})
	if err != nil {
		return nil, err
	}
	var l []Log
	if err := json.Unmarshal(raw, &l); err != nil {
		return nil, errors.New("eth_getLogs: unexpected result")
	}
	return l, nil
}

// ---------- X-ray at one block (same fields as the launches records) ----------
type Found struct {
	Token, Hook, PoolID, Tx, Source string
	Block                           int64
}
type Xray struct {
	Token         string   `json:"token"`
	Symbol        string   `json:"symbol"`
	PoolID        string   `json:"poolId"`
	Hook          string   `json:"hook"`
	Source        string   `json:"source"`
	LaunchTx      string   `json:"launchTx"`
	LaunchBlock   int64    `json:"launchBlock"`
	Block         int64    `json:"block"`
	Supply        string   `json:"supply"`
	Owner         string   `json:"owner"`
	HasOwner      bool     `json:"hasOwner"`
	ProxyImpl     string   `json:"proxyImpl"`
	ProxyAdmin    string   `json:"proxyAdmin"`
	LpFee         int64    `json:"lpFee"`
	CouldNotCheck []string `json:"couldNotCheck"`
}

func xray(rpc *RPC, l Found, block int64) Xray {
	B := hexOf(block)
	call := func(to, data string) (string, error) {
		return rpc.Str("eth_call", []interface{}{map[string]string{"to": to, "data": data}, B})
	}
	cnc := []string{}
	symbol := ""
	if v, err := call(l.Token, "0x95d89b41"); err != nil {
		cnc = append(cnc, "token symbol()")
	} else {
		symbol = str(v)
	}
	supply := ""
	if v, err := call(l.Token, "0x18160ddd"); err != nil {
		cnc = append(cnc, "token totalSupply()")
	} else if b, err := bigHex(v); err != nil {
		cnc = append(cnc, "token totalSupply()")
	} else {
		supply = b.String()
	}
	owner, hasOwner := "", false
	if o, err := call(l.Token, "0x8da5cb5b"); err == nil && len(o) >= 66 { // no owner() is a fact, not a failure
		owner, hasOwner = addr(o), true
	}
	impl, admin := "", ""
	if v, err := rpc.Str("eth_getStorageAt", []interface{}{l.Token, SLOT_IMPL, B}); err != nil {
		cnc = append(cnc, "EIP-1967 implementation slot")
	} else if a := addr(v); a != Z {
		impl = a
	}
	if v, err := rpc.Str("eth_getStorageAt", []interface{}{l.Token, SLOT_ADMIN, B}); err != nil {
		cnc = append(cnc, "EIP-1967 admin slot")
	} else if a := addr(v); a != Z {
		admin = a
	}
	lpFee := int64(-1)
	if s0, err := call(STATEVIEW, "0xc815641c"+strings.TrimPrefix(l.PoolID, "0x")); err != nil {
		cnc = append(cnc, "pool slot0")
	} else if f, ok := slot0Fee(s0); !ok {
		cnc = append(cnc, "pool slot0")
	} else {
		lpFee = f
	}
	cnc = append(cnc, "hook buy/sell fee values (no standard getter)")
	return Xray{Token: l.Token, Symbol: symbol, PoolID: l.PoolID, Hook: l.Hook, Source: l.Source, LaunchTx: l.Tx, LaunchBlock: l.Block, Block: block,
		Supply: supply, Owner: owner, HasOwner: hasOwner, ProxyImpl: impl, ProxyAdmin: admin, LpFee: lpFee, CouldNotCheck: cnc}
}

// ---------- State. Checkpoint() is the compact form copied into a public record; Restore() reads it back. ----------
type Gap struct {
	Kind  string `json:"kind"`
	Token string `json:"token,omitempty"`
	From  int64  `json:"from"`
	To    int64  `json:"to"`
}
type Pool struct {
	PoolID     string `json:"poolId"`
	Token      string `json:"token"`
	Symbol     string `json:"symbol"`
	StartBlock int64  `json:"startBlock"`
	BaseBlock  int64  `json:"baseBlock"`
	UntilAt    int64  `json:"untilAt"`
	L0         string `json:"L0"`
	Added      string `json:"added"`
	Removed    string `json:"removed"`
	LpFee      int64  `json:"lpFee"`
	Fired      int64  `json:"fired"`
	Ok         int64  `json:"ok"`
	Failed     int64  `json:"failed"`
	Closed     bool   `json:"closed"`
}
type Alert struct {
	Key    string `json:"key"`
	Kind   string `json:"kind"`
	Token  string `json:"token"`
	Symbol string `json:"symbol"`
	PoolID string `json:"poolId"`
	Line   string `json:"line"`
	Tx     string `json:"tx"`
	Block  int64  `json:"block"`
	At     int64  `json:"at"`
}
type Snap struct {
	LastBlock, LastAt, Cycles int64
	Gaps                      []Gap
	Pools                     []Pool
}
type State struct {
	V         int      `json:"v"`
	LastBlock int64    `json:"lastBlock"`
	Cycles    int64    `json:"cycles"`
	LastAt    int64    `json:"lastAt"`
	Pools     []Pool   `json:"pools"`
	Seen      []string `json:"seen"`
	Alerts    []Alert  `json:"alerts"`
	Gaps      []Gap    `json:"gaps"`
	Xrays     []Xray   `json:"xrays"`
	Retries   int      `json:"retries"`
	Snap      *Snap    `json:"-"`
}

func EmptyState(lastBlock int64) *State {
	return &State{V: 1, LastBlock: lastBlock, Pools: []Pool{}, Seen: []string{}, Alerts: []Alert{}, Gaps: []Gap{}, Xrays: []Xray{}}
}
func (s *State) Clone() *State {
	b, _ := json.Marshal(s)
	c := &State{}
	json.Unmarshal(b, c)
	c.Snap = s.Snap
	return c
}

// One pool is one comma-joined string (the network's record schema allows arrays of one type only).
func enc(p Pool) string {
	sym := strings.NewReplacer(",", "", "|", "").Replace(p.Symbol)
	if r := []rune(sym); len(r) > 12 {
		sym = string(r[:12])
	}
	closed := "0"
	if p.Closed {
		closed = "1"
	}
	return strings.Join([]string{strings.TrimPrefix(p.PoolID, "0x"), strings.TrimPrefix(p.Token, "0x"), sym,
		strconv.FormatInt(p.StartBlock, 10), strconv.FormatInt(p.BaseBlock, 10), strconv.FormatInt(p.UntilAt, 10),
		p.L0, p.Added, p.Removed, strconv.FormatInt(p.LpFee, 10), strconv.FormatInt(p.Fired, 10),
		strconv.FormatInt(p.Ok, 10), strconv.FormatInt(p.Failed, 10), closed}, ",")
}
func num(s string) int64 { v, _ := strconv.ParseInt(s, 10, 64); return v }
func dec(t string) Pool {
	a := strings.Split(t, ",")
	for len(a) < 14 {
		a = append(a, "")
	}
	return Pool{PoolID: "0x" + a[0], Token: "0x" + a[1], Symbol: a[2], StartBlock: num(a[3]), BaseBlock: num(a[4]), UntilAt: num(a[5]),
		L0: a[6], Added: a[7], Removed: a[8], LpFee: num(a[9]), Fired: num(a[10]), Ok: num(a[11]), Failed: num(a[12]), Closed: a[13] == "1"}
}

type Checkpoint struct {
	V         int      `json:"v"`
	LastBlock int64    `json:"lastBlock"`
	LastAt    int64    `json:"lastAt"`
	Cycles    int64    `json:"cycles"`
	Page      int      `json:"page"`
	Pages     int      `json:"pages"`
	Pools     []string `json:"pools"`
	Gaps      []string `json:"gaps"`
}

func checkpointOf(lastBlock, lastAt, cycles int64, pools []Pool, gaps []Gap, page int) Checkpoint {
	pages := (len(pools) + PAGE - 1) / PAGE
	if pages < 1 {
		pages = 1
	}
	out := Checkpoint{V: 1, LastBlock: lastBlock, LastAt: lastAt, Cycles: cycles, Page: page, Pages: pages, Pools: []string{}, Gaps: []string{}}
	for i := page * PAGE; i < (page+1)*PAGE && i < len(pools); i++ {
		out.Pools = append(out.Pools, enc(pools[i]))
	}
	if page == 0 {
		g := gaps
		if len(g) > 8 {
			g = g[len(g)-8:]
		}
		for _, x := range g {
			out.Gaps = append(out.Gaps, x.Kind+","+strconv.FormatInt(x.From, 10)+","+strconv.FormatInt(x.To, 10))
		}
	}
	return out
}
func (s *State) Checkpoint(page int) Checkpoint {
	return checkpointOf(s.LastBlock, s.LastAt, s.Cycles, s.Pools, s.Gaps, page)
}

// Restore only from a COMPLETE set: every page 0..pages-1 of one snapshot (one lastBlock, one page count). The newest
// complete set wins; an incomplete newer set is skipped, never partly used, so a missing page cannot drop watched
// pools. Returns nil when no complete set exists (the server then cold-starts and states the gap).
// `pages` must be newest first; the newest copy of each page in a set is used.
type CheckpointIn struct {
	LastBlock int64    `json:"lastBlock"`
	LastAt    int64    `json:"lastAt"`
	Cycles    int64    `json:"cycles"`
	Page      *int64   `json:"page"`
	Pages     int      `json:"pages"`
	Pools     []string `json:"pools"`
	Gaps      []string `json:"gaps"`
}

func Restore(pages []CheckpointIn) *State {
	seenBlock := map[int64]bool{}
	blocks := []int64{}
	for _, p := range pages {
		if !seenBlock[p.LastBlock] {
			seenBlock[p.LastBlock] = true
			blocks = append(blocks, p.LastBlock)
		}
	}
	sort.Slice(blocks, func(i, j int) bool { return blocks[i] > blocks[j] })
	nOf := func(p CheckpointIn) int {
		if p.Pages == 0 {
			return 1
		}
		return p.Pages
	}
	for _, top := range blocks {
		set := []CheckpointIn{}
		for _, p := range pages {
			if p.LastBlock == top {
				set = append(set, p)
			}
		}
		n, same := nOf(set[0]), true
		for _, p := range set {
			if nOf(p) != n {
				same = false
			}
		}
		if !same {
			continue // two different snapshots at one block: not a set
		}
		use := map[int64]CheckpointIn{}
		for _, p := range set {
			if p.Page != nil && *p.Page >= 0 && *p.Page < int64(n) {
				if _, ok := use[*p.Page]; !ok {
					use[*p.Page] = p
				}
			}
		}
		if len(use) != n {
			continue // a page is missing: skip the whole set
		}
		s := EmptyState(top)
		first := use[0]
		s.LastAt, s.Cycles = first.LastAt, first.Cycles
		for _, g := range first.Gaps {
			a := strings.Split(g, ",")
			for len(a) < 3 {
				a = append(a, "")
			}
			s.Gaps = append(s.Gaps, Gap{Kind: a[0], From: num(a[1]), To: num(a[2])})
		}
		for i := 0; i < n; i++ {
			for _, t := range use[int64(i)].Pools {
				p := dec(t)
				s.Pools = append(s.Pools, p)
				s.Seen = append(s.Seen, p.PoolID)
			}
		}
		return s
	}
	return nil
}

// ---------- One cycle over the block range (lastBlock, to] ----------
type CycleResult struct {
	Head   int64   `json:"head"`
	From   int64   `json:"from,omitempty"`
	To     int64   `json:"to,omitempty"`
	Idle   bool    `json:"idle,omitempty"`
	Gap    bool    `json:"gap,omitempty"`
	Found  *int    `json:"found,omitempty"`
	Live   *int    `json:"live,omitempty"`
	Behind *int64  `json:"behind,omitempty"`
	Error  *string `json:"error,omitempty"`
	At     int64   `json:"at,omitempty"`
}

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}
func W(a string) string {
	return "0x" + strings.Repeat("0", 64-len(strings.TrimPrefix(a, "0x"))) + strings.TrimPrefix(a, "0x")
}

func Cycle(rpc *RPC, s *State, log func(string)) (*CycleResult, error) {
	hs, err := rpc.Str("eth_blockNumber", []interface{}{})
	if err != nil {
		return nil, err
	}
	head := parseHex(hs)
	from := s.LastBlock + 1
	to := s.LastBlock + MAX_RANGE
	if head < to {
		to = head
	}
	if to < from {
		return &CycleResult{Head: head, Idle: true}, nil
	}
	rawB, err := rpc.Call("eth_getBlockByNumber", []interface{}{hexOf(to), false})
	if err != nil {
		return nil, err
	}
	var blk struct{ Timestamp string }
	if json.Unmarshal(rawB, &blk) != nil || blk.Timestamp == "" {
		return nil, errors.New("eth_getBlockByNumber: no block")
	}
	at := parseHex(blk.Timestamp)
	rng := func(m map[string]interface{}) map[string]interface{} {
		m["fromBlock"], m["toBlock"] = hexOf(from), hexOf(to)
		return m
	}

	// 1. Read everything for the range first; change nothing unless every query succeeded. A failing range is retried
	//    whole on the next cycle (late, never skipped); only after RETRIES failures is it recorded as a gap.
	var mods, owns, ups, mints []Log
	found := []Found{}
	type livePool struct{ PoolID, Token string }
	var live []livePool
	readErr := func() error {
		stamps, err := rpc.Logs(rng(map[string]interface{}{"address": ROUTER, "topics": []interface{}{T_STAMP}}))
		if err != nil {
			return err
		}
		for _, l := range stamps {
			d := strings.TrimPrefix(l.Data, "0x")
			found = append(found, Found{Token: addr(l.Topics[2]), Hook: addr(l.Topics[3]), PoolID: "0x" + sub(d, 64, 128), Tx: l.TransactionHash, Block: parseHex(l.BlockNumber), Source: "programmable"})
		}
		for _, pos := range []int{2, 3} {
			topics := []interface{}{T_INIT, nil, nil, nil}
			topics[pos] = W(CLAUS)
			ls, err := rpc.Logs(rng(map[string]interface{}{"address": PM, "topics": topics}))
			if err != nil {
				return err
			}
			for _, l := range ls {
				oi := 2
				if pos == 2 {
					oi = 3
				}
				other := addr(l.Topics[oi])
				if !contains(WELL_KNOWN, other) {
					found = append(found, Found{Token: other, Hook: addr(sub(strings.TrimPrefix(l.Data, "0x"), 128, 192)), PoolID: l.Topics[1], Tx: l.TransactionHash, Block: parseHex(l.BlockNumber), Source: "claus-pair"})
				}
			}
		}
		uniq := []Found{}
		for i, f := range found {
			first := true
			for j := 0; j < i; j++ {
				if found[j].PoolID == f.PoolID {
					first = false
					break
				}
			}
			if first && !contains(s.Seen, f.PoolID) {
				uniq = append(uniq, f)
			}
		}
		found = uniq
		open := 0
		for _, p := range s.Pools {
			if !p.Closed {
				open++
				live = append(live, livePool{p.PoolID, p.Token})
			}
		}
		room := MAX_WATCHED - open
		if room < 0 {
			room = 0
		}
		for i, f := range found {
			if i < room {
				live = append(live, livePool{f.PoolID, f.Token})
			}
		}
		if len(live) > 0 {
			tokens, pools := []string{}, []string{}
			for _, p := range live {
				tokens, pools = append(tokens, p.Token), append(pools, p.PoolID)
			}
			if mods, err = rpc.Logs(rng(map[string]interface{}{"address": PM, "topics": []interface{}{T_MOD, pools}})); err != nil {
				return err
			}
			if owns, err = rpc.Logs(rng(map[string]interface{}{"address": tokens, "topics": []interface{}{T_OWNER}})); err != nil {
				return err
			}
			if ups, err = rpc.Logs(rng(map[string]interface{}{"address": tokens, "topics": []interface{}{[]string{T_UPGRADED, T_ADMIN}}})); err != nil {
				return err
			}
			if mints, err = rpc.Logs(rng(map[string]interface{}{"address": tokens, "topics": []interface{}{T_TRANSFER, ZERO32}})); err != nil {
				return err
			}
		}
		return nil
	}()
	if readErr != nil {
		s.Retries++
		log(fmt.Sprintf("range %d-%d failed (%d/%d): %s", from, to, s.Retries, RETRIES, readErr.Error()))
		if s.Retries < RETRIES {
			return nil, readErr
		}
		s.Gaps = append(s.Gaps, Gap{Kind: "all", From: from, To: to})
		for i := range s.Pools {
			if !s.Pools[i].Closed {
				s.Pools[i].Failed++
			}
		}
		s.Retries, s.LastBlock, s.LastAt = 0, to, at
		s.Cycles++
		b := head - to
		return &CycleResult{Head: head, From: from, To: to, Gap: true, Behind: &b}, nil
	}
	s.Retries = 0

	// 2. Apply: X-ray and start watching new launches, then evaluate the five triggers.
	for _, f := range found {
		s.Seen = append(s.Seen, f.PoolID)
		if len(s.Seen) > 500 {
			s.Seen = s.Seen[len(s.Seen)-500:]
		}
		x := xray(rpc, f, head) // pinned to the head: public nodes serve contract state for recent blocks only
		s.Xrays = append(s.Xrays, x)
		if len(s.Xrays) > 50 {
			s.Xrays = s.Xrays[1:]
		}
		sym := x.Symbol
		if sym == "" {
			sym = "?"
		}
		log("launch " + sym + " " + x.Token + " via " + f.Source)
		inLive := false
		for _, p := range live {
			if p.PoolID == f.PoolID {
				inLive = true
			}
		}
		if inLive {
			s.Pools = append(s.Pools, Pool{PoolID: f.PoolID, Token: f.Token, Symbol: sym, StartBlock: f.Block, BaseBlock: f.Block + BASE_BLOCKS, UntilAt: at + WATCH_SECONDS, L0: "0", Added: "0", Removed: "0", LpFee: x.LpFee})
		} else {
			s.Gaps = append(s.Gaps, Gap{Kind: "capacity", Token: f.Token, From: f.Block, To: f.Block})
		}
	}
	liveIdx := []int{}
	for i, p := range s.Pools {
		if !p.Closed {
			liveIdx = append(liveIdx, i)
		}
	}
	if len(liveIdx) > 0 {
		for _, i := range liveIdx {
			p := &s.Pools[i]
			after := func(l Log) bool { return parseHex(l.BlockNumber) > p.BaseBlock } // inside the baseline window = baseline, not alerts
			var lastMod *Log
			L0, added, removed := bigOf(p.L0), bigOf(p.Added), bigOf(p.Removed)
			for k := range mods {
				l := mods[k]
				if l.Topics[1] != p.PoolID {
					continue
				}
				lastMod = &mods[k]
				x := int256(sub(strings.TrimPrefix(l.Data, "0x"), 128, 192))
				if !after(l) {
					L0.Add(L0, x)
				} else if x.Sign() > 0 {
					added.Add(added, x)
				} else {
					removed.Sub(removed, x)
				}
			}
			p.L0, p.Added, p.Removed = L0.String(), added.String(), removed.String()
			net := new(big.Int).Sub(removed, added)
			if L0.Sign() > 0 && new(big.Int).Mul(net, big.NewInt(4)).Cmp(L0) >= 0 && p.Fired&1 == 0 {
				p.Fired |= 1
				pm := new(big.Int).Quo(new(big.Int).Mul(net, big.NewInt(1000)), L0)
				pf, _ := new(big.Float).SetInt(pm).Float64()
				alert(s, p, "liquidity", "Net removals since the X-ray reached "+strconv.FormatFloat(pf/10, 'f', -1, 64)+"% of baseline liquidity L0", lastMod, at, 0)
			}
			for k := range owns {
				l := owns[k]
				if addr(l.Address) == p.Token && after(l) {
					p.Fired |= 2
					alert(s, p, "owner", "Owner changed to "+addr(l.Topics[2]), &owns[k], at, 0)
				}
			}
			for k := range ups {
				l := ups[k]
				if addr(l.Address) == p.Token && after(l) {
					p.Fired |= 4
					line := "Proxy admin changed to " + addr(l.Data)
					if l.Topics[0] == T_UPGRADED {
						line = "Implementation upgraded to " + addr(l.Topics[1])
					}
					alert(s, p, "upgrade", line, &ups[k], at, 0)
				}
			}
			for k := range mints {
				l := mints[k]
				if addr(l.Address) == p.Token && after(l) {
					p.Fired |= 8
					v, _ := bigHex(l.Data)
					if v == nil {
						v = new(big.Int)
					}
					alert(s, p, "mint", "Mint of "+v.String()+" base units to "+addr(l.Topics[2]), &mints[k], at, 0)
				}
			}
			p.Ok++
		}
		if s.Cycles%FEE_EVERY == 0 {
			for _, i := range liveIdx {
				p := &s.Pools[i]
				s0, err := rpc.Str("eth_call", []interface{}{map[string]string{"to": STATEVIEW, "data": "0xc815641c" + strings.TrimPrefix(p.PoolID, "0x")}, hexOf(head)})
				fee, ok := slot0Fee(s0)
				if err != nil || !ok {
					s.Gaps = append(s.Gaps, Gap{Kind: "fee", Token: p.Token, From: head, To: head})
					continue
				}
				if p.LpFee < 0 {
					p.LpFee = fee // the X-ray could not read it: the first good read is the baseline
				} else if fee != p.LpFee {
					p.Fired |= 16
					alert(s, p, "fee", "Pool LP fee changed from "+strconv.FormatInt(p.LpFee, 10)+" to "+strconv.FormatInt(fee, 10)+" pips", nil, at, head)
					p.LpFee = fee
				}
			}
		}
		for _, i := range liveIdx {
			if at >= s.Pools[i].UntilAt {
				s.Pools[i].Closed = true
				log("window closed " + s.Pools[i].Symbol + ": coverage report due")
			}
		}
	}
	kept := []Pool{}
	for _, p := range s.Pools {
		if !p.Closed || at < p.UntilAt+KEEP_CLOSED {
			kept = append(kept, p)
		}
	}
	s.Pools = kept
	s.LastBlock, s.LastAt = to, at
	s.Cycles++
	if len(s.Alerts) > 100 {
		s.Alerts = s.Alerts[len(s.Alerts)-100:]
	}
	if len(s.Gaps) > 100 {
		s.Gaps = s.Gaps[len(s.Gaps)-100:]
	}
	nf, nl, b := len(found), len(liveIdx), head-to
	return &CycleResult{Head: head, From: from, To: to, Found: &nf, Live: &nl, Behind: &b}, nil
}

// Each alert has a stable key (block, kind, token) so a re-scan after a restart re-finds the same key and the
// runtime's copy cursor never duplicates it.
func alert(s *State, p *Pool, kind, line string, l *Log, at, blockIfNoLog int64) {
	block, tx := blockIfNoLog, ""
	if l != nil {
		block, tx = parseHex(l.BlockNumber), l.TransactionHash
	}
	key := fmt.Sprintf("%010d", block) + ":" + kind + ":" + sub(p.Token, 2, len(p.Token)) // the full address: vanity tokens can share a long prefix
	for _, a := range s.Alerts {
		if a.Key == key {
			return
		}
	}
	if r := []rune(line); len(r) > 300 {
		line = string(r[:300])
	}
	s.Alerts = append(s.Alerts, Alert{Key: key, Kind: kind, Token: p.Token, Symbol: p.Symbol, PoolID: p.PoolID, Line: line, Tx: tx, Block: block, At: at})
	sort.SliceStable(s.Alerts, func(i, j int) bool { return s.Alerts[i].Key < s.Alerts[j].Key })
}

// What the managed runtime copies next: the oldest alert after its cursor, else one checkpoint page. Under 4,000
// characters. Page 0 starts a new snapshot; pages 1..n-1 come from that same snapshot, so one set describes one block
// even though the runtime copies one page per read, hours apart. If the server restarted mid-set there is no snapshot
// for that set, so a fresh one is taken: that set is incomplete and Restore() skips it.
type Bridge struct {
	Alert      *Alert      `json:"alert"`
	Checkpoint *Checkpoint `json:"checkpoint"`
}

func (s *State) Bridge(after string, page int) Bridge {
	for i := range s.Alerts {
		if s.Alerts[i].Key > after {
			a := s.Alerts[i]
			return Bridge{Alert: &a}
		}
	}
	if page == 0 || s.Snap == nil {
		gaps := append([]Gap{}, s.Gaps...)
		pools := append([]Pool{}, s.Pools...)
		s.Snap = &Snap{LastBlock: s.LastBlock, LastAt: s.LastAt, Cycles: s.Cycles, Gaps: gaps, Pools: pools}
	}
	c := checkpointOf(s.Snap.LastBlock, s.Snap.LastAt, s.Snap.Cycles, s.Snap.Pools, s.Snap.Gaps, page)
	return Bridge{Checkpoint: &c}
}

// ---------- Coverage report (spec: delivered after the 14 days, alerts or not) ----------
type Coverage struct {
	Token      string `json:"token"`
	Symbol     string `json:"symbol"`
	PoolID     string `json:"poolId"`
	StartBlock int64  `json:"startBlock"`
	BaseBlock  int64  `json:"baseBlock"`
	UntilAt    int64  `json:"untilAt"`
	Closed     bool   `json:"closed"`
	Checks     struct {
		CompleteCycles int64 `json:"completeCycles"`
		FailedQueries  int64 `json:"failedQueries"`
	} `json:"checks"`
	Gaps      []Gap    `json:"gaps"`
	Fired     []string `json:"fired"`
	Liquidity struct {
		BaselineL0   string `json:"baselineL0"`
		AddedAfter   string `json:"addedAfter"`
		RemovedAfter string `json:"removedAfter"`
	} `json:"liquidity"`
	LpFee int64 `json:"lpFee"`
}

func (s *State) Coverage(p Pool) Coverage {
	c := Coverage{Token: p.Token, Symbol: p.Symbol, PoolID: p.PoolID, StartBlock: p.StartBlock, BaseBlock: p.BaseBlock, UntilAt: p.UntilAt, Closed: p.Closed, Gaps: []Gap{}, Fired: []string{}, LpFee: p.LpFee}
	c.Checks.CompleteCycles, c.Checks.FailedQueries = p.Ok, p.Failed
	for _, g := range s.Gaps {
		if g.Token == "" || g.Token == p.Token {
			c.Gaps = append(c.Gaps, g)
		}
	}
	for i, t := range TRIGGERS {
		if p.Fired&(1<<uint(i)) != 0 {
			c.Fired = append(c.Fired, t)
		}
	}
	c.Liquidity.BaselineL0, c.Liquidity.AddedAfter, c.Liquidity.RemovedAfter = p.L0, p.Added, p.Removed
	return c
}
