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

## Tier 2b (arm64) — not started
Native `blacksmith-4vcpu-ubuntu-2404-arm` vs QEMU emulation on a hosted amd64 runner.
Expected to be the dramatic, workload-independent win.

## Tier 3+ — not started
Unit shards (waiting → expect ~flat), Integration + Postgres (neutralize the planted
connection-limit bug first).
