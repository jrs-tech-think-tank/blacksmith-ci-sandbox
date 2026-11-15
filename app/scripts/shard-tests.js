const fs = require('fs');
const path = require('path');

function parseShard(argv) {
  const flag = argv.find((arg) => arg.startsWith('--shard='));
  const value = flag ? flag.replace('--shard=', '') : process.env.TEST_SHARD;

  if (!value) {
    return { index: 1, total: 1 };
  }

  const [indexRaw, totalRaw] = value.split('/');
  const index = Number(indexRaw);
  const total = Number(totalRaw);

  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    console.error('invalid shard: expected --shard=N/T');
    process.exit(1);
  }

  return { index, total };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pick which tests run on this shard.
//   roundrobin (default, legacy): idx % total — ignores duration, so the 3 long tests
//     (adjacent multiples of 8 in the manifest) pile onto one shard -> lumpy, slow long-pole.
//   balanced (LPT): sort by duration desc, greedily assign each test to the least-loaded
//     shard -> long tests spread out, matrix long-pole drops to ~the single longest test.
function selectShardTests(manifest, index, total, strategy) {
  if (strategy !== 'balanced') {
    return manifest.filter((_, idx) => idx % total === index - 1);
  }
  const loads = Array(total).fill(0);
  const buckets = Array.from({ length: total }, () => []);
  for (const test of [...manifest].sort((a, b) => b.durationMs - a.durationMs)) {
    let min = 0;
    for (let s = 1; s < total; s += 1) {
      if (loads[s] < loads[min]) min = s;
    }
    buckets[min].push(test);
    loads[min] += test.durationMs;
  }
  return buckets[index - 1];
}

async function main() {
  const { index, total } = parseShard(process.argv.slice(2));
  const manifestPath = path.join(__dirname, '..', 'fixtures', 'test-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const scale = Number(process.env.TEST_DURATION_SCALE || 0.15);
  const strategy = process.env.SHARD_STRATEGY === 'balanced' ? 'balanced' : 'roundrobin';

  const tests = selectShardTests(manifest, index, total, strategy);
  const expectedDuration = tests.reduce((sum, test) => sum + test.durationMs, 0);

  console.log(`running unit test shard ${index}/${total} (strategy=${strategy})`);
  console.log(`selected ${tests.length} tests with ${expectedDuration}ms historical duration`);

  for (const test of tests) {
    const started = Date.now();
    await sleep(Math.max(20, Math.round(test.durationMs * scale)));
    const elapsed = Date.now() - started;
    console.log(`PASS ${test.name} (${elapsed}ms, historical=${test.durationMs}ms)`);
  }

  console.log(`unit test shard ${index}/${total} completed`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
