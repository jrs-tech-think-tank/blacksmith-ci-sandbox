#!/usr/bin/env node
'use strict';

// A/B benchmarking harness for the Blacksmith migration lab.
//
// Runs locally (not inside CI), shells out to `gh`, and pulls per-job / per-step
// timings from the GitHub Actions API. Separates queue time from execution time
// and reports median + spread (min/max + IQR) across N runs — never a single run.
//
// Usage:
//   node scripts/bench.js --workflow tier1-baseline.yml --cache-mode cold --runs 5 --label baseline-cold
//   node scripts/bench.js --workflow tier1-baseline.yml --cache-mode warm --runs 5 --warmup 1 --label baseline-warm
//   node scripts/bench.js --collect-only --label baseline-cold --ids 123,124,125
//
// Output: results/<label>.csv (one row per step per run) + results/<label>.json
// (raw + summary), and a printed table.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function gh(apiArgs) {
  const out = execFileSync('gh', apiArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out;
}

function ghJson(apiArgs) {
  return JSON.parse(gh(apiArgs));
}

function repoSlug() {
  return gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runIdsFor(repo, workflow) {
  const data = ghJson([
    'api',
    `repos/${repo}/actions/workflows/${workflow}/runs?per_page=100`,
  ]);
  return (data.workflow_runs || []).map((r) => r.id);
}

async function dispatchAndDetect(repo, workflow, cacheMode, knownIds) {
  gh(['workflow', 'run', workflow, '--ref', 'main', '-f', `cache_mode=${cacheMode}`]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(2000);
    const ids = runIdsFor(repo, workflow);
    const fresh = ids.find((id) => !knownIds.has(id));
    if (fresh !== undefined) {
      knownIds.add(fresh);
      return fresh;
    }
  }
  throw new Error('timed out waiting for dispatched run to appear');
}

async function waitForCompletion(repo, ids) {
  const pending = new Set(ids);
  while (pending.size > 0) {
    await sleep(10000);
    for (const id of Array.from(pending)) {
      const run = ghJson(['api', `repos/${repo}/actions/runs/${id}`]);
      if (run.status === 'completed') {
        pending.delete(id);
        const mark = run.conclusion === 'success' ? 'ok' : `!! ${run.conclusion}`;
        process.stdout.write(`  run ${id}: ${mark}\n`);
      }
    }
    if (pending.size > 0) {
      process.stdout.write(`  ...waiting on ${pending.size} run(s)\n`);
    }
  }
}

function secondsBetween(a, b) {
  return (Date.parse(b) - Date.parse(a)) / 1000;
}

function collectRun(repo, id) {
  const run = ghJson(['api', `repos/${repo}/actions/runs/${id}`]);
  const jobsData = ghJson(['api', `repos/${repo}/actions/runs/${id}/jobs`]);
  const created = run.created_at;
  const jobs = (jobsData.jobs || []).map((job) => {
    const queueS = secondsBetween(created, job.started_at);
    const execS = secondsBetween(job.started_at, job.completed_at);
    const steps = (job.steps || [])
      .filter((s) => s.started_at && s.completed_at)
      .map((s) => ({
        name: s.name,
        number: s.number,
        conclusion: s.conclusion,
        durationS: secondsBetween(s.started_at, s.completed_at),
      }));
    return {
      name: job.name,
      runnerName: job.runner_name,
      conclusion: job.conclusion,
      queueS,
      execS,
      totalS: queueS + execS,
      steps,
    };
  });
  return { id, created, runStartedAt: run.run_started_at, conclusion: run.conclusion, jobs };
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Linear-interpolation quantile (same method as numpy default).
function quantile(xs, q) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function statline(xs) {
  const r = (n) => (n === null ? null : Math.round(n * 100) / 100);
  return {
    n: xs.length,
    median: r(median(xs)),
    min: r(Math.min(...xs)),
    max: r(Math.max(...xs)),
    p25: r(quantile(xs, 0.25)),
    p75: r(quantile(xs, 0.75)),
    iqr: r(quantile(xs, 0.75) - quantile(xs, 0.25)),
  };
}

function summarize(runs) {
  // Aggregate per job name across runs.
  const byJob = {};
  for (const run of runs) {
    for (const job of run.jobs) {
      const key = job.name;
      byJob[key] = byJob[key] || { queueS: [], execS: [], totalS: [], steps: {}, runners: new Set() };
      byJob[key].queueS.push(job.queueS);
      byJob[key].execS.push(job.execS);
      byJob[key].totalS.push(job.totalS);
      if (job.runnerName) byJob[key].runners.add(job.runnerName);
      for (const step of job.steps) {
        byJob[key].steps[step.name] = byJob[key].steps[step.name] || [];
        byJob[key].steps[step.name].push(step.durationS);
      }
    }
  }
  const summary = {};
  for (const [name, agg] of Object.entries(byJob)) {
    summary[name] = {
      runners: Array.from(agg.runners),
      queue: statline(agg.queueS),
      exec: statline(agg.execS),
      total: statline(agg.totalS),
      steps: Object.fromEntries(Object.entries(agg.steps).map(([k, v]) => [k, statline(v)])),
    };
  }
  return summary;
}

function writeCsv(label, runs) {
  const rows = [['run_id', 'job', 'runner', 'queue_s', 'exec_s', 'total_s', 'step', 'step_s', 'step_conclusion']];
  for (const run of runs) {
    for (const job of run.jobs) {
      for (const step of job.steps) {
        rows.push([
          run.id, job.name, job.runnerName || '', job.queueS.toFixed(2), job.execS.toFixed(2),
          job.totalS.toFixed(2), step.name, step.durationS.toFixed(2), step.conclusion,
        ]);
      }
    }
  }
  const csv = rows.map((r) => r.join(',')).join('\n') + '\n';
  const p = path.join('results', `${label}.csv`);
  fs.writeFileSync(p, csv);
  return p;
}

function printTable(label, summary) {
  process.stdout.write(`\n=== ${label} ===\n`);
  for (const [job, s] of Object.entries(summary)) {
    process.stdout.write(`\n[job] ${job}  runner(s)=${s.runners.join(', ') || 'n/a'}\n`);
    const line = (name, st) => process.stdout.write(
      `  ${name.padEnd(22)} median=${String(st.median).padStart(8)}s  ` +
      `min=${String(st.min).padStart(8)}  max=${String(st.max).padStart(8)}  IQR=${st.iqr}  (n=${st.n})\n`,
    );
    line('queue', s.queue);
    line('execution', s.exec);
    line('total', s.total);
    for (const [step, st] of Object.entries(s.steps)) {
      line(`  step: ${step}`.slice(0, 22), st);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || 'run';
  fs.mkdirSync('results', { recursive: true });
  const repo = repoSlug();

  let ids;
  if (args['collect-only']) {
    ids = String(args.ids).split(',').map((x) => Number(x.trim()));
  } else {
    const workflow = args.workflow;
    const cacheMode = args['cache-mode'] || 'warm';
    const runs = Number(args.runs || 5);
    const warmup = Number(args.warmup || 0);
    if (!workflow) throw new Error('--workflow is required');

    const known = new Set(runIdsFor(repo, workflow));
    process.stdout.write(`repo=${repo} workflow=${workflow} cache=${cacheMode} runs=${runs} warmup=${warmup}\n`);

    // Warm-up runs populate the cache; dispatched + awaited first, then discarded.
    for (let i = 0; i < warmup; i += 1) {
      process.stdout.write(`dispatching warm-up ${i + 1}/${warmup}...\n`);
      const wid = await dispatchAndDetect(repo, workflow, cacheMode, known);
      await waitForCompletion(repo, [wid]);
    }

    // Measured runs: dispatch all, then wait together (parallel execution).
    ids = [];
    for (let i = 0; i < runs; i += 1) {
      process.stdout.write(`dispatching measured ${i + 1}/${runs}...\n`);
      ids.push(await dispatchAndDetect(repo, workflow, cacheMode, known));
    }
    process.stdout.write(`waiting for ${ids.length} measured run(s): ${ids.join(', ')}\n`);
    await waitForCompletion(repo, ids);
  }

  const collected = ids.map((id) => collectRun(repo, id));
  const summary = summarize(collected);
  const payload = { label, repo, ids, collectedAt: new Date().toISOString(), runs: collected, summary };
  fs.writeFileSync(path.join('results', `${label}.json`), JSON.stringify(payload, null, 2));
  const csvPath = writeCsv(label, collected);
  printTable(label, summary);
  process.stdout.write(`\nwrote results/${label}.json and ${csvPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
});
