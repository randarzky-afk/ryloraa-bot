// Ambil warna dominan dari gambar cover (untuk warna embed/panel).
// Butuh paket: npm i sharp
let sharp = null;
try {
  sharp = require("sharp");
} catch {
  console.log("⚠️ Paket 'sharp' belum terpasang (npm i sharp). Warna embed pakai warna default.");
}

const colorCache = new Map(); // url -> angka warna atau null
const inflight = new Map();

function remember(url, val) {
  colorCache.set(url, val);
  if (colorCache.size > 500) colorCache.delete(colorCache.keys().next().value);
}

async function compute(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());

  const { data } = await sharp(buf)
    .resize(32, 32, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Kelompokkan piksel per warna; piksel yang cerah/berwarna diberi bobot lebih besar,
  // piksel hampir hitam / hampir putih / abu-abu diabaikan atau dibobot kecil.
  const buckets = new Map();
  for (let i = 0; i + 2 < data.length; i += 3) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 510;
    if (l < 0.12 || l > 0.92) continue;
    const d = (max - min) / 255;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    const w = 0.15 + sat * sat * 3;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) || { w: 0, r: 0, g: 0, b: 0 };
    e.w += w;
    e.r += r * w;
    e.g += g * w;
    e.b += b * w;
    buckets.set(key, e);
  }

  let best = null;
  for (const e of buckets.values()) if (!best || e.w > best.w) best = e;
  if (!best) return null;

  const r = Math.round(best.r / best.w);
  const g = Math.round(best.g / best.w);
  const b = Math.round(best.b / best.w);
  return (r << 16) | (g << 8) | b;
}

// Return angka warna (mis. 0x1db954) atau null kalau gagal
async function getDominantColor(url) {
  if (!sharp || typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  if (colorCache.has(url)) return colorCache.get(url);
  if (inflight.has(url)) return inflight.get(url);

  const job = compute(url)
    .then((c) => {
      remember(url, c);
      return c;
    })
    .catch(() => null)
    .finally(() => inflight.delete(url));

  inflight.set(url, job);
  return job;
}

module.exports = { getDominantColor };
