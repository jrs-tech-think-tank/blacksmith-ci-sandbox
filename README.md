# Blacksmith CI Migration Lab

A/B benchmark of GitHub-hosted runners vs [Blacksmith](https://blacksmith.sh) on identical
commits, across tiered CI workloads. Goal: defensible before/after numbers (median + spread,
cold vs warm cache) that inform — not assume — a migration.

See `CLAUDE.md` for the working agreement and `LEARNINGS.md` for the running log.

## Layout

```
.github/workflows/
  tier1-baseline.yml      # Tier 1 on ubuntu-latest   (this is the "before")
  tier1-blacksmith.yml    # Tier 1 on Blacksmith       (added on the migrate branch)
app/                      # shared workload (one copy — do not fork per tier)
  scripts/                #   profile:cpu, shard-tests, integration, docker build, lint
  fixtures/               #   test-manifest.json (historical test durations)
  src/server.js
Dockerfile                # multi-arch build target (later tiers)
docker/docker-compose.yml # Postgres service for the integration tier (later)
scripts/                  # benchmarking harness (added in step 4, see below)
```

Workflow files **must** live in `.github/workflows/` (GitHub only triggers them there);
tiers are divided by filename, not by directory.

## Tiers

| Tier | Workload | Stresses | Runner (baseline → Blacksmith twin) |
|------|----------|----------|--------------------------------------|
| 1 (Easy) | Fraud model benchmark | **CPU** (pbkdf2, worker threads) | `ubuntu-latest` → `blacksmith-4vcpu-ubuntu-2404` |
| 2+ | Unit shards / Docker multi-arch / Integration+Postgres | waiting / emulation / DB I/O | TBD |

### What each Tier 1 step stresses
- `actions/checkout` + `setup-node` + `npm ci` — **I/O + a little network** (the cold/warm
  cache dimension lives here).
- `npm run profile:cpu` — **pure CPU**: 256 tasks of pbkdf2-sha512 across 8 worker threads.
  This is the part a faster runner should actually speed up.

## How to run a tier

Workflows are **manual** (`workflow_dispatch`) with a `cache_mode` input so every run is
deliberate and labeled.

```bash
# Baseline, cold cache:
gh workflow run tier1-baseline.yml -f cache_mode=cold
# Baseline, warm cache (run 2+ times; first run populates the cache):
gh workflow run tier1-baseline.yml -f cache_mode=warm

# Watch:
gh run list --workflow=tier1-baseline.yml
gh run watch <run-id>
```

Blacksmith twin (added later on the `migrate/tier1-easy` branch):
```bash
gh workflow run tier1-blacksmith.yml -f cache_mode=cold
```

## Run the workload locally (smoke test, not a benchmark)

```bash
cd app && npm ci
npm run lint && npm run build
npm run docker:arch-check
# fast smoke (tiny params) so it finishes quickly:
PROFILE_CPU_TASKS=4 PROFILE_CPU_ITERATIONS=50000 PROFILE_CPU_WORKERS=2 node scripts/resource-profile.js cpu
TEST_DURATION_SCALE=0.002 node scripts/shard-tests.js --shard=1/8
```
The integration (`test:integration`) and docker tiers need Docker + Postgres and are
validated in CI rather than locally.

## Benchmarking harness

A measurement script (added once the method is agreed — see `CLAUDE.md`) pulls per-job and
per-step durations via `gh`/REST into CSV/JSON, separates **queue vs execution time**, and
reports **median + spread** across runs. Secondary signal: the Blacksmith dashboard for
CPU/memory utilization (Blacksmith runs only — it cannot see GitHub-hosted baseline usage).
