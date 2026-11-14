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

| Arm | Branch | Runner | n | Total (median) | CPU step (median) | Queue | CPU step min–max (IQR) |
|---|---|---|---|---|---|---|---|
| **Baseline — cold** | `main` | GitHub `ubuntu-latest` (4 vCPU) | 3 | **569s** | **558s** | 4s | 443–563s (IQR 60) |
| Blacksmith — 4 vCPU | `migrate/tier1-easy` | `blacksmith-4vcpu-ubuntu-2404` | — | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

Run IDs (baseline-cold): `43616666722, 43617897692, 43617903976`.

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
_Pending the Blacksmith run._ Hypothesis to test: on the **same 4 vCPU**, a pure-CPU job
is bounded by single-core throughput + how many cores actually run in parallel; any
Blacksmith win here comes from faster/less-contended cores, not from caching or more vCPUs.

---

## Tier 2+ — not started
Unit shards (waiting), Docker multi-arch (arm64 emulation — likely the biggest win),
Integration + Postgres (neutralize the planted connection-limit bug first).
