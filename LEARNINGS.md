# LEARNINGS — running log

Newest first. Capture what worked, what didn't, and open questions. Keep it honest —
negative results (a tier Blacksmith does *not* speed up) are findings too.

## 2026-11-15 — Tier 3 unit shards (the negative result) + email scrub

- Waiting workload (setTimeout sleeps): Blacksmith gave **no speedup**, marginally slower
  (long-pole 75s vs 70s) purely from higher queue. Expected — faster cores can't speed up
  waiting. Counterweight to Tier 1's 3.8×: same swap, opposite result, different workload.
- **Bottleneck is sharding, not the runner:** shard 3/8 ~65s (3 long tests via idx%8) vs ~15s
  others. Rebalancing → ~25s matrix, a bigger free win than any runner change.
- Blacksmith app access survived the repo recreate (picked up on native runner immediately)
  → user is on "all repositories".
- **Gotcha: repo recreate broke the Blacksmith DASHBOARD (not the runners).** New repo ID →
  runners still provisioned (org app), but the dashboard/results backend didn't register the
  new repo → job pages 404'd and it showed the OLD deleted repo's history. **Fix that worked:**
  reconfigure the Blacksmith GitHub App's repo access (toggle to "select repos" + add the repo,
  Save → fires installation_repositories webhook → re-registers). Historical runs don't backfill;
  new runs appear. Confirmed via run 43754595649. Dashboard then showed shard 3/8 as the long pole.
- **Repo scrub done:** deleted + recreated repo to remove Datadog email (force-push wasn't
  enough — old SHAs stayed fetchable + Actions runs baked in the author email). New repo:
  noreply-only, 0 old runs, old SHAs 422. Preference saved to memory.

## 2026-11-14 — Tier 2b arm64 result (native vs QEMU = clearest win)

- Cold Docker build step: **48s emulated → 12s native = 4×**. Warm converges (6s vs 4s).
- Emulation tax is only paid on cache-cold builds (the common real case); warm rebuilds
  don't re-run emulated instructions so they tie.
- Confounder: Blacksmith arm runner queue higher (10–11s vs 3–4s) → total only 1.7× cold
  even though build step is 4×. Quote the build-step number, not the total.
- Actions used: tier2b-baseline = docker/setup-qemu-action@v3 + buildx; tier2b-blacksmith =
  native `-arm` runner + useblacksmith setup-docker-builder@v2/build-push-action@v2, no QEMU.
- n=1 caveat, but 36s gap >> noise.

## 2026-11-14 — Tier 2 amd64 result (nuanced — caching is workload-dependent)

- 4 arms (n=1 each): totals baseline cold 47s / warm 23s; Blacksmith cold **29s** / warm 23s.
- **Blacksmith has almost no cold-start penalty** (29s vs its warm 23s) because its builder
  disk is persistent (base images + layers survive) — hosted cold is 2× its warm (empty
  ephemeral builder each run). Docker build step: 22s→7s cold; 3s≈3s warm.
- **Warm is a tie** for this *small* image — GHA cache handles small layers fine. The famous
  "40×" needs cache-heavy builds (big base images / native deps). Our image is too light.
- **Prediction check:** I predicted Blacksmith would crush the *warm* Docker build — WRONG.
  The win was cold-start/consistency, not warm throughput. Good reminder: measure, don't assume.
- Build gotchas: OSV policy blocked zod@3.25.76 and esbuild@0.24.2 → dropped zod, bumped esbuild.
- Caveat: n=1, small absolute times → small deltas are indicative only.
- Next: Tier 2b arm64 (native vs QEMU) = the clearer, workload-independent win; or beef up
  the image to actually exercise the layer cache.

## 2026-11-14 — Tier 1 Blacksmith result (the payoff)

- **Blacksmith 4 vCPU (n=2) vs ubuntu-latest 4 vCPU (n=3): CPU step 147.5s vs 558s → ~3.8×
  faster on the SAME vCPU count.** Total 163s vs 569s (~3.5×).
- **Variance collapsed:** Blacksmith CPU step 146–149s (IQR 1.5) vs baseline 443–563s (IQR 60).
- **Why (the "how/why" the user wanted):** vCPU count ≠ performance. Hosted = shared, older,
  hyperthreaded, noisy. Blacksmith = dedicated modern cores. Not caching, not more cores.
- Mechanics learned this session:
  - `workflow_dispatch` workflows must exist on the **default branch** to be triggerable
    (feature-branch-only → 404). So `tier1-blacksmith.yml` lives on `main` (dispatch-only,
    harmless); `tier1-baseline.yml` stays untouched → clean separate-files A/B.
  - Blacksmith wizard edits `runs-on` **in place** + swaps `actions/checkout` →
    `useblacksmith/checkout@v1`. We superseded its PR with a separate-file layout.
  - Blacksmith picked the job up in ~8s on a real `blacksmith-*-4vcpu` runner → app wired.
- Next tiers to test the "biggest wins on compute/variance" thesis: Docker arm64 (emulation
  vs native), unit shards (waiting — expect ~flat), integration+Postgres (fix the bug first).

## 2026-11-14 — Tier 1 baseline numbers (3 cold runs)

- **Baseline (ubuntu-latest, 4 vCPU, n=3):** total median **569s**, CPU step median **558s**,
  queue ~4s, `npm ci` ~1s. See `RESULTS.md` for the table.
- **Big finding — variance:** CPU step ranged **443–563s** across identical runs (~27% swing).
  Noisy neighbors on hosted runners; this is why single runs lie and we report spread.
- cold ≈ warm confirmed for Tier 1 (npm ci ~1s) → no separate warm arm.
- Decision: user wants a lean demo (1–3 runs/arm), not a stats paper. Public repo →
  standard-runner minutes are free; the real cost is ~9.5 min wall-clock per run. Quieted
  bench.js polling to cut token/output noise.
- Next: user predicts the `runs-on` swap effect, then migrates on `migrate/tier1-easy`.

## 2026-11-14 — Scaffold + Tier 1 baseline

### What worked
- Restored the seed workload into `app/` and smoke-tested every runnable script locally
  on Node 26 (macOS, Apple M4 Max): `npm ci`, `lint`, `build`, `docker:arch-check`,
  `shard-tests`, `profile:cpu` all pass. (Ran `profile:cpu` with tiny params as a smoke
  test, not the full benchmark.)
- `tier1-baseline.yml` written as `workflow_dispatch`-only with a `cache_mode` input so
  pushing the scaffold does not auto-trigger a benchmark run.

### What we observed / noted
- **Lumpy sharding:** round-robin `idx % 8` puts all three long tests (balance=160s,
  ledger=140s, subscription=100s historical; indices 2/10/18) on **shard 3/8**. So the
  8-way unit matrix is bottlenecked by one shard — a faster runner won't fix an imbalance.
  Relevant when we get to the unit-test tier.
- **Unit tests `sleep`, they don't compute** — a faster runner barely helps them. Expect a
  near-flat baseline-vs-Blacksmith result for that tier (a useful negative result).
- **Integration job is likely intentionally broken:** `INTEGRATION_WORKERS=auto` →
  `cpus*3` workers × pool 4 can demand ~192 connections vs Postgres `max_connections=20`.
  Bigger/faster runner → more workers → fails harder. Must neutralize for clean timing.
- **arm64 docker build runs under QEMU emulation** on x86 runners → slow; Blacksmith native
  arm64 runners are the obvious win to measure later.

### Environment facts verified
- `gh` authed as `JamesSheaDev`, SSH git protocol, scopes incl. `repo`, `read:org`.
- Org `jrs-tech-think-tank` = **free plan** → no GitHub larger runners.
- Docker CLI not installed on this Mac → integration/docker tiers validate in CI only.
- Blacksmith runner tags (Nov 2026 docs): `blacksmith-<N>vcpu-ubuntu-2404` (+`-arm`),
  sizes 2/4/8/16/32 vCPU; 4vcpu = 16 GB/80 GB (arm 4vcpu = 12 GB/75 GB); ubuntu-2204
  deprecated. Free tier: 3,000 x64 2-vCPU min/mo + 25 GB weekly cache.

### Open questions
- Exact current public-repo `ubuntu-latest` vCPU (believed 4) — confirm from a real run's
  `cpu_count`/`nproc` before quoting.
- Does the free Blacksmith tier impose runner-size caps we'll hit at 8/16 vCPU tiers?
- Cold-vs-warm delta on Tier 1 may be tiny (only `pg` deps) — decide if it's worth
  reporting or just noting as "negligible for small dep sets."
