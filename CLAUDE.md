# Blacksmith CI Migration Lab — Working Agreement

Persisted so it survives across sessions. If something here is stale, fix it.

## Purpose
A/B benchmark GitHub-hosted runners (`ubuntu-latest`) vs Blacksmith on the same
commits, across tiered CI workloads, and produce defensible numbers (median +
spread, cold vs warm cache) **before** migrating anything. The human drives the
migration; Claude scaffolds baselines, builds the measurement harness, and coaches.

## Roles
- **Human (James):** performs the `runs-on` swaps and optimizations, installs/configures
  Blacksmith, approves every push and every run.
- **Claude:** writes baseline workflows + scripts + docs, reviews the human's Blacksmith
  variants, pulls and interprets timings. Does not push or trigger runs without approval.

## Benchmarking method (agreed before any migration)
- **Primary = controlled A/B.** Same commit, same workload code, `ubuntu-latest` baseline
  vs Blacksmith. Several runs each. Cold and warm cache reported **separately**.
- Baseline and Blacksmith variants are **separate files** (`tierN-baseline.yml`,
  `tierN-blacksmith.yml`) that coexist on one branch → one push triggers both → the only
  variable is the runner. Never overwrite the baseline file to migrate.
- **Freeze the workload** once baselines are captured. Migration branches change only
  runner/infra config (runs-on, cache actions, buildx), never the app scripts/fixtures/
  Dockerfile. Otherwise the A/B has two variables.
- A measurement script (see README) pulls **per-job and per-step** durations via `gh`/REST
  to CSV/JSON and reports **median + spread (min/max or IQR)**, never single runs. It
  separates **queue time from execution time**.
- **Secondary = Blacksmith dashboard** for CPU/memory utilization. It cannot show
  utilization for GitHub-hosted baseline runs, so utilization is Blacksmith-only.

## Confounders to flag whenever they apply
- Noisy neighbors; first-run cache population; cache eviction after inactivity.
- Queue time vs execution time (always separated).
- Baseline `ubuntu-latest` vCPU differs by repo visibility: **public = 4 vCPU, private =
  2 vCPU** (verify current numbers each time). This repo is **public** → 4 vCPU baseline.
- GitHub *larger* runners (`ubuntu-latest-N-cores`) need Team/Enterprise; the
  `jrs-tech-think-tank` org is **free**, so those labels won't run — baselines use plain
  `ubuntu-latest`.

## Tiers
- **Tier 1 (Easy):** Fraud model benchmark only — pure CPU (pbkdf2 in worker threads).
  Cleanest runner-speed signal. Cache dimension = npm cache. Blacksmith twin =
  `blacksmith-4vcpu-ubuntu-2404`.
- **Tier 2+ (later):** unit-test shards (waiting workload + matrix), docker multi-arch
  (amd64 + arm64 emulation — the clearest Blacksmith win), integration + Postgres service
  (note the planted connection-limit bug; neutralize it for clean timing).

## Repo / infra facts
- Host: `jrs-tech-think-tank` org (free plan), **public** repo.
- Blacksmith is org-only; requires the blacksmith.sh GitHub App installed on the org with
  access to this repo, or Blacksmith jobs queue forever.
- Workflows are `workflow_dispatch` with a `cache_mode` input (`cold`/`warm`) so runs are
  deliberate and labeled, not auto-triggered on push.

## Output per tier
Results table: baseline vs Blacksmith, cold vs warm, by runner size — plus a short takeaway.

## Session cadence
This session stops after: scaffold + baseline workflow + propose/agree measurement method
+ run baselines (on approval) + ask for the human's prediction of the first `runs-on` swap.
