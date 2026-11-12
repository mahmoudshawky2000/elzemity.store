'use strict';
// Safe, limited diagnostic for a STAGING deployment only. Usage:
// node scripts/catalog-load-check.js https://staging.example.com
const base = process.argv[2];
if (!base || !/^https:\/\//i.test(base)) {
  console.error('Provide an HTTPS staging base URL; e.g. node scripts/catalog-load-check.js https://staging.example.com');
  process.exit(1);
}
const url = new URL('/api/products?sort=featured&limit=24&page=1', base);
const count = 12, concurrency = 2;
let next = 0; const durations = []; let failures = 0; let totalBytes = 0;
async function worker() {
  while (next < count) {
    next++;
    const start = performance.now();
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(10000), headers:{Accept:'application/json'}});
      const buffer = await response.arrayBuffer();
      if (!response.ok) failures++;
      durations.push(performance.now()-start);
      totalBytes += buffer.byteLength;
    } catch { failures++; durations.push(performance.now()-start); }
  }
}
Promise.all(Array.from({length:concurrency},worker)).then(() => {
  durations.sort((a,b)=>a-b);
  const p = n => durations[Math.min(durations.length-1,Math.ceil(n*durations.length)-1)]?.toFixed(0);
  console.log(JSON.stringify({requests:count,concurrency,failures,p50_ms:p(.5),p95_ms:p(.95),avg_response_bytes:Math.round(totalBytes/count)},null,2));
  if (failures) process.exitCode=1;
});
