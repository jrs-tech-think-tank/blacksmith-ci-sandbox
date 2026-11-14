# LEARNINGS — running log

Newest first. Capture what worked, what didn't, and open questions. Keep it honest —
negative results (a tier Blacksmith does *not* speed up) are findings too.

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
