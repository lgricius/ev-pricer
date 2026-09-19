// Converts the ev.vialietuva.lt XLSX report into a compact JSON file for the SPA.
// Usage: node scripts/convert.mjs <report.xlsx> [site/data.json]
// No npm dependencies: minimal ZIP + SpreadsheetML reader.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// --- minimal ZIP reader -----------------------------------------------------
function readZip(buf) {
  const files = new Map();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip file');
  const cdEntries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < cdEntries; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(start, start + csize);
    if (method === 8) files.set(name, inflateRawSync(raw));
    else if (method === 0) files.set(name, raw);
    else throw new Error(`Unsupported zip method ${method} for ${name}`);
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// --- minimal SpreadsheetML reader --------------------------------------------
const decode = s => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

const textOf = xml => decode([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''));

function sharedStrings(xml) {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => textOf(m[1]));
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml, sst) {
  const rows = [];
  for (const r of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, ref, attrs, inner = ''] = c;
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      if (t === 's') v = sst[+v];
      else if (t === 'inlineStr') v = textOf(inner);
      else if (v !== undefined) v = decode(v);
      row[colIndex(ref)] = v ?? '';
    }
    rows.push(row);
  }
  return rows;
}

// --- domain mapping ------------------------------------------------------------
// Column positions in the report (0-based). Header row is validated below.
const COL = {
  station: 1, evse: 2, hours: 3, vehicle: 4, owner: 5, operator: 6, installed: 7, location: 9, features: 10, lat: 11, lon: 12,
  connectors: 13, connType: 14, connPower: 15, current: 16, cable: 17, maxPower: 18, payment: 19, price: 20, accessible: 27,
};
const HEADER_CHECK = { 1: /identifikacinis kodas/i, 6: /operatorius/i, 9: /vieta/i, 18: /maksimali.*galia/i, 20: /kaina/i };

const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();

const NETWORK_ALIASES = new Map([
  ['inbalancegrid', 'Inbalance grid'],
  ['stuartenergy', 'Stuart Energy'],
  ['eleport', 'Eleport'],
]);
function normalizeNetwork(raw) {
  const s = clean(raw).replace(/,?\s*\b(UAB|AB|MB|VšĮ)\b\.?/gi, '').trim();
  const key = s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return NETWORK_ALIASES.get(key) || s || 'Nenurodyta';
}

function parseCity(features) {
  const m = /Miesto mazgas\s*-\s*(.*)$/m.exec(String(features ?? ''));
  const c = clean(m?.[1] ?? '').replace(/[.,;]+$/, '');
  return c && !/^(nenurodyta|undefined|null|-)$/i.test(c) ? c : '';
}

// Returns { raw, kwh: [numbers], free: bool }
function parsePrice(raw) {
  const s = clean(raw).replace(/,(\d)/g, '.$1');
  if (!s) return { raw: '', kwh: [], free: false };
  if (/nemokam/i.test(s)) return { raw: s, kwh: [0], free: true };
  const kwh = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(?:€|eur)?\s*\/\s*kwh/gi)].map(m => parseFloat(m[1]));
  return { raw: s, kwh, free: false };
}

const CURRENT = { kintama: 'AC', nuolatinė: 'DC', nuolatine: 'DC' };
function parseCurrent(raw) {
  const out = new Set();
  for (const w of clean(raw).toLowerCase().split(/[\s,;/]+/)) if (CURRENT[w]) out.add(CURRENT[w]);
  return out;
}

function parseTypes(raw) {
  const out = new Set();
  const s = clean(raw);
  for (const m of s.matchAll(/CCS(?:\s*\(Combo\s*2\))?|CHAdeMO|Type\s*2|Type\s*1|Schuko|Tesla/gi)) {
    out.add(m[0].replace(/\s+/g, ' ').replace(/^ccs.*/i, 'CCS').replace(/^type\s*2$/i, 'Type 2').replace(/^type\s*1$/i, 'Type 1').replace(/^chademo$/i, 'CHAdeMO'));
  }
  if (!out.size && s) out.add(s);
  return out;
}

export function convert(buf, sourceUrl) {
  const files = readZip(buf);
  const sst = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
  const sheetName = [...files.keys()].find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetName) throw new Error('No worksheet found');
  const rows = sheetRows(files.get(sheetName).toString('utf8'), sst);
  const header = rows.shift() ?? [];
  for (const [i, re] of Object.entries(HEADER_CHECK)) {
    if (!re.test(header[i] ?? '')) throw new Error(`Unexpected header in column ${i}: "${header[i]}" (report layout changed?)`);
  }

  const stations = new Map();
  for (const r of rows) {
    const id = clean(r[COL.station]);
    if (!id) continue;
    let st = stations.get(id);
    if (!st) {
      st = {
        id,
        network: normalizeNetwork(r[COL.operator]),
        owner: clean(r[COL.owner]),
        address: clean(r[COL.location]),
        city: parseCity(r[COL.features]),
        lat: num(r[COL.lat]), lon: num(r[COL.lon]),
        hours: clean(r[COL.hours]),
        installed: clean(r[COL.installed]).slice(0, 10),
        heavy: /sunkiaj/i.test(String(r[COL.vehicle])),
        accessible: false,
        stalls: 0, connectors: 0, maxPower: 0,
        types: new Set(), current: new Set(), payment: new Set(), prices: new Set(), kwh: [], free: false,
        points: [],
      };
      stations.set(id, st);
    }
    const price = parsePrice(r[COL.price]);
    const power = num(r[COL.maxPower]) ?? num(r[COL.connPower]) ?? 0;
    st.stalls += 1;
    st.connectors += num(r[COL.connectors]) ?? 1;
    st.maxPower = Math.max(st.maxPower, power);
    for (const t of parseTypes(r[COL.connType])) st.types.add(t);
    for (const c of parseCurrent(r[COL.current])) st.current.add(c);
    for (const p of clean(r[COL.payment]).split(/\s*,\s*/)) if (p) st.payment.add(p);
    if (price.raw) st.prices.add(price.raw);
    st.kwh.push(...price.kwh);
    st.free ||= price.free;
    st.accessible ||= /^taip/i.test(clean(r[COL.accessible]));
    if (st.installed === '' || (clean(r[COL.installed]) && clean(r[COL.installed]).slice(0, 10) < st.installed)) st.installed = clean(r[COL.installed]).slice(0, 10);
    st.points.push({
      id: clean(r[COL.evse]),
      types: [...parseTypes(r[COL.connType])],
      current: [...parseCurrent(r[COL.current])],
      power: power,
      cable: /^taip/i.test(clean(r[COL.cable])),
      price: price.raw,
    });
  }

  const out = [...stations.values()].map(s => ({
    id: s.id,
    network: s.network,
    owner: s.owner !== s.network ? s.owner : '',
    address: s.address,
    city: s.city,
    lat: s.lat, lon: s.lon,
    hours: s.hours === '24/7' ? '24/7' : (s.hours && !/nenurodyta/i.test(s.hours) ? s.hours : ''),
    stalls: s.stalls,
    connectors: s.connectors,
    maxPower: s.maxPower,
    types: [...s.types].sort(),
    current: [...s.current].sort(),
    payment: [...s.payment].sort(),
    prices: [...s.prices],
    priceMin: s.kwh.length ? Math.min(...s.kwh) : null,
    priceMax: s.kwh.length ? Math.max(...s.kwh) : null,
    free: s.free,
    installed: s.installed,
    heavy: s.heavy,
    accessible: s.accessible,
    points: s.points,
  }));

  return { generatedAt: new Date().toISOString(), source: sourceUrl, rows: rows.length, stations: out };
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const [,, inputPath, outputPath = 'site/data.json'] = process.argv;
  if (!inputPath) { console.error('Usage: node scripts/convert.mjs <report.xlsx> [site/data.json]'); process.exit(2); }
  const source = existsSync(inputPath + '.url') ? readFileSync(inputPath + '.url', 'utf8').trim() : (process.env.REPORT_URL || 'https://ev.vialietuva.lt/report/887');
  const data = convert(readFileSync(inputPath), source);
  if (data.stations.length < 100) throw new Error(`Only ${data.stations.length} stations parsed; refusing to publish`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(data));
  console.log(`rows=${data.rows} stations=${data.stations.length} -> ${outputPath}`);
}
