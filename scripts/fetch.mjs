// Downloads the current XLSX report from ev.vialietuva.lt.
// Usage: node scripts/fetch.mjs [output-path]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = 'https://ev.vialietuva.lt';
const FALLBACK = process.env.REPORT_URL || `${BASE}/report/887`;
const out = process.argv[2] || 'build/report.xlsx';
const UA = 'Mozilla/5.0 (compatible; ev-pricer/1.0; +https://github.com/)';

async function discoverReportUrl() {
  try {
    const res = await fetch(`${BASE}/`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`homepage HTTP ${res.status}`);
    const html = await res.text();
    const ids = [...html.matchAll(/\/report\/(\d+)/g)].map(m => +m[1]);
    if (ids.length) return `${BASE}/report/${Math.max(...ids)}`;
  } catch (e) {
    console.warn(`Report discovery failed (${e.message}); using ${FALLBACK}`);
  }
  return FALLBACK;
}

const url = await discoverReportUrl();
console.log(`Downloading ${url}`);
const res = await fetch(url, { headers: { 'user-agent': UA, referer: `${BASE}/` }, signal: AbortSignal.timeout(120_000) });
if (!res.ok) throw new Error(`report HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length < 10_000 || buf.readUInt32LE(0) !== 0x04034b50) {
  throw new Error(`Response does not look like an XLSX file (${buf.length} bytes, starts with ${buf.subarray(0, 4).toString('hex')})`);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
writeFileSync(out + '.url', url);
console.log(`Saved ${buf.length} bytes to ${out}`);
