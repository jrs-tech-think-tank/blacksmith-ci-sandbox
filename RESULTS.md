# Results — baseline vs Blacksmith

Running A/B log. One section per tier. Numbers come from `scripts/bench.js` (per-step
timings via the GitHub Actions API, median + spread across runs, queue separated from
execution). Raw artifacts land in `results/*.json` and `*.csv` (gitignored).

**How to read it:** `total` = queue + execution wall-clock for the job. The **Fraud
benchmark step** is the pure-CPU part — that's the number a faster runner should move.
`npm ci` is tiny here, so cold vs warm cache is negligible for Tier 1 (confirmed below).

---

## Tier 1 (Easy) — Fraud model benchmark (pure CPU)

Workload: 256 pbkdf2-sha512 tasks × 9.5M iters across 8 worker threads. Identical on both
arms; only `runs-on` differs.

| Arm | Runner | n | Total (median) | CPU step (median) | Queue | CPU step min–max (IQR) |
|---|---|---|---|---|---|---|
| **Baseline — cold** | GitHub `ubuntu-latest` (4 vCPU) | 3 | **569s** | **558s** | 4s | 443–563s (IQR 60) |
| **Blacksmith — cold** | `blacksmith-4vcpu-ubuntu-2404` | 2 | **163s** | **147.5s** | 7.5s | 146–149s (IQR 1.5) |
| **Delta** | same 4 vCPU | | **3.5× faster** | **3.8× faster** | +3.5s | **variance 40× tighter** |

Run IDs — baseline: `43616666722, 43617897692, 43617903976` · Blacksmith: `43620982384, 43621044523`.

### Observations so far
- **CPU step dominates** (558 of 569s). Checkout + setup-node + `npm ci` ≈ 2–3s combined.
- **cold ≈ warm for Tier 1:** `npm ci` is ~1s (only `pg` + deps). No separate warm arm needed.
- **Hosted-runner variance is large:** identical runs ranged **443–563s on the CPU step**
  — a ~120s (~27%) swing. This is the noisy-neighbor confounder, and the reason single
  runs mislead. Keep this in mind when comparing to Blacksmith: a small delta could be
  noise; a large, consistent delta is signal.
- Confirmed from the run metadata: baseline runner is GitHub-hosted (`GitHub Actions
  10000000xx`). Still want to confirm vCPU directly from `nproc`/`cpu_count` in-log.

### Takeaway
**Blacksmith ran the identical CPU workload ~3.8× faster on the same vCPU count (558s →
147.5s), and ~40× more consistently (IQR 60s → 1.5s).** The win is *not* caching or more
cores — it's the hardware behind "4 vCPU":

- GitHub-hosted `ubuntu-latest` runs on **shared, older/throttled vCPUs** (4 vCPU ≈ 2
  physical cores with hyperthreading on an aging Azure SKU). Per-core throughput is modest
  and **variable** (noisy neighbors → the 443–563s swing).
- Blacksmith maps vCPU to **dedicated modern cores** (high clock/IPC, bare-metal-class),
  so each pbkdf2 task finishes much faster, and with no neighbor contention the spread
  nearly vanishes.

So the lesson: **"vCPU count" is not a performance spec.** For CPU-bound CI, the generation
and dedication of the cores dominate. Expect the biggest wins on compute-heavy jobs
(builds, test suites that actually compute) and on jobs that suffer from hosted-runner
variance. Confounders noted: n is small (2 vs 3), but the effect (3.8×) dwarfs the noise
(IQR 1.5s); cold-cache only (warm ≈ cold here); `useblacksmith/checkout` adds ~1–2s but
doesn't touch the CPU result.

---

## Tier 2 (amd64) — Docker build + npm cache

Workload: `npm ci` (84 pkgs) → typecheck → esbuild bundle → multi-stage Docker build.
Baseline uses GHA layer cache; Blacksmith uses its persistent on-disk layer cache.
**n=1 per arm** — small absolute times, so treat small deltas as indicative, not proven.

| Arm | Runner | Total | Docker build step | npm ci | Builder setup |
|---|---|---|---|---|---|
| Baseline — **cold** | ubuntu-latest | 47s | 22s | 2s | 8s |
| Baseline — **warm** | ubuntu-latest | 23s | 3s | 2s | 6s |
| Blacksmith — **cold** | blacksmith-4vcpu | **29s** | **7s** | 1s | 5s |
| Blacksmith — **warm** | blacksmith-4vcpu | **23s** | 3s | 1s | 2s |

Run IDs — base cold `43623914397`, base warm `43624018576`, bsmith cold `43623922237`,
bsmith warm `43624026289`.

### Observations
- **Blacksmith barely has a cold-start penalty** (cold 29s vs its own warm 23s), while the
  **hosted cold is 2× its own warm** (47s vs 23s). Reason: Blacksmith's builder disk is
  *persistent* — base images and layers survive across runs, so even a `no-cache` build
  skips the base-image pull and spins the builder up faster. The hosted runner starts
  from an empty, ephemeral builder every time.
- **Warm is essentially a tie (23s vs 23s).** For a *small* image, GitHub's GHA cache
  restores layers just fine — so Blacksmith's cache advantage doesn't show up here.
- `npm ci` (1–2s) and the bundle are too small to reveal the colocated-cache edge.

### Takeaway (honest)
**Blacksmith's win here is cold-start / consistency, not warm throughput.** The headline
"up to 40× faster Docker builds" is real but applies to **cache-heavy builds** — large base
images, big/native dependency layers — where GHA's network import/export latency dominates.
Our image is tiny, so we see only the cold-start edge (~1.6× on total cold) and a warm tie.
**Lesson: the caching win is workload-dependent — measure your actual image.** To make this
pop we'd need a heavier image; the clearer, workload-independent win is Tier 2b (arm64
native vs QEMU emulation). Caveat: n=1 — the small warm/cold deltas need more reps to trust.

## Tier 2b (arm64) — QEMU emulation vs native arm

Same image/Dockerfile as Tier 2, built for `linux/arm64`. Baseline emulates arm64 via QEMU
on an amd64 hosted runner; Blacksmith runs on a **native** `blacksmith-4vcpu-ubuntu-2404-arm`.
**n=1 per arm.**

| Arm | Runner | Total | Docker build step | Queue |
|---|---|---|---|---|
| Baseline — **cold** | ubuntu-latest + QEMU | 78s | **48s** | 3s |
| Blacksmith — **cold** | blacksmith-4vcpu-arm | **45s** | **12s** | 11s |
| Baseline — **warm** | ubuntu-latest + QEMU | 29s | 6s | 4s |
| Blacksmith — **warm** | blacksmith-4vcpu-arm | 28s | 4s | 10s |

Run IDs — base cold `43625168026`, bsmith cold `43625176726`, base warm `43625670335`,
bsmith warm `43625678872`.

### Observations
- **Cold build step: 48s (emulated) → 12s (native) = 4× faster.** That gap is the QEMU
  binary-translation tax; native arm silicon removes it.
- **Warm converges** (6s vs 4s; totals 29s ≈ 28s). A warm cache skips re-running the
  emulated instructions, so the tax is only paid on cache-cold builds — which is the
  common real-world case (new deps / Dockerfile edits / PRs).
- **Confounder:** Blacksmith arm runner queue was higher (10–11s vs 3–4s hosted) — arm VM
  spin-up. It dilutes the *total* (1.7× cold) even though the *build* is 4×.

### Takeaway
Native arm64 is **~4× faster than emulation on cold builds** — the clearest workload-
independent Blacksmith win in the lab, and the common case for arm64 CI. Quote the 4× on
the *build step*, not the total; note arm queue is a touch higher. n=1 caveat, but a
36s build-step gap is well beyond noise.

## Tier 3 — unit-test shards (waiting workload, 8-way matrix)

Reuses `app/` `shard-tests.js` (setTimeout sleeps, not CPU). Same matrix on both arms;
only `runs-on` differs. **n=1 per arm.**

| | Baseline (ubuntu-latest) | Blacksmith (4 vCPU) |
|---|---|---|
| Matrix long-pole — shard 3/8 (total) | **70s** (exec 65s) | **75s** (exec 68s) |
| Other 7 shards (total) | ~14–21s | ~18–19s |
| Queue (per job) | 5–6s | 7–8s |

Run IDs — baseline `43749167490`, blacksmith `43749176382`.

### Observations
- **No speedup — Blacksmith marginally slower** (75s vs 70s), all from higher queue. Expected:
  the workload is fixed wall-clock sleeping, which faster cores cannot accelerate.
- **The matrix is gated by lumpy sharding, not the runner.** Round-robin `idx%8` piles the 3
  long tests onto shard 3 (~65s) while the other 7 finish in ~15s. Rebalancing shards would
  cut the matrix to ~25s — a bigger, free win than any runner change.

### Takeaway
The counterweight to Tier 1: the *same* `runs-on` swap that gave 3.8× on CPU gives **nothing**
on a waiting workload. Match the runner to the bottleneck — and for this job the bottleneck is
shard balance, which measurement exposed and a faster runner would have masked.

### Optimization — balanced (LPT) sharding (same Blacksmith runner, sharding is the only variable)

| Strategy | Matrix long-pole | Per-shard exec |
|---|---|---|
| round-robin (legacy, `idx%8`) | **74s** | shard 3 = 67s, rest ~10s |
| balanced (LPT) | **38s** | 31 / 27 / 22 / 11 / 11 / 12 / 12 / 12s |

Run IDs — round-robin `43754595649`, balanced `43755935629`. Toggle: `shard_strategy` input
(or `SHARD_STRATEGY=balanced`); logic in `app/scripts/shard-tests.js`.

**~1.9× faster (−36s), free, no infra change** — the 3 long tests now land on separate shards.
That −36s is a *bigger absolute win than the Blacksmith runner swap gave on this tier* (~0). The
lesson of the whole lab in one tier: measure → find the real bottleneck → fix it. The matrix now
floors at the single longest test (~24s exec), which no sharding can split — the next lever would
be splitting that test itself.

## Tier 3b — Integration + Postgres (not started)
Service-container + the planted connection-limit bug (`cpus*3` workers × pool 4 vs
`max_connections=20`). Better framed as a **debugging/observability showcase** (Blacksmith
SSH into a live failing job) than a timing A/B; neutralize the bug first if used for timing.
