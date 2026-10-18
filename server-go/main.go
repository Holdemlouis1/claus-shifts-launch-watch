// Claus Shifts · Launch Watch server entry point (Go port of server/server.mjs). MIT.
// HTTP mode, port 8080, health at /health. Public read-only endpoints:
//
//	/health                       liveness + how far behind the chain head the watcher is
//	/checkpoint.json?page=N       compact state in pages (each under 4,000 characters)
//	/state.json                   pools, recent alerts, gaps, recent X-rays and RPC call counts
//	/coverage.json                one coverage report per pool (closed windows first)
//	/bridge.json?after=KEY&page=N what Claus Shifts' runtime copies next: the oldest alert after KEY, else checkpoint page N
//
// No request ever changes state. Nothing here holds a key, signs, or writes to the network.
// The LW_* environment variables exist only for the local test harness; the deployed manifest sets none, so the
// defaults below are what runs.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	RPCS        = []string{"https://ethereum-rpc.publicnode.com", "https://gateway.tenderly.co/public/mainnet"} // keyless public endpoints; Tenderly also serves full log history for catch-up
	CHECKPOINTS = "https://claus-network-api.vercel.app/v1/public/apps/prj_fe5de2f5-b5b2-478c-a1e7-79b97fe99aa4/records?collection=watchstate&limit=100"
	// Only Claus Shifts' own managed runtime (one of its nine slot principals) may supply a checkpoint.
	WRITERS = map[string]bool{
		"runtime_26f2ea55e7956c83237e03b3f53386ee37b44da53bd7ce28ff1f13e78a96eb56": true, "runtime_ed17cd2c1102a32befbbec6e223f1a3724bb837b9d145da92314eb10a1c994ba": true,
		"runtime_305273810996bbc06e140c6017ec968669f663df4dba08f7d2dff2200be6d20a": true, "runtime_d57813ed2ce98659227c5d64a7f72ddb2282d2f277fcc75239a1c76e8bc3c7f1": true,
		"runtime_92f1f6b6198eb0d4f4abecd07f5dad4c06209136116a2c91fa208fe5c6dec007": true, "runtime_b8db15e8aa3aac1fcffb67bcfcf9be5ba5fca982e34a012ddb9bb684b794eebd": true,
		"runtime_1e06cb2d74ed635b0cf4ef9b9579db13ae64dff050cff675a073ddc4753f66e8": true, "runtime_64c053e46cb2b5c8842d66aa94db7dcfd0b90b1c874b96ad93d0fd8514ad6eeb": true,
		"runtime_9f763ad854c82ff6e9b297a71e4f6ab33abf8508492e42970bc68c94b64b684f": true}
	PORT     = "8080"
	INTERVAL = 5 * time.Minute
	SPEC     = "https://claus.si/c/claus-shifts/pages/launch-watch.html"
	afterRe  = regexp.MustCompile(`^[0-9a-z:]{0,80}$`)
)

type Boot struct {
	At   int64  `json:"at"`
	From string `json:"from"`
}

var (
	mu        sync.Mutex
	s         *State
	boot      = Boot{At: time.Now().UnixMilli(), From: "unknown"}
	lastCycle *CycleResult
	okAt      int64
	rpc       *RPC
	running   bool
)

func logf(m string) { fmt.Println(time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + m) }

// Restart: resume from the newest complete public checkpoint set written by our runtime. Without one, start at the
// current head and say so: earlier blocks are a stated gap, never reported as checked.
func start() {
	var restored *State
	func() {
		client := &http.Client{Timeout: 15 * time.Second}
		r, err := client.Get(CHECKPOINTS)
		if err != nil {
			logf("checkpoint read failed: " + err.Error())
			return
		}
		defer r.Body.Close()
		var j struct {
			Items []json.RawMessage `json:"items"`
		}
		if r.StatusCode/100 != 2 || json.NewDecoder(r.Body).Decode(&j) != nil {
			return
		}
		type item struct {
			AuthorID  string  `json:"authorId"`
			CreatedAt float64 `json:"createdAt"`
			Data      CheckpointIn
		}
		items := []item{}
		for _, raw := range j.Items {
			var head struct {
				AuthorID  string                     `json:"authorId"`
				CreatedAt float64                    `json:"createdAt"`
				Data      map[string]json.RawMessage `json:"data"`
			}
			if json.Unmarshal(raw, &head) != nil || !WRITERS[head.AuthorID] || head.Data == nil {
				continue
			}
			var lb float64
			if json.Unmarshal(head.Data["lastBlock"], &lb) != nil || lb != float64(int64(lb)) {
				continue
			}
			if p, ok := head.Data["pools"]; !ok || len(p) == 0 || p[0] != '[' {
				continue
			}
			var d CheckpointIn
			b, _ := json.Marshal(head.Data)
			if json.Unmarshal(b, &d) != nil {
				continue
			}
			items = append(items, item{head.AuthorID, head.CreatedAt, d})
		}
		sort.SliceStable(items, func(a, b int) bool { return items[a].CreatedAt > items[b].CreatedAt })
		pages := []CheckpointIn{}
		for _, it := range items {
			pages = append(pages, it.Data)
		}
		if len(pages) > 0 {
			if restored = Restore(pages); restored != nil {
				boot.From = "complete checkpoint set at block " + strconv.FormatInt(restored.LastBlock, 10) + " (" + strconv.Itoa(len(restored.Pools)) + " pools)"
			} else {
				logf("no complete checkpoint set among " + strconv.Itoa(len(pages)) + " pages")
			}
		}
	}()
	if restored == nil {
		for {
			hs, err := rpc.Str("eth_blockNumber", []interface{}{})
			if err == nil {
				head := parseHex(hs)
				restored = EmptyState(head)
				restored.Gaps = append(restored.Gaps, Gap{Kind: "cold-start", From: 0, To: head})
				boot.From = "cold start at block " + strconv.FormatInt(head, 10)
				break
			}
			logf("head read failed, retrying: " + err.Error())
			time.Sleep(30 * time.Second)
		}
	}
	mu.Lock()
	s = restored
	mu.Unlock()
	logf("started from " + boot.From)
}

// One tick: catch up in bounded steps after an outage; each step is a normal cycle with its own coverage. Cycles run
// on a copy, so HTTP reads never wait on the network.
func tick() {
	mu.Lock()
	if running || s == nil {
		mu.Unlock()
		return
	}
	running = true
	work := s.Clone()
	mu.Unlock()
	var res *CycleResult
	var ok int64
	for i := 0; i < 12; i++ {
		r, err := Cycle(rpc, work, logf)
		if err != nil {
			logf("cycle failed, will retry: " + err.Error())
			msg := err.Error()
			if len(msg) > 200 {
				msg = msg[:200]
			}
			res = &CycleResult{Error: &msg, At: time.Now().UnixMilli()}
			break
		}
		res, ok = r, time.Now().UnixMilli()
		if r.Idle || (r.Behind != nil && *r.Behind <= 0) {
			break
		}
	}
	mu.Lock()
	work.Snap = s.Snap
	s = work
	lastCycle = res
	if ok > 0 {
		okAt = ok
	}
	running = false
	mu.Unlock()
}

func send(w http.ResponseWriter, code int, body interface{}) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("access-control-allow-origin", "*")
	w.WriteHeader(code)
	e := json.NewEncoder(w)
	e.SetEscapeHTML(false)
	e.Encode(body)
}
func intParam(r *http.Request, k string) int {
	v := r.URL.Query().Get(k)
	end := 0
	for end < len(v) && v[end] >= '0' && v[end] <= '9' {
		end++
	}
	n, _ := strconv.Atoi(v[:end])
	if n < 0 {
		n = 0
	}
	return n
}

func handler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		send(w, 405, map[string]string{"error": "read_only"})
		return
	}
	mu.Lock()
	defer mu.Unlock()
	if s == nil {
		send(w, 503, map[string]bool{"starting": true})
		return
	}
	switch r.URL.Path {
	case "/health": // healthy = alive and a successful cycle within the last hour; one failed RPC round is not a reason to restart
		since := okAt
		if since == 0 {
			since = boot.At
		}
		stale := time.Now().UnixMilli()-since > 3600000
		h := map[string]interface{}{"ok": !stale, "lastBlock": s.LastBlock, "lastAt": s.LastAt, "lastError": nil, "boot": boot}
		if lastCycle == nil {
			h["behind"] = nil
		} else {
			if lastCycle.Behind != nil {
				h["behind"] = *lastCycle.Behind
			}
			if lastCycle.Error != nil {
				h["lastError"] = *lastCycle.Error
			}
		}
		code := 200
		if stale {
			code = 503
		}
		send(w, code, h)
	case "/checkpoint.json":
		send(w, 200, s.Checkpoint(intParam(r, "page")))
	case "/bridge.json":
		after := r.URL.Query().Get("after")
		if !afterRe.MatchString(after) {
			after = ""
		}
		send(w, 200, s.Bridge(after, intParam(r, "page")))
	case "/state.json":
		send(w, 200, map[string]interface{}{"lastBlock": s.LastBlock, "lastAt": s.LastAt, "cycles": s.Cycles, "pools": s.Pools, "alerts": s.Alerts, "gaps": s.Gaps, "xrays": s.Xrays, "rpcCalls": rpc.CountsCopy(), "boot": boot, "spec": SPEC})
	case "/coverage.json":
		ps := append([]Pool{}, s.Pools...)
		sort.SliceStable(ps, func(a, b int) bool { return ps[a].Closed && !ps[b].Closed })
		out := []Coverage{}
		for _, p := range ps {
			out = append(out, s.Coverage(p))
		}
		send(w, 200, out)
	default:
		send(w, 404, map[string]string{"error": "not_found"})
	}
}

func main() {
	if v := os.Getenv("LW_RPCS"); v != "" {
		RPCS = strings.Split(v, ",")
	}
	if v := os.Getenv("LW_CHECKPOINTS"); v != "" {
		CHECKPOINTS = v
	}
	if v := os.Getenv("LW_PORT"); v != "" {
		PORT = v
	}
	if v, err := strconv.Atoi(os.Getenv("LW_INTERVAL_MS")); err == nil && v > 0 {
		INTERVAL = time.Duration(v) * time.Millisecond
	}
	rpc = &RPC{URLs: RPCS, Client: &http.Client{}, Counts: map[string]int{}}
	http.HandleFunc("/", handler)
	go func() {
		logf("listening on " + PORT)
		if err := http.ListenAndServe(":"+PORT, nil); err != nil {
			logf("listen failed: " + err.Error())
			os.Exit(1)
		}
	}()
	start()
	tick()
	for range time.Tick(INTERVAL) {
		go tick()
	}
}
