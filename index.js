require("dotenv").config({ path: require("path").join(__dirname, ".env") });
process.env.FFMPEG_PATH = require("ffmpeg-static");

const {
  getSettings,
  updateSettings,
  DELAY_STEPS,
} = require("./guild-settings.js");
const { getDominantColor } = require("./cover-color.js");

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  PermissionFlagsBits,
  SeparatorBuilder,
  SeparatorSpacingSize,
  Options,
  ActivityType,
} = require("discord.js");
const {
  Player,
  useQueue,
  QueueRepeatMode,
  QueryType,
  BaseExtractor,
  Track,
} = require("discord-player");
const { DefaultExtractors } = require("@discord-player/extractor");
const path = require("path");
// ---------- Anti-ban: pembatas request ke API eksternal ----------
const _rawFetch = globalThis.fetch.bind(globalThis);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_QUEUE = 300;
const cmdCooldown = new Map();
const acLast = new Map();
let acBusy = 0;

// gap = jeda minimum antar request ke host itu (ms)
const POLITE = {
  "api.deezer.com": { gap: 150 },
  "itunes.apple.com": { gap: 1500 }, // iTunes ~20 req/menit
  "api.spotify.com": { gap: 250 },
  "accounts.spotify.com": { gap: 1000 },
  "open.spotify.com": { gap: 600 },
  "api.genius.com": { gap: 500 },
  "genius.com": { gap: 500 },
};
const hostState = new Map();

globalThis.fetch = async function politeFetch(input, init = {}) {
  const href =
    typeof input === "string"
      ? input
      : input && input.url
        ? input.url
        : String(input);
  let host = "";
  try {
    host = new URL(href).hostname;
  } catch {}
  const cfg = POLITE[host];
  if (!cfg) return _rawFetch(input, init); // host lain tidak disentuh

  const st = hostState.get(host) || { next: 0, blockedUntil: 0, fails: 0 };
  hostState.set(host, st);
  const blocked = () =>
    new Response(null, { status: 429, statusText: "local-backoff" });

  if (Date.now() < st.blockedUntil) return blocked();

  const now = Date.now();
  const slot = Math.max(now, st.next);
  if (slot - now > 5000) return blocked(); // antrean terlalu panjang
  st.next = slot + cfg.gap;
  if (slot > now) await sleep(slot - now);
  if (init.signal && init.signal.aborted)
    throw init.signal.reason || new Error("aborted");

  const res = await _rawFetch(input, init);
  if (res.status === 429 || res.status === 403) {
    st.fails++;
    const ra = Number(res.headers.get("retry-after"));
    const wait = Math.min(
      ra > 0 ? ra * 1000 : 30000 * 2 ** (st.fails - 1),
      15 * 60 * 1000,
    );
    st.blockedUntil = Date.now() + wait;
    console.log(
      `⛔ [${host}] HTTP ${res.status} — istirahat ${Math.round(wait / 1000)} dtk`,
    );
  } else if (res.ok) {
    st.fails = 0;
  }
  return res;
};

const AUDIO_EXT = [".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus"];
// ---------- Validasi query pencarian (anti "play random") ----------
// Tujuan: tolak query sampah yang memicu panggilan YouTube / iTunes /
// Deezer / Spotify / Genius tanpa hasil berguna. Mencegah abuse API
// sekaligus menjaga CPU & IP PC-mu dari rate-limit.
const SPAM_QUERIES = new Set([
  "random",
  "rand",
  "rnd",
  "test",
  "testing",
  "test123",
  "tes",
  "asdf",
  "asdfasdf",
  "asdfgh",
  "asdfghjkl",
  "qwerty",
  "qwertyuiop",
  "qwe",
  "qwer",
  "abc",
  "abcd",
  "abcde",
  "abcdef",
  "xxx",
  "xxxx",
  "yyy",
  "zzz",
  "aaa",
  "aaaa",
  "123",
  "1234",
  "12345",
  "123456",
  "1234567",
  "12345678",
  "lagu",
  "song",
  "music",
  "musik",
  "play",
  "main",
  "wkwk",
  "wkwkwk",
  "haha",
  "hehe",
  "huhu",
]);

function validateSearchQuery(input) {
  const raw = String(input || "").trim();
  if (!raw) return "Query kosong — tulis judul lagu atau nama artis.";
  if (raw.length < 3) return "Query terlalu pendek (minimal 3 karakter).";
  if (raw.length > 200) return "Query terlalu panjang (maksimal 200 karakter).";

  // URL (YouTube/Spotify/Deezer/Apple Music) dipercayakan ke jalur URL-nya
  if (/^https?:\/\//i.test(raw)) {
    const ALLOWED_HOSTS = [
      "youtube.com",
      "youtu.be",
      "spotify.com",
      "soundcloud.com",
      "snd.sc",
      "deezer.com",
      "deezer.page.link",
      "dzr.page.link",
      "music.apple.com",
    ];
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      return "Link tidak valid.";
    }
    const ok = ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
    return ok
      ? null
      : "Link dari situs itu tidak didukung. Pakai link YouTube, Spotify, SoundCloud, Deezer, atau Apple Music.";
  }

  const lower = raw.toLowerCase().replace(/\s+/g, " ");
  if (SPAM_QUERIES.has(lower)) {
    return "Query tidak spesifik — tulis judul lagu atau nama artis yang jelas.";
  }

  // Harus ada minimal 1 huruf dari skrip apa pun (Latin, CJK, Cyrillic, dll)
  if (!/\p{L}/u.test(raw)) {
    return "Query harus mengandung huruf.";
  }

  // Gibberish detection hanya untuk query huruf Latin supaya judul
  // berbahasa Jepang/Korea/Rusia tidak salah ditolak.
  // "24K Magic", "7 Rings", "99 Luftballons" lolos karena ada 2+ digit.
  const isLatin = /^[a-z0-9\s\p{P}\p{S}]+$/iu.test(raw);
  if (isLatin && !/[aeiou]/i.test(raw) && !/\d{2,}/.test(raw)) {
    return "Query tidak dikenali — tulis judul lagu atau nama artis.";
  }

  return null;
}

// Versi ringan untuk autocomplete: tanpa syarat panjang minimum,
// supaya user bisa lihat saran sejak huruf ke-2 selama bukan sampah.
function isSpamForAutocomplete(typed) {
  const t = String(typed || "").trim();
  if (t.length < 2) return true;
  if (/^https?:\/\//i.test(t)) return false;
  if (SPAM_QUERIES.has(t.toLowerCase().replace(/\s+/g, " "))) return true;
  if (!/\p{L}/u.test(t)) return true;
  const isLatin = /^[a-z0-9\s\p{P}\p{S}]+$/iu.test(t);
  if (isLatin && !/[aeiou]/i.test(t) && !/\d{2,}/.test(t)) return true;
  return false;
}

const playNodeOptions = (interaction) => {
  const stay = getSettings(interaction.guild.id).stay247;
  return {
    metadata: {
      channel:
        process.env.PANEL_CHANNEL === "voice" &&
        interaction.member.voice.channel
          ? interaction.member.voice.channel
          : interaction.channel,
    },
    leaveOnEmpty: !stay,
    leaveOnEnd: !stay,
    leaveOnStop: !stay,
    leaveOnEmptyCooldown: 300000,
    leaveOnEndCooldown: 300000,
    selfDeaf: true,
    bitrate: 320,
    volume: 100,
    disableEqualizer: true,
    disableBiquad: true,
    disableResampler: true,
    disableFilterer: true,
  };
};

// ---------- Extractor kustom: putar file upload Discord langsung ----------
class DirectFileExtractor extends BaseExtractor {
  static identifier = "com.local.directfile";

  async validate(query) {
    try {
      const host = new URL(query).hostname;
      // Cek host exact + subdomain sah, bukan sekadar endsWith yang bisa
      // diloloskan domain jahat seperti "evil-discordapp.com".
      return (
        host === "discordapp.com" ||
        host.endsWith(".discordapp.com") ||
        host === "discordapp.net" ||
        host.endsWith(".discordapp.net")
      );
    } catch {
      return false;
    }
  }

  async handle(query, context) {
    const url = new URL(query);
    const fileName = decodeURIComponent(path.basename(url.pathname));
    const track = new Track(this.context.player, {
      title: fileName,
      author: "Upload",
      description: "File upload",
      url: query,
      thumbnail: "",
      duration: "0:00",
      views: 0,
      source: "arbitrary",
      requestedBy: context.requestedBy,
      queryType: QueryType.ARBITRARY,
    });
    track.extractor = this;
    return this.createResponse(null, [track]);
  }

  async stream(info) {
    return info.url;
  }
}

// ---------- Utilitas kecil ----------
const clip = (str, n) => (str.length > n ? str.slice(0, n - 1) + "…" : str);

// Salin Track supaya tiap request punya objek sendiri
// (cache discord-player membagikan instance yang sama antar server).
function cloneTrack(t, requestedBy) {
  const c = Object.assign(Object.create(Object.getPrototypeOf(t)), t);
  c.id = require("crypto").randomUUID(); // id baru, biar tidak bentrok di queue
  c.requestedBy = requestedBy;
  c.fromAutoplay = false;
  c.ytSource = false;
  return c;
}

// Salin SearchResult beserta track-nya
function isolateResult(sr, requestedBy) {
  if (!sr) return sr;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(sr)), sr);
  copy.tracks = (sr.tracks || []).map((t) => cloneTrack(t, requestedBy));
  return copy;
}

function parseTime(str) {
  const parts = str.trim().split(":").map(Number);
  if (parts.length > 3 || parts.some((n) => Number.isNaN(n) || n < 0))
    return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

function cleanQuery(q) {
  try {
    const u = new URL(q);
    const isYouTube = /(^|\.)youtube\.com$/.test(u.hostname);
    const list = u.searchParams.get("list") || "";
    const video = u.searchParams.get("v");
    if (isYouTube && video && list.startsWith("RD")) {
      return `https://www.youtube.com/watch?v=${video}`;
    }
  } catch {}
  return q;
}

function cacheSet(map, key, val, max = 300) {
  map.set(key, val);
  if (map.size > max) map.delete(map.keys().next().value);
}

// ---------- Link SoundCloud / Deezer / Apple Music ----------
const isSoundCloudUrl = (u) =>
  /^https?:\/\/(?:(?:www\.|m\.|on\.)?soundcloud\.com|snd\.sc)\//i.test(
    String(u || ""),
  );

const isSoundCloudTrack = (t) =>
  /soundcloud/i.test((t && t.source) || "") || isSoundCloudUrl(t && t.url);

async function normalizeSoundCloudUrl(url) {
  try {
    let u = url;
    if (/^https?:\/\/(on\.soundcloud\.com|snd\.sc)\//i.test(u)) {
      const r = await fetch(u, {
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (r) {
        if (r.url) u = r.url;
        r.body?.cancel().catch(() => {});
      }
    }
    const p = new URL(u);
    if (!/(^|\.)soundcloud\.com$/i.test(p.hostname)) return url;
    p.hostname = "soundcloud.com";
    const secret = p.searchParams.get("secret_token");
    p.search = secret ? `?secret_token=${secret}` : "";
    p.hash = "";
    return p.toString();
  } catch {
    return url;
  }
}

function scBigCover(url) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  return url.replace(
    /-(?:large|crop|badge|small|tiny|mini|t\d+x\d+)\.(jpe?g|png|gif)/i,
    "-t500x500.$1",
  );
}

async function resolveDeezerTrack(url) {
  let u = url;
  if (
    /^https?:\/\/(link\.deezer\.com|deezer\.page\.link|dzr\.page\.link)\//i.test(
      u,
    )
  ) {
    const r = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    if (r && r.url) u = r.url;
  }
  const id = (u.match(
    /deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/(\d+)/i,
  ) || [])[1];
  if (!id) return null;

  const d = await fetchJson(`https://api.deezer.com/track/${id}`);
  if (!d || d.error || !d.title) return null;

  const names = (d.contributors || []).map((c) => c && c.name).filter(Boolean);
  const artist =
    (names.length ? names.join(", ") : d.artist && d.artist.name) || "";
  return {
    id: null,
    sourceName: "Deezer",
    title: d.title,
    artist,
    primaryArtist: (d.artist && d.artist.name) || artist.split(",")[0].trim(),
    album: (d.album && d.album.title) || null,
    year: d.release_date ? String(d.release_date).slice(0, 4) : null,
    cover: d.album ? d.album.cover_xl || d.album.cover_big || null : null,
    popularity: null,
    url: d.link || null,
    durationMs: d.duration ? d.duration * 1000 : null,
  };
}

async function resolveAppleMusicTrack(url) {
  const country =
    (url.match(/music\.apple\.com\/([a-z]{2})\//i) || [])[1] || "us";
  const id =
    (url.match(/[?&]i=(\d+)/) || [])[1] ||
    (url.match(/\/song\/[^/?#]+\/(\d+)/) || [])[1];
  if (!id) return null;

  const data = await fetchJson(
    `https://itunes.apple.com/lookup?id=${id}&country=${country}`,
  );
  const r = data && data.results && data.results[0];
  if (!r || !r.trackName) return null;

  return {
    id: null,
    sourceName: "Apple Music",
    title: r.trackName,
    artist: r.artistName || "",
    primaryArtist: String(r.artistName || "")
      .split(/\s*(?:,|&)\s*/)[0]
      .trim(),
    album: r.collectionName || null,
    year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : null,
    cover: r.artworkUrl100
      ? r.artworkUrl100.replace("100x100bb", "600x600bb")
      : null,
    popularity: null,
    url: r.trackViewUrl || null,
    durationMs: r.trackTimeMillis || null,
  };
}

async function resolveOtherLinkInfo(input) {
  try {
    if (/deezer\.com|deezer\.page\.link|dzr\.page\.link/i.test(input))
      return await resolveDeezerTrack(input);
    if (/music\.apple\.com/i.test(input))
      return await resolveAppleMusicTrack(input);
  } catch (err) {
    console.log("[Link] Gagal baca info lagu:", err.message);
  }
  return null;
}

// ---------- Pencocok lagu ----------
const decodeEntities = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&amp;/g, "&");

function getMeta(html, prop) {
  const a = html.match(
    new RegExp(
      `<meta[^>]*?(?:property|name)=["']${prop}["'][^>]*?content=["']([^"']*)["']`,
      "i",
    ),
  );
  const b = html.match(
    new RegExp(
      `<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']${prop}["']`,
      "i",
    ),
  );
  const v = (a || b || [])[1];
  return v ? decodeEntities(v) : null;
}

// memoize fungsi string murni (hasil sama persis, tapi tidak dihitung ulang)
const memoStr = (fn, max = 3000) => {
  const m = new Map();
  return (s) => {
    const k = String(s || "");
    let v = m.get(k);
    if (v === undefined) {
      v = fn(k);
      if (m.size >= max) m.clear();
      m.set(k, v);
    }
    return v;
  };
};

const norm = memoStr((s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim(),
);

const BAD_WORDS = [
  "live",
  "cover",
  "remix",
  "karaoke",
  "instrumental",
  "reaction",
  "sped up",
  "slowed",
  "nightcore",
  "8d",
  "bass boosted",
  "mashup",
  "tutorial",
  "acoustic",
  "reverb",
];

const BAD_RES = BAD_WORDS.map((w) => new RegExp(`\\b${w}\\b`));

const metaPrepCache = new WeakMap();
function prepMeta(meta) {
  let p = metaPrepCache.get(meta);
  if (!p) {
    const all = norm(meta.query);
    p = {
      title: norm(cleanTitleForCover(meta.title) || meta.title),
      artist: norm(meta.artist),
      words: all.split(" ").filter((w) => w.length > 1),
      wanted: BAD_RES.map((re) => re.test(all)),
    };
    metaPrepCache.set(meta, p);
  }
  return p;
}

function scoreTrack(t, meta) {
  const m = prepMeta(meta);
  const tt = norm(t.title);
  const ta = norm(t.author);
  let score = 0;

  if (t.isMusicSong) score += 50;
  if (/\btopic\b/.test(ta)) score += 50;
  if (/\bvevo\b/.test(ta)) score += 15;
  if (/\bofficial audio\b/.test(tt)) score += 10;

  if (m.artist && (ta.includes(m.artist) || tt.includes(m.artist))) score += 20;
  if (m.title && tt.includes(m.title)) score += 25;
  else if (m.title && m.title.length > 2) score -= 15; // judul lagu tidak muncul → kemungkinan lagu lain

  if (m.words.length) {
    const hay = `${tt} ${ta}`;
    let hits = 0;
    for (const w of m.words) if (hay.includes(w)) hits++;
    score += Math.round((hits / m.words.length) * 30);
  }

  for (let i = 0; i < BAD_RES.length; i++) {
    if (BAD_RES[i].test(tt) && !m.wanted[i]) score -= 40;
  }

  if (meta.durationMs && t.durationMS) {
    const diff = Math.abs(t.durationMS - meta.durationMs) / 1000;
    if (diff <= 3) score += 40;
    else if (diff <= 8) score += 25;
    else if (diff <= 15) score += 10;
    else if (diff > 30) score -= 30;
  }

  return score;
}

function musicResultToCandidates(res, limit = 10) {
  const shelf =
    res &&
    (res.songs ||
      (res.contents || []).find((c) => c && c.contents && c.contents.length));
  const items = shelf && shelf.contents ? Array.from(shelf.contents) : [];
  const out = [];
  for (const i of items) {
    if (!i || typeof i.id !== "string" || !i.title) continue;
    if (i.item_type && i.item_type !== "song") continue;
    const people =
      (i.artists && i.artists.length ? i.artists : i.authors) || [];
    const seconds = i.duration ? Number(i.duration.seconds) : 0;
    out.push({
      title: i.title,
      author:
        people
          .map((a) => a.name)
          .filter(Boolean)
          .join(", ") || "Unknown",
      duration: (i.duration && i.duration.text) || "0:00",
      durationMS: seconds > 0 ? seconds * 1000 : 0,
      url: `https://www.youtube.com/watch?v=${i.id}`,
      isMusicSong: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function pickBest(tracks, meta) {
  const scored = tracks.map((t, i) => ({ t, i, s: scoreTrack(t, meta) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  return scored;
}

// ---------- Helper Spotify (tanpa jaringan) ----------
const fmtMs = (ms) => {
  if (!ms) return "?:??";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

function ytIdOf(url) {
  try {
    const u = new URL(url);
    return (
      u.searchParams.get("v") ||
      (u.hostname === "youtu.be" ? u.pathname.slice(1) : null)
    );
  } catch {
    return null;
  }
}

function spotifyInfoFromApi(t) {
  const artists = (t.artists || []).map((a) => a.name).filter(Boolean);
  const album = t.album || {};
  return {
    id: t.id,
    title: t.name,
    artist: artists.join(", "),
    primaryArtist: artists[0] || "",
    album: album.name || null,
    year: album.release_date ? String(album.release_date).slice(0, 4) : null,
    cover: album.images && album.images[0] ? album.images[0].url : null,
    popularity: typeof t.popularity === "number" ? t.popularity : null,
    url:
      (t.external_urls && t.external_urls.spotify) ||
      `https://open.spotify.com/track/${t.id}`,
    durationMs: t.duration_ms || null,
  };
}

function rankSpotify(list, query) {
  const wantAll = norm(query);
  const words = wantAll.split(" ").filter((w) => w.length > 1);
  return list
    .map((info, idx) => {
      const titleN = norm(info.title);
      const hay = norm(`${info.title} ${info.artist}`);
      const hit = words.length
        ? words.filter((w) => hay.includes(w)).length / words.length
        : 0;

      // 1) Kecocokan dulu
      let score = hit * 60;
      if (titleN === wantAll)
        score += 25; // judul persis
      else if (titleN.length >= 3 && wantAll.includes(titleN)) score += 15; // "artis judul"
      if (hit < 0.5) score -= 30; // kurang nyambung → turun jauh

      // 2) Popularitas, dikali kecocokan: lagu populer yang tidak nyambung tidak naik
      score += (info.popularity || 0) * hit * 0.9;
      score -= idx * 2;

      for (const re of BAD_RES) {
        if (re.test(titleN) && !re.test(wantAll)) score -= 25;
      }
      return { i: info, score, hit };
    })
    .sort((a, b) => b.score - a.score);
}

async function getSpotifyTrackInfoFromPage(url) {
  const id = (url.match(/\/track\/([A-Za-z0-9]+)/) || [])[1];
  if (!id) return null;

  const res = await fetch(`https://open.spotify.com/track/${id}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const html = await res.text();

  let title = getMeta(html, "og:title");
  if (!title) return null;
  title = title
    .replace(/\s*[-–]\s*(song|single|album|EP)(\s+and lyrics)?\s+by\s+.*$/i, "")
    .replace(/\s*\|\s*Spotify\s*$/i, "")
    .trim();

  const desc = getMeta(html, "og:description") || "";
  const parts = desc
    .split("·")
    .map((p) => p.trim())
    .filter(Boolean);
  let artist = parts[0] || "";
  if (artist && norm(artist) === norm(title) && parts[1]) artist = parts[1];
  if (!artist) {
    const pageTitle = decodeEntities(
      (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "",
    );
    const m = pageTitle.match(/\sby\s(.+?)\s*\|\s*Spotify/i);
    artist = m ? m[1].trim() : "";
  }

  const seconds = Number(getMeta(html, "music:duration"));
  const isSongTag = parts[2] && /^song$/i.test(parts[2]);
  const album = isSongTag ? parts[1] : null;
  const year =
    isSongTag && parts[3] && /^\d{4}$/.test(parts[3]) ? parts[3] : null;

  return {
    id,
    title,
    artist,
    primaryArtist: artist.split(",")[0].trim(),
    album,
    year,
    cover: getMeta(html, "og:image"),
    popularity: null,
    url: `https://open.spotify.com/track/${id}`,
    durationMs: seconds > 0 ? seconds * 1000 : null,
  };
}

// ---------- Spotify via halaman embed ----------
const SP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchSpotifyEmbed(type, id) {
  const res = await fetch(`https://open.spotify.com/embed/${type}/${id}`, {
    headers: { "User-Agent": SP_UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!m) return null;
  try {
    const e = JSON.parse(m[1])?.props?.pageProps?.state?.data?.entity;
    return e || null;
  } catch {
    return null;
  }
}

const spCover = (e) => {
  const imgs =
    (e && e.visualIdentity && e.visualIdentity.image) ||
    (e && e.coverArt && e.coverArt.sources) ||
    [];
  const best = imgs[imgs.length - 1];
  return best && best.url ? best.url : null;
};

const spClean = (s) =>
  String(s || "")
    .replace(/\u00a0/g, " ")
    .trim();

async function getSpotifyTrackInfo(url) {
  let info = null;
  try {
    info = await getSpotifyTrackInfoFromPage(url);
  } catch (err) {
    console.log("[Spotify] Scrape halaman gagal:", err.message);
  }
  if (info && info.title && info.artist) return info;

  const id = (url.match(/\/track\/([A-Za-z0-9]+)/) || [])[1];
  if (!id) return info;
  try {
    const e = await fetchSpotifyEmbed("track", id);
    if (!e) return info;
    const artist = spClean(
      (e.artists || [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(", ") || e.subtitle,
    );
    const title = spClean(e.name || e.title);
    if (!title) return info;
    return {
      id,
      title,
      artist,
      primaryArtist: artist.split(",")[0].trim(),
      album: null,
      year: null,
      cover: spCover(e) || (info && info.cover) || null,
      popularity: null,
      url: `https://open.spotify.com/track/${id}`,
      durationMs: e.duration || (info && info.durationMs) || null,
    };
  } catch (err) {
    console.log("[Spotify] Fallback embed gagal:", err.message);
    return info;
  }
}

async function getSpotifyCollection(url) {
  const m = url.match(/\/(playlist|album)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  const e = await fetchSpotifyEmbed(m[1], m[2]);
  if (!e || !Array.isArray(e.trackList)) return null;

  const tracks = e.trackList
    .filter((t) => t && t.title)
    .map((t) => ({
      id: String(t.uri || "")
        .split(":")
        .pop(),
      title: spClean(t.title),
      artist: spClean(t.subtitle),
      durationMs: t.duration || null,
    }));

  return {
    name: spClean(e.name || e.title) || m[1],
    cover: spCover(e),
    tracks,
  };
}

async function matchSpotifyItem(item, cover, requestedBy) {
  const artist = item.artist.split(",")[0].trim();
  const best = await findBestTrack(
    {
      query: `${artist} ${item.title}`.trim(),
      title: item.title,
      artist,
      durationMs: item.durationMs,
    },
    requestedBy,
  );
  if (!best) return null;

  rememberSpotifyForVideo(best.url, {
    id: item.id,
    title: item.title,
    artist: item.artist,
    primaryArtist: artist,
    album: null,
    year: null,
    cover,
    popularity: null,
    url: item.id ? `https://open.spotify.com/track/${item.id}` : null,
    durationMs: item.durationMs,
  });
  return best;
}

// ---------- Cover art persegi ----------
const coverCache = new Map();

const normU = memoStr((s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim(),
);
const tok = (s) => normU(s).split(" ").filter(Boolean);

function cleanTitleForCover(t) {
  return String(t || "")
    .replace(/[\(\[][^\)\]]*[\)\]]/g, " ")
    .replace(
      /\s[-–]\s*(?:\d{4}\s+)?(?:remaster(?:ed)?|single version|radio edit|album version|mono|stereo)\b.*$/i,
      " ",
    )
    .replace(
      /\b(official|video|audio|lyrics?|lyric video|mv|hd|hq|4k)\b/gi,
      " ",
    )
    .replace(/\s+(?:feat|ft)\.?\s.*$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const versionTags = (s) => {
  const n = norm(s);
  return BAD_WORDS.filter((_, i) => BAD_RES[i].test(n));
};

function titleSim(want, got) {
  const a = new Set(tok(cleanTitleForCover(want) || want));
  const b = new Set(tok(cleanTitleForCover(got) || got));
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return (2 * inter) / (a.size + b.size);
}

const splitArtists = (s) =>
  String(s || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/vevo$/i, "")
    .split(/\s*(?:,|&|;|\+|\bfeat\.?|\bft\.?|\bfeaturing)\s*/i)
    .map(normU)
    .filter(Boolean);

function artistMatch(wantArtists, gotStr) {
  const gotTokens = new Set(tok(gotStr));
  const gotNames = splitArtists(gotStr);
  const wantTokens = new Set(wantArtists.flatMap((w) => w.split(" ")));
  return (
    wantArtists.some((w) => w.split(" ").every((t) => gotTokens.has(t))) ||
    gotNames.some((g) => g.split(" ").every((t) => wantTokens.has(t)))
  );
}

const COMP_ALBUM =
  /\b(greatest hits|best of|hits|collection|compilation|essential|anthology|karaoke|tribute|playlist|top \d+|now that|workout|party|covers?)\b/;

function bestCoverMatch(a, wantArtists, wantTags, durationMs, cands) {
  let best = null;
  cands.forEach((c, idx) => {
    if (!c || !c.cover || !c.title) return;
    const ts = titleSim(a.title, c.title);
    if (ts < 0.8) return;
    if (!c.artist || !artistMatch(wantArtists, c.artist)) return;
    const gotTags = versionTags(c.title);
    if (gotTags.some((t) => !wantTags.includes(t))) return;
    let score = ts + 0.5 - idx * 0.02;
    score -= wantTags.filter((t) => !gotTags.includes(t)).length * 0.2;
    if (durationMs && c.durationMs) {
      const diff = Math.abs(c.durationMs - durationMs) / 1000;
      if (diff > 25) return;
      score += diff <= 3 ? 0.3 : diff <= 8 ? 0.15 : 0;
    }
    if (COMP_ALBUM.test(normU(c.album))) score -= 0.4;
    if (c.album && normU(c.album) === normU(c.title)) score += 0.1;
    if (!best || score > best.score) best = { score, cover: c.cover };
  });
  return best ? best.cover : null;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

async function findCover(a, durationMs) {
  const wantArtists = splitArtists(a.artist);
  if (
    !wantArtists.length ||
    /^unknown( artist)?$/.test(wantArtists.join(" "))
  ) {
    return { cover: null, down: false };
  }

  const wantTags = versionTags(a.raw);
  const mainArtist = String(a.artist)
    .replace(/\s*-\s*topic$/i, "")
    .split(/\s*(?:,|&|;|\+|\bfeat\.?|\bft\.?)\s*/i)[0]
    .replace(/vevo$/i, "")
    .replace(/"/g, "")
    .trim();
  const t = a.title.replace(/"/g, "");
  let down = false;

  const itunesJob = () =>
    fetchJson(
      `https://itunes.apple.com/search?term=${encodeURIComponent(`${mainArtist} ${t}`)}&entity=song&limit=10`,
    );

  const [structured, loose] = await Promise.all([
    fetchJson(
      `https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${mainArtist}" track:"${t}"`)}&limit=10`,
    ),
    fetchJson(
      `https://api.deezer.com/search?q=${encodeURIComponent(`${mainArtist} ${t}`)}&limit=10`,
    ),
  ]);
  if (structured === undefined || loose === undefined) down = true;

  const seen = new Set();
  const dz = [];
  for (const d of [
    ...((structured && structured.data) || []),
    ...((loose && loose.data) || []),
  ]) {
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    dz.push({
      title: d.title,
      artist: d.artist && d.artist.name,
      album: d.album && d.album.title,
      durationMs: (d.duration || 0) * 1000,
      cover: d.album && (d.album.cover_xl || d.album.cover_big),
    });
  }
  let cover = bestCoverMatch(a, wantArtists, wantTags, durationMs, dz);
  if (cover) return { cover, down };

  const it = await itunesJob();
  if (it === undefined) down = true;
  const itc = ((it && it.results) || []).map((r) => ({
    title: r.trackName,
    artist: r.artistName,
    album: r.collectionName,
    durationMs: r.trackTimeMillis || 0,
    cover: r.artworkUrl100
      ? r.artworkUrl100.replace("100x100bb", "600x600bb")
      : null,
  }));
  cover = bestCoverMatch(a, wantArtists, wantTags, durationMs, itc);
  return { cover, down };
}

const coverInflight = new Map();

async function getCoverArt(rawTitle, rawArtist, durationMs = 0) {
  const key = normU(`${rawTitle}|${rawArtist}`);
  if (coverCache.has(key)) return coverCache.get(key);
  if (coverInflight.has(key)) return coverInflight.get(key);

  const job = (async () => {
    const attempts = [
      {
        title: cleanTitleForCover(rawTitle) || rawTitle,
        artist: rawArtist,
        raw: rawTitle,
      },
    ];
    const m = String(rawTitle).match(/^(.{2,60}?)\s[-–]\s(.{2,})$/);
    if (m)
      attempts.push({
        title: cleanTitleForCover(m[2]) || m[2],
        artist: m[1],
        raw: m[2],
      });

    const results = await Promise.all(
      attempts.map((a) => findCover(a, durationMs)),
    );
    const hit = results.find((r) => r.cover);
    const down = results.some((r) => r.down);
    const cover = hit ? hit.cover : null;

    if (cover || !down) cacheSet(coverCache, key, cover, 500);
    return cover;
  })().finally(() => coverInflight.delete(key));

  coverInflight.set(key, job);
  return job;
}

// ---------- Spotify Web API ----------
const spotifyEnabled = () =>
  process.env.SPOTIFY_API === "on" &&
  Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);

let spotifyToken = { value: null, expires: 0 };
let spotifyWarned = false;
const spotifyCache = new Map();
const spotifyByVideo = new Map();

function spotifyWarn(err) {
  if (spotifyWarned) return;
  spotifyWarned = true;
  console.log("⚠️ [Spotify API] Gagal, pakai cara cadangan:", err.message);
}

async function getSpotifyToken() {
  if (spotifyToken.value && Date.now() < spotifyToken.expires - 30000)
    return spotifyToken.value;
  const basic = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(
      `Token Spotify ditolak (HTTP ${res.status}), cek SPOTIFY_CLIENT_ID/SECRET di .env`,
    );
  }
  const data = await res.json();
  spotifyToken = {
    value: data.access_token,
    expires: Date.now() + data.expires_in * 1000,
  };
  return spotifyToken.value;
}

async function spotifyApi(pathAndQuery) {
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "Unknown error");
    console.error(
      `[Spotify API Error] Status: ${res.status} | Detail: ${errorText}`,
    );
    throw new Error(`Spotify API HTTP ${res.status}`);
  }
  return res.json();
}

async function searchSpotifyTracks(query) {
  const data = await spotifyApi(
    `/search?q=${encodeURIComponent(query)}&type=track&limit=10&market=US`,
  );
  const items = ((data.tracks && data.tracks.items) || [])
    .filter(Boolean)
    .map(spotifyInfoFromApi);
  items.forEach((info) => cacheSet(spotifyCache, info.id, info));
  return items;
}

async function resolveSpotifyTrack(url) {
  const id = (url.match(/\/track\/([A-Za-z0-9]+)/) || [])[1];
  if (!id) return null;
  if (spotifyCache.has(id)) return spotifyCache.get(id);

  let info = null;
  if (spotifyEnabled()) {
    try {
      info = spotifyInfoFromApi(await spotifyApi(`/tracks/${id}`));
    } catch (err) {
      spotifyWarn(err);
    }
  }
  if (!info) info = await getSpotifyTrackInfo(url);
  if (info) cacheSet(spotifyCache, id, info);
  return info;
}

async function bestSpotifyForQuery(query) {
  const ranked = rankSpotify(await searchSpotifyTracks(query), query);
  const top = ranked[0];
  return top && top.hit >= 0.5 ? top.i : null;
}

function rememberSpotifyForVideo(videoUrl, info) {
  const id = ytIdOf(videoUrl);
  if (id) cacheSet(spotifyByVideo, id, info);
}

// ---------- Pencarian YouTube Music / YouTube ----------
let YoutubeExtractor = null;
let YoutubeLib = null;
try {
  const yt = require("discord-player-youtubei");
  YoutubeLib = yt;
  YoutubeExtractor =
    yt.YoutubeExtractor ||
    yt.YoutubeiExtractor ||
    (yt.default &&
      (yt.default.YoutubeExtractor || yt.default.YoutubeiExtractor)) ||
    null;
} catch (err) {
  console.log("⚠️ Paket discord-player-youtubei gagal dimuat:", err.message);
}

let ytMusicWarned = false;
async function searchYoutubeMusic(term, limit = 10) {
  if (!YoutubeLib || typeof YoutubeLib.getInnertube !== "function") {
    throw new Error("getInnertube tidak tersedia di paket youtubei");
  }
  const innertube = await YoutubeLib.getInnertube();
  const res = await innertube.music.search(term, { type: "song" });
  return musicResultToCandidates(res, limit);
}

// Versi "lebar" khusus dashboard web: ambil beberapa halaman hasil YT Music
async function searchYoutubeMusicWide(term, limit = 40) {
  const innertube = await YoutubeLib.getInnertube();
  let res = await innertube.music.search(term, { type: "song" });
  const seen = new Set();
  const out = [];
  const add = (r) => {
    for (const c of musicResultToCandidates(r, 100)) {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        out.push(c);
      }
    }
  };
  add(res);
  for (let page = 0; page < 3 && out.length < limit; page++) {
    try {
      if (!res || typeof res.getContinuation !== "function") break;
      if (res.has_continuation === false) break;
      res = await withTimeout(
        res.getContinuation(),
        4000,
        "continuation timeout",
      );
      const before = out.length;
      add(res);
      if (out.length === before) break;
    } catch {
      break;
    }
  }
  return out.slice(0, limit);
}

async function webMusicList(term) {
  try {
    const list = await withTimeout(
      searchYoutubeMusicWide(term, 40),
      9000,
      "YT Music timeout",
    );
    if (list.length) return { source: "YouTube Music", list };
  } catch {}
  // cadangan: jalur lama (YT Music biasa -> YouTube)
  return searchCandidates(term, undefined, { fast: true });
}

async function searchCandidatesRaw(term, requestedBy, { fast = false } = {}) {
  try {
    const list = await withTimeout(
      searchYoutubeMusic(term),
      5000,
      "YT Music timeout",
    );
    if (list.length) return { source: "YouTube Music", list };
  } catch (err) {
    if (!ytMusicWarned) {
      ytMusicWarned = true;
      console.log(
        "⚠️ [YT Music] Pencarian gagal, pakai YouTube biasa:",
        err.message,
      );
    }
  }

  const queries = fast ? [term] : [term, `${term} topic`];
  const settled = await Promise.allSettled(
    queries.map((q) =>
      player.search(q, { searchEngine: "youtubeSearch", requestedBy }),
    ),
  );
  const seen = new Set();
  const list = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const t of r.value.tracks.slice(0, 8)) {
      if (!seen.has(t.url)) {
        seen.add(t.url);
        list.push(t);
      }
    }
  }
  return { source: "YouTube", list };
}

const searchCache = new Map();
const searchInflight = new Map();
const SEARCH_TTL = 10 * 60 * 1000;

function withTimeout(promise, ms, label = "timeout") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function searchCandidates(term, requestedBy, opts = {}) {
  const base = String(term).trim().toLowerCase().replace(/\s+/g, " ");
  const key = `${opts.fast ? "f" : "n"}|${base}`;

  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) {
    return Promise.resolve(hit.value);
  }
  if (searchInflight.has(key)) return searchInflight.get(key);

  const job = searchCandidatesRaw(term, requestedBy, opts)
    .then((value) => {
      if (value.list.length) {
        const entry = { at: Date.now(), value };
        cacheSet(searchCache, key, entry, 300);
        if (value.source === "YouTube Music") {
          cacheSet(searchCache, `${opts.fast ? "n" : "f"}|${base}`, entry, 300);
        }
      }
      return value;
    })
    .finally(() => searchInflight.delete(key));

  searchInflight.set(key, job);
  return job;
}

// Cek apakah video bisa diputar tanpa login (age-restricted → LOGIN_REQUIRED dll)
async function findBestTrack(meta, requestedBy) {
  const { source, list } = await searchCandidates(meta.query, requestedBy);
  if (list.length === 0) return null;

  const ranked = pickBest(list, meta);
  console.log(
    `[Match] (${source}) "${meta.query}" ->`,
    ranked.slice(0, 3).map((x) => `${x.s} | ${x.t.title} (${x.t.author})`),
  );
  return ranked[0].t;
}

// ---------- Cari lagu lewat LIRIK (Genius) ----------
const lyricCache = new Map();
const lyricInflight = new Map();

const lyricWords = (s) =>
  normU(s)
    .split(" ")
    .filter((w) => w.length > 1);

function lyricOverlap(query, text) {
  const q = lyricWords(query);
  if (!q.length) return 0;
  const hay = normU(text);
  return q.filter((w) => hay.includes(w)).length / q.length;
}

async function fetchJsonWith(url, headers = {}, ms = 3500) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SP_UA, Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(ms),
    });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

function searchLyrics(query) {
  const key = normU(query);
  const hit = lyricCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
    return Promise.resolve(hit.list);
  }
  if (lyricInflight.has(key)) return lyricInflight.get(key);

  const job = (async () => {
    const q = encodeURIComponent(query);
    const token = process.env.GENIUS_TOKEN;
    let list = [];
    let failed = false;

    if (token) {
      const data = await fetchJsonWith(`https://api.genius.com/search?q=${q}`, {
        Authorization: `Bearer ${token}`,
      });
      if (data === undefined) failed = true;
      const hits = (data && data.response && data.response.hits) || [];
      list = hits
        .filter((h) => h && h.type === "song" && h.result)
        .map((h) => ({
          title: h.result.title,
          artist: h.result.primary_artist && h.result.primary_artist.name,
        }));
    } else {
      const data = await fetchJsonWith(
        `https://genius.com/api/search/multi?per_page=5&q=${q}`,
      );
      if (data === undefined) failed = true;
      const sections = (data && data.response && data.response.sections) || [];
      const sec = sections.find((s) => s && s.type === "lyric");
      for (const h of (sec && sec.hits) || []) {
        const r = h && h.result;
        if (!r) continue;
        const snippet = (h.highlights || [])
          .map((x) => x && x.value)
          .filter(Boolean)
          .join(" ");
        if (
          snippet &&
          Math.max(lyricOverlap(query, snippet), lyricOverlap(snippet, query)) <
            0.6
        )
          continue;
        list.push({
          title: r.title,
          artist: r.primary_artist && r.primary_artist.name,
        });
      }
    }

    list = list.filter((x) => x.title && x.artist);
    if (list.length || !failed)
      cacheSet(lyricCache, key, { at: Date.now(), list }, 200);
    return list;
  })().finally(() => lyricInflight.delete(key));

  lyricInflight.set(key, job);
  return job;
}

async function findBestSmart(input, requestedBy) {
  const { source, list } = await searchCandidates(input, requestedBy);
  const ranked = list.length ? pickBest(list, { query: input }) : [];
  const top = ranked[0] ? ranked[0].t : null;
  if (top) {
    console.log(
      `[Match] (${source}) "${input}" ->`,
      ranked.slice(0, 3).map((x) => `${x.s} | ${x.t.title} (${x.t.author})`),
    );
  }

  if (lyricWords(input).length < 4) return { best: top };
  const conf = top ? lyricOverlap(input, `${top.title} ${top.author}`) : 0;
  if (conf >= 0.6) return { best: top };

  const cands = await withTimeout(
    searchLyrics(input),
    4000,
    "lirik timeout",
  ).catch(() => []);

  for (const c of cands.slice(0, 3)) {
    const artist = String(c.artist).split(",")[0].trim();
    const best = await findBestTrack(
      { query: `${artist} ${c.title}`.trim(), title: c.title, artist },
      requestedBy,
    );
    if (best && titleSim(c.title, best.title) >= 0.6) {
      console.log(`[Lirik] "${input}" -> ${c.title} — ${c.artist}`);
      return { best, lyric: c };
    }
  }
  return { best: top };
}

// ---------- YouTube ASLI ----------
const YT_MAX_AUTOPLAY_MS = 45 * 60 * 1000;
const YT_MIN_AUTOPLAY_MS = 45 * 1000;

// Baca jumlah views dari node hasil pencarian YouTube → angka (0 kalau tidak ada)
function parseViews(n) {
  const raw = (x) => (x && (x.text || (typeof x === "string" ? x : ""))) || "";
  const full = raw(n && n.view_count);
  const short = raw(n && n.short_view_count);
  // "1,234,567 views" → angka penuh
  if (
    /\d/.test(full) &&
    !/[a-z]\s*$/i.test(full.replace(/views?|x ditonton/gi, "").trim())
  ) {
    const v = Number(full.replace(/[^\d]/g, ""));
    if (v) return v;
  }
  // "1.2M views" / "1,2 jt x ditonton" → pakai singkatan
  const txt = (short || full).toLowerCase();
  const m = txt.match(/(\d[\d.,]*)\s*(k|rb|ribu|m|jt|juta|b|miliar)?/);
  if (!m) return 0;
  const mult =
    {
      k: 1e3,
      rb: 1e3,
      ribu: 1e3,
      m: 1e6,
      jt: 1e6,
      juta: 1e6,
      b: 1e9,
      miliar: 1e9,
    }[m[2]] || 1;
  const num = m[2]
    ? parseFloat(m[1].replace(",", "."))
    : Number(m[1].replace(/[^\d]/g, ""));
  return Number.isFinite(num) ? Math.round(num * mult) : 0;
}

function ytNodeToCandidate(n, fallbackAuthor) {
  if (!n) return null;
  const id = n.video_id || n.id || n.content_id;
  if (typeof id !== "string" || id.length !== 11) return null;
  const title =
    (n.title && n.title.text) || (typeof n.title === "string" ? n.title : null);
  if (!title) return null;
  const author =
    (n.author && n.author.name) ||
    (n.short_byline_text && n.short_byline_text.text) ||
    fallbackAuthor ||
    "Unknown";
  const seconds = n.duration ? Number(n.duration.seconds) : 0;
  return {
    title: String(title),
    author: String(author),
    duration: (n.duration && n.duration.text) || "0:00",
    durationMS: seconds > 0 ? seconds * 1000 : 0,
    url: `https://www.youtube.com/watch?v=${id}`,
    views: parseViews(n),
  };
}

const ytBasicOk = (c) => !/-\s*topic$/i.test(c.author) && c.durationMS > 0;

async function ytSearchRaw(term, limit) {
  const innertube = await YoutubeLib.getInnertube();
  let res = await innertube.search(term, { type: "video" });
  const seen = new Set();
  let out = [];
  const add = (r) => {
    const nodes = Array.from((r && (r.videos || r.results)) || []);
    for (const c of nodes
      .map((n) => ytNodeToCandidate(n))
      .filter(Boolean)
      .filter(ytBasicOk)) {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        out.push(c);
      }
    }
  };
  add(res);
  // halaman berikutnya hanya diambil kalau limit belum terpenuhi (maks 3 halaman tambahan)
  for (let page = 0; page < 3 && out.length < limit; page++) {
    try {
      if (!res || typeof res.getContinuation !== "function") break;
      if (res.has_continuation === false) break;
      res = await withTimeout(
        res.getContinuation(),
        4000,
        "continuation timeout",
      );
      const before = out.length;
      add(res);
      if (out.length === before) break;
    } catch {
      break;
    }
  }
  return out.slice(0, limit);
}

const ytCache = new Map();
async function ytSearchCandidates(term, limit = 15) {
  const key =
    String(term).trim().toLowerCase().replace(/\s+/g, " ") + "|" + limit;
  const hit = ytCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.list;

  let list = [];
  try {
    list = await withTimeout(
      ytSearchRaw(term, limit),
      limit > 20 ? 10000 : 6000,
      "YT timeout",
    );
  } catch (err) {
    console.log("[YT] Pencarian innertube gagal:", err.message);
  }

  if (!list.length) {
    try {
      const r = await player.search(term, { searchEngine: "youtubeSearch" });
      list = r.tracks
        .map((t) => ({
          title: t.title,
          author: t.author || "Unknown",
          duration: t.duration,
          durationMS: t.durationMS,
          url: t.url,
        }))
        .filter(ytBasicOk)
        .slice(0, limit);
    } catch (err) {
      console.log("[YT] Cadangan gagal:", err.message);
    }
  }

  if (list.length) cacheSet(ytCache, key, { at: Date.now(), list }, 300);
  return list;
}

function ytRank(cands, query) {
  const q = norm(query);
  const words = q.split(" ").filter((w) => w.length > 1);
  return cands
    .map((t, i) => {
      const tt = norm(t.title);
      const hay = `${tt} ${norm(t.author)}`;
      let s = words.length
        ? (words.filter((w) => hay.includes(w)).length / words.length) * 60
        : 0;
      const sec = t.durationMS / 1000;
      if (sec > 0 && sec < 60) s -= 30;
      if (sec > 720) s -= 25;
      if (
        /\b(reaction|tutorial|karaoke|full album|1 hour|jam)\b/.test(tt) &&
        !/\b(reaction|tutorial|karaoke|full album|1 hour|jam)\b/.test(q)
      )
        s -= 30;
      s -= i * 1.5;
      return { t, i, s };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i);
}

function ytCleanUrl(q) {
  try {
    const u = new URL(q);
    const isYt = /(^|\.)youtube\.com$/.test(u.hostname);
    const v = u.searchParams.get("v");
    if (isYt && v) return `https://www.youtube.com/watch?v=${v}`;
  } catch {}
  return q;
}

async function ytAutoplayCandidates(videoId, track) {
  const author = String(track.author || "").trim();
  const authorKey = normU(author);
  const sameCh = (c) => Boolean(authorKey) && normU(c.author) === authorKey;
  const ok = (c) =>
    ytBasicOk(c) &&
    c.durationMS >= YT_MIN_AUTOPLAY_MS &&
    c.durationMS <= YT_MAX_AUTOPLAY_MS &&
    !sameSong(track.title, c.title);

  let own = [];
  let related = [];

  try {
    const innertube = await YoutubeLib.getInnertube();
    const info = await withTimeout(
      innertube.getInfo(videoId),
      6000,
      "getInfo timeout",
    );

    related = Array.from(info.watch_next_feed || info.related_videos || [])
      .map((n) => ytNodeToCandidate(n))
      .filter(Boolean);

    const chId = info.basic_info && info.basic_info.channel_id;
    if (chId) {
      try {
        const ch = await withTimeout(
          innertube.getChannel(chId),
          6000,
          "getChannel timeout",
        );
        const tab = await withTimeout(
          ch.getVideos(),
          6000,
          "getVideos timeout",
        );
        own = Array.from(tab.videos || [])
          .map((n) => ytNodeToCandidate(n, author))
          .filter(Boolean);
      } catch (err) {
        console.log("[Autoplay YT] Video channel gagal:", err.message);
      }
    }
  } catch (err) {
    console.log("[Autoplay YT] getInfo gagal:", err.message);
  }

  if (own.filter(ok).length < 3 && author) {
    const s = await ytSearchCandidates(author, 20);
    own = own.concat(s.filter(sameCh));
  }

  let all = [...own, ...related].filter(ok);

  if (all.length < 3) {
    const q = cleanTitleForCover(track.title) || track.title;
    all = all.concat((await ytSearchCandidates(q, 15)).filter(ok));
  }

  const seenUrl = new Set();
  return all
    .filter((c) => (seenUrl.has(c.url) ? false : seenUrl.add(c.url)))
    .map((c) => ({ ...c, sameChannel: sameCh(c) }));
}

// ---------- Autoplay ----------
async function upNextCandidates(videoId, limit = 15) {
  const innertube = await YoutubeLib.getInnertube();
  const upNext = await innertube.music.getUpNext(videoId);
  const out = [];
  for (const i of Array.from((upNext && upNext.contents) || [])) {
    const id = i && (i.video_id || i.id);
    if (typeof id !== "string" || !i.title) continue;
    const people = i.artists && i.artists.length ? i.artists : i.authors || [];
    const seconds = i.duration ? Number(i.duration.seconds) : 0;
    out.push({
      title: String(i.title),
      author:
        people
          .map((a) => a.name)
          .filter(Boolean)
          .join(", ") || "Unknown",
      duration: (i.duration && i.duration.text) || "0:00",
      durationMS: seconds > 0 ? seconds * 1000 : 0,
      url: `https://www.youtube.com/watch?v=${id}`,
      isMusicSong: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function dropAutoplayTracks(queue) {
  const ids = queue && queue.metadata && queue.metadata.autoplayIds;
  if (!ids || !ids.size) return;
  for (const t of queue.tracks.toArray()) {
    if (ids.has(t.id)) queue.removeTrack(t);
  }
  ids.clear();
}

// ---------- Autoplay 24/7 ----------
const AUTOPLAY_BUFFER = 3; // jumlah lagu autoplay yang disiapkan di depan
const AUTOPLAY_SEEN_MAX = 200;
const AUTOPLAY_MAX_TRIES = 8;

const shuffleArr = (arr) => {
  const b = [...arr];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// ---------- Deteksi judul sama & tipe konten (autoplay) ----------
const AP_VERSION_WORDS =
  /\b(remix|cover|live|acoustic|instrumental|karaoke|sped up|slowed|reverb|nightcore|8d|version|ver|edit|remaster(?:ed)?|mono|stereo|lyrics?|official|video|audio|mv|hd|hq|4k)\b/g;
const songKeyCache = new Map();

// "Artist - Judul (Remix)" -> beberapa varian judul inti yang sudah dibersihkan
function songKeys(title) {
  const raw = String(title || "");
  const hit = songKeyCache.get(raw);
  if (hit) return hit;
  const parts = raw.split(/\s[-–|]\s/);
  const variants = [raw, ...(parts.length > 1 ? parts.slice(1) : [])];
  const keys = variants
    .map((v) =>
      normU(cleanTitleForCover(v) || v)
        .replace(AP_VERSION_WORDS, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
  if (songKeyCache.size > 3000) songKeyCache.clear();
  songKeyCache.set(raw, keys);
  return keys;
}

// true kalau dua judul dianggap lagu yang sama (termasuk versi remix/cover/lyrics)
function sameSong(a, b) {
  for (const x of songKeys(a)) {
    for (const y of songKeys(b)) {
      if (x === y) return true;
      const xt = x.split(" ");
      const yt = y.split(" ");
      const [s, l] = xt.length <= yt.length ? [xt, yt] : [yt, xt];
      if (s.length >= 3 && s.every((w) => l.includes(w))) return true;
      if (titleSim(x, y) >= 0.75) return true;
    }
  }
  return false;
}

// Skor "setipe" untuk YouTube biasa: tag konten yang sama + durasi sepadan
const YT_TYPE_TAGS =
  /\b(cover|live|acoustic|lofi|lo fi|ost|remix|instrumental|piano|guitar|nightcore|slowed|reverb|amv|opening|ending|gameplay|podcast|karaoke|medley)\b/g;
function ytTypeScore(seed, c) {
  let s = 0;
  const a = new Set(normU(seed.title).match(YT_TYPE_TAGS) || []);
  const b = new Set(normU(c.title).match(YT_TYPE_TAGS) || []);
  for (const t of a) s += b.has(t) ? 12 : -4;
  for (const t of b) if (!a.has(t)) s -= 6;
  const sd = seed.durationMS;
  const cd = c.durationMS;
  if (sd > 0 && cd > 0) {
    const r = cd / sd;
    if (r >= 0.6 && r <= 1.6) s += 10;
    else if (r > 2.5 || r < 0.35) s -= 15;
  }
  return s;
}

async function autoplayCandidatesFor(seed) {
  const vid = ytIdOf(seed.url);
  const isYt = Boolean(seed.ytSource);
  let list = [];

  if (vid) {
    try {
      list = await withTimeout(
        isYt ? ytAutoplayCandidates(vid, seed) : upNextCandidates(vid),
        25000,
        "autoplay timeout",
      );
    } catch (err) {
      console.log("[Autoplay] Ambil kandidat gagal:", err.message);
    }
  }

  // Cadangan: cari lewat judul + artis (juga untuk seed SoundCloud/upload)
  if (!list.length) {
    const artist = String(seed.author || "")
      .replace(/\s*-\s*topic$/i, "")
      .trim();
    const q =
      `${cleanTitleForCover(seed.title) || seed.title} ${artist}`.trim();
    // YT Music tetap cari di YT Music, YouTube biasa tetap di YouTube biasa
    list = await (
      isYt ? ytSearchCandidates(q, 15) : searchYoutubeMusic(q, 15)
    ).catch(() => []);
  }

  return list.filter(
    (c) =>
      c.durationMS >= YT_MIN_AUTOPLAY_MS && c.durationMS <= YT_MAX_AUTOPLAY_MS,
  );
}

function autoplayOrder(cands, seed, isYt, md) {
  if (isYt) {
    const ranked = ytRank(cands, seed.title)
      .map((x) => ({ ...x, s: x.s + ytTypeScore(seed, x.t) }))
      .sort((a, b) => b.s - a.s || a.i - b.i);
    const own = ranked.filter((x) => x.t.sameChannel);
    const other = ranked.filter((x) => !x.t.sameChannel);
    const useOwn = own.length && (!other.length || Math.random() < 0.85);
    const first = (useOwn ? own : other).slice(0, useOwn ? 5 : 3);
    const rest = ranked.filter((x) => !first.includes(x)).slice(0, 5);
    return [...shuffleArr(first), ...rest].map((x) => x.t);
  }

  const ranked = pickBest(cands, { query: "" });
  const recent = new Set((md.autoplayArtists || []).slice(-3));
  const fresh = ranked.filter((x) => !recent.has(normU(x.t.author)));
  const base = fresh.length ? fresh : ranked;
  const good = base.filter((x) => x.s >= 50).slice(0, 5);
  const first = good.length ? good : base.slice(0, 1);
  const rest = ranked.filter((x) => !first.includes(x)).slice(0, 5);
  return [...shuffleArr(first), ...rest].map((x) => x.t);
}

function scheduleAutoplayRetry(queue, ms) {
  const md = queue && queue.metadata;
  if (!md || !md.autoplay || md.autoplayRetryTimer) return;
  md.autoplayRetryTimer = setTimeout(() => {
    md.autoplayRetryTimer = null;
    if (
      md.autoplay &&
      !md.autoplayStopped &&
      useQueue(queue.guild.id) === queue
    ) {
      fillAutoplay(queue).catch(() => {});
    }
  }, ms);
}

async function autoplayEnsurePlaying(queue) {
  try {
    const md = queue && queue.metadata;
    if (!md || !md.autoplay || md.autoplayStopped) return;
    if (useQueue(queue.guild.id) !== queue) return;
    if (
      queue.tracks.size > 0 &&
      queue.node.isIdle() &&
      !queue.node.isPaused()
    ) {
      await queue.node.play();
    }
  } catch (err) {
    console.log("[Autoplay] Gagal menyalakan pemutaran:", err.message);
  }
}

async function fillAutoplay(queue, seedTrack) {
  const md = queue && queue.metadata;
  if (!md || !md.autoplay || md.autoplayStopped) return;

  // catat seed (lagu yang baru diputar) untuk cadangan kalau satu seed gagal
  if (seedTrack) {
    md.autoplayLast = seedTrack;
    const seeds = md.autoplaySeeds || (md.autoplaySeeds = []);
    if (!seeds.some((t) => t.id === seedTrack.id)) {
      seeds.push(seedTrack);
      if (seeds.length > 5) seeds.shift();
    }
  }
  const seed = seedTrack || md.autoplayLast || queue.currentTrack;
  if (!seed) return;

  const need = AUTOPLAY_BUFFER - queue.tracks.size;
  if (need <= 0 || queue.tracks.size >= MAX_QUEUE) return;

  // masih ada proses yang jalan (kurang dari 45 dtk) -> jangan dobel
  if (md.autoplayBusy && Date.now() - (md.autoplayBusyAt || 0) < 45000) return;
  md.autoplayBusy = true;
  md.autoplayBusyAt = Date.now();
  const run = (md.autoplayRun = (md.autoplayRun || 0) + 1);
  const stale = () =>
    md.autoplayRun !== run || !md.autoplay || md.autoplayStopped;

  let added = 0;
  try {
    const seen = md.autoplaySeen || (md.autoplaySeen = new Set());
    if (!md.autoplaySeenAt) md.autoplaySeenAt = Date.now();
    if (Date.now() - md.autoplaySeenAt > 6 * 60 * 60 * 1000) {
      seen.clear();
      md.autoplaySeenAt = Date.now();
      console.log("[Autoplay] seen di-reset (6 jam)");
    }
    const curId = ytIdOf(seed.url);
    if (curId) seen.add(curId);
    queue.history.tracks.toArray().forEach((t) => {
      const id = ytIdOf(t.url);
      if (id) seen.add(id);
    });

    const ids = md.autoplayIds || (md.autoplayIds = new Set());
    // judul yang sedang/baru diputar + yang sudah antre: jangan ada yang sejudul
    const recentTitles = [
      seed.title,
      ...queue.history.tracks.toArray().map((t) => t.title),
      ...queue.tracks.toArray().map((t) => t.title),
    ].filter(Boolean);
    const seeds = [
      seed,
      ...(md.autoplaySeeds || [])
        .slice()
        .reverse()
        .filter((t) => t.id !== seed.id),
    ].slice(0, 4);

    let tries = 0;
    for (const s of seeds) {
      if (added >= need || stale() || tries >= AUTOPLAY_MAX_TRIES) break;
      const isYt = Boolean(s.ytSource);

      const cands = (await autoplayCandidatesFor(s)).filter(
        (c) =>
          !seen.has(ytIdOf(c.url)) &&
          !recentTitles.some((x) => sameSong(x, c.title)),
      );
      if (!cands.length) continue;

      for (const c of autoplayOrder(cands, s, isYt, md)) {
        if (added >= need || stale() || tries >= AUTOPLAY_MAX_TRIES) break;
        tries++;
        const vid = ytIdOf(c.url);
        try {
          const res = await withTimeout(
            player.search(c.url, { requestedBy: s.requestedBy }),
            12000,
            "search timeout",
          );
          const t = res.tracks[0];
          if (!t) {
            seen.add(vid);
            continue;
          }
          if (stale()) break;

          if (recentTitles.some((x) => sameSong(x, t.title))) {
            seen.add(vid);
            continue;
          }
          recentTitles.push(t.title);
          t.fromAutoplay = true;
          t.ytSource = isYt;
          ids.add(t.id);
          queue.addTrack(t);
          seen.add(vid);

          const arts = md.autoplayArtists || (md.autoplayArtists = []);
          arts.push(normU(c.author));
          if (arts.length > 6) arts.shift();
          added++;
        } catch (err) {
          seen.add(vid); // video bermasalah, jangan dicoba lagi
          console.log("[Autoplay] Lewati kandidat:", err.message);
        }
      }
    }

    while (seen.size > AUTOPLAY_SEEN_MAX)
      seen.delete(seen.values().next().value);

    // semua kandidat sudah pernah diputar -> kosongkan riwayat, coba lagi nanti
    if (!added && !stale()) {
      seen.clear();
      md.autoplaySeenAt = Date.now();
    }
  } catch (err) {
    console.log("[Autoplay] Gagal ambil lagu berikutnya:", err.message);
  } finally {
    if (md.autoplayRun === run) md.autoplayBusy = false;
  }

  if (added) {
    md.autoplayFails = 0;
    console.log(`[Autoplay] +${added} lagu (antrian: ${queue.tracks.size})`);
    setTimeout(() => autoplayEnsurePlaying(queue), 1500);
  } else if (!stale()) {
    md.autoplayFails = (md.autoplayFails || 0) + 1;
    if (queue.tracks.size === 0) {
      const wait = Math.min(
        60000,
        3000 * 2 ** Math.min(md.autoplayFails - 1, 5),
      );
      console.log(`[Autoplay] Gagal, coba lagi ${Math.round(wait / 1000)} dtk`);
      scheduleAutoplayRetry(queue, wait);
    }
  }
}

// ---------- Anti-crash ----------
const showError = (label, err) =>
  console.error(`❌ ${label}: [${err && err.code}] ${err && err.message}`);
process.on("unhandledRejection", (err) =>
  showError("Unhandled rejection", err),
);
process.on("uncaughtException", (err) => showError("Uncaught exception", err));

// ---------- Client & Player ----------
const client = new Client({
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 25,
    ReactionManager: 0,
    PresenceManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 300, lifetime: 900 },
  },
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    ...(process.env.PREFIX_ENABLED === "false"
      ? []
      : [GatewayIntentBits.MessageContent]),
  ],
});

const player = new Player(client, { queryCache: null });

// ---------- Panel embed + tombol ----------
const LOOP_LABEL = {
  [QueueRepeatMode.OFF]: "mati",
  [QueueRepeatMode.TRACK]: "lagu ini",
  [QueueRepeatMode.QUEUE]: "antrian",
  [QueueRepeatMode.AUTOPLAY]: "autoplay",
};

function volumeBar(v) {
  const filled = Math.round(v / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

function statusFooter(queue) {
  const parts = [];
  if (queue.repeatMode !== QueueRepeatMode.OFF)
    parts.push(`Loop: ${LOOP_LABEL[queue.repeatMode] || "mati"}`);
  if (queue.metadata && queue.metadata.autoplay) parts.push("Autoplay");
  return parts.join(" • ");
}

function buildButtons(queue) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("mp_queue")
      .setEmoji("1564131658150584431")
      .setLabel("Queue")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("mp_settings")
      .setEmoji("⚙️")
      .setLabel("Settings")
      .setStyle(ButtonStyle.Secondary),
  );
  return [row];
}

function buildControlRow(queue) {
  const iconLoop = "1564650854735286272";
  const loopLabel =
    queue.repeatMode === QueueRepeatMode.TRACK
      ? "Loop: lagu"
      : queue.repeatMode === QueueRepeatMode.QUEUE
        ? "Loop: antrian"
        : "Loop";
  const paused = queue.node.isPaused();
  const isAutoplay = Boolean(queue.metadata && queue.metadata.autoplay);

  const iconPlay = "1564131544145068042";
  const iconPause = "1564131544145068042";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(paused ? "mp_play" : "mp_pause")
      .setEmoji(paused ? iconPlay : iconPause)
      .setLabel(paused ? "Play" : "Pause")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("mp_skip")
      .setEmoji("1564156479542403112")
      .setLabel("Skip")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("mp_stop")
      .setEmoji("1564135073002033252")
      .setLabel("Stop")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("mp_autoplay")
      .setEmoji("1564132699286016020")
      .setLabel("Autoplay")
      .setStyle(isAutoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("mp_loop")
      .setEmoji(iconLoop)
      .setLabel(loopLabel)
      .setStyle(ButtonStyle.Secondary),
  );
}

function clearPanel(queue) {
  if (queue.metadata && queue.metadata.panel) {
    queue.metadata.panel.delete().catch(() => {});
    queue.metadata.panel = null;
  }
}

function trackColor(track) {
  const src = (track.source || "").toLowerCase();
  if (src.includes("youtube")) return 0xff0000;
  if (src.includes("spotify")) return 0x1db954;
  if (src.includes("soundcloud")) return 0xff5500;
  return 0x5865f2;
}

const HAS_V2 =
  typeof ContainerBuilder === "function" &&
  typeof SectionBuilder === "function" &&
  typeof TextDisplayBuilder === "function" &&
  typeof ThumbnailBuilder === "function" &&
  typeof SeparatorBuilder === "function" &&
  MessageFlags.IsComponentsV2 !== undefined;

const mdSafe = (s) => String(s).replace(/\[/g, "(").replace(/\]/g, ")");

function buildPanelPayload(queue) {
  const d = (queue.metadata && queue.metadata.panelData) || {
    color: 0x5865f2,
    title: "Sedang memutar",
    url: null,
    lines: [],
    thumb: null,
  };
  const footer = statusFooter(queue);
  const rows = buildButtons(queue);
  const controls = buildControlRow(queue);

  if (HAS_V2) {
    const titleLine = `### ${mdSafe(d.title)}`;
    const body = `<:waveformbold:1564655771604623503> playing...\n${titleLine}${d.lines.length ? "\n" + d.lines.join("\n") : ""}`;
    const text = new TextDisplayBuilder().setContent(body);

    const container = new ContainerBuilder().setAccentColor(d.color);
    if (d.thumb) {
      container.addSectionComponents(
        new SectionBuilder()
          .addTextDisplayComponents(text)
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(d.thumb)),
      );
    } else {
      container.addTextDisplayComponents(text);
    }
    if (footer)
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${footer}`),
      );
    container.addActionRowComponents(controls);

    return {
      components: [container, ...rows],
      flags: MessageFlags.IsComponentsV2,
    };
  }

  const embed = new EmbedBuilder()
    .setColor(d.color)
    .setAuthor({
      name: "playing...",
      iconURL: "https://cdn.discordapp.com/emojis/1564143890942922903.png",
    })
    .setTitle(d.title)
    .setTimestamp();

  if (d.lines.length) embed.setDescription(d.lines.join("\n"));
  if (d.thumb) embed.setThumbnail(d.thumb);
  if (footer) embed.setFooter({ text: footer });

  return { embeds: [embed], components: [controls, ...rows] };
}

function sendPanel(queue, track) {
  const md = queue.metadata;
  if (!md) return Promise.resolve();
  md.panelChain = (md.panelChain || Promise.resolve())
    .then(() => sendPanelNow(queue, track))
    .catch((err) => console.error("Gagal kirim panel:", err.message));
  return md.panelChain;
}

// Edit panel yang sudah ada supaya tombol/footer mengikuti state antrian terbaru
// (dipanggil setelah dashboard mengubah pause / loop / autoplay). Di-debounce
// agar klik beruntun tidak membanjiri API Discord, dan masuk rantai panelChain
// supaya tidak bentrok dengan sendPanel.
function refreshPanel(queue, delay = 250) {
  const md = queue && queue.metadata;
  if (!md || !md.panel) return;
  clearTimeout(md.panelRefreshTimer);
  md.panelRefreshTimer = setTimeout(() => {
    md.panelRefreshTimer = null;
    md.panelChain = (md.panelChain || Promise.resolve())
      .then(async () => {
        const panel = md.panel;
        if (!panel) return;
        md.panel = await panel.edit({
          ...buildPanelPayload(queue),
          allowedMentions: { parse: [] },
        });
      })
      .catch((err) => console.error("Gagal sinkron panel:", err.message));
  }, delay);
}

// Logika autoplay & skip dipakai bersama oleh tombol Discord dan dashboard
function setAutoplay(queue, on) {
  const md = queue.metadata || (queue.metadata = {});
  md.autoplay = !!on;
  if (md.autoplay) {
    md.autoplayStopped = false;
    md.autoplayFails = 0;
    fillAutoplay(queue, queue.currentTrack || undefined).catch(() => {});
  } else {
    dropAutoplayTracks(queue);
  }
}

// Skip / jump saat player sedang pause: track baru ikut ke-pause (tidak bunyi).
// Resume sebelum aksi, lalu cek lagi sebentar setelahnya karena stream baru
// dibuat asinkron.
function ensureResumed(queue) {
  const resume = () => {
    try {
      if (queue && queue.node.isPaused()) {
        queue.node.resume();
        syncWebClock(queue);
        refreshPanel(queue);
      }
    } catch (err) {
      console.log("[Resume] gagal:", err.message);
    }
  };
  resume();
  setTimeout(resume, 400);
  setTimeout(resume, 1200);
}

function skipCurrent(queue) {
  const wasTrackLoop = queue.repeatMode === QueueRepeatMode.TRACK;
  if (wasTrackLoop) queue.setRepeatMode(QueueRepeatMode.OFF);
  ensureResumed(queue);
  queue.node.skip();
  if (wasTrackLoop) {
    setTimeout(() => {
      if (queue && queue.isPlaying())
        queue.setRepeatMode(QueueRepeatMode.TRACK);
    }, 1000);
  }
}

function relocatePanelTo(guildId, channel) {
  const q = useQueue(guildId);
  if (!q || !q.metadata) return;
  if (!channel || typeof channel.send !== "function") return;

  const md = q.metadata;
  const changed = !md.channel || md.channel.id !== channel.id;
  md.channel = channel;

  if (changed && q.currentTrack) {
    sendPanel(q, q.currentTrack).catch(() => {});
  }
}

async function applyCoverColor(data) {
  if (!data.thumb) return;
  const c = await Promise.race([
    getDominantColor(data.thumb).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 800)),
  ]);
  if (c) data.color = c;
}

const isHttp = (u) => typeof u === "string" && /^https?:\/\//.test(u);
const cleanArtist = (a) =>
  a ? a.replace(/\s*-\s*Topic$/i, "").trim() : "Unknown Artist";

function hasCustomId(comps, id) {
  return Array.from(comps || []).some(
    (c) => c && (c.customId === id || hasCustomId(c.components, id)),
  );
}

// Pemulihan setelah restart: hapus panel lama milik bot yang tertinggal
async function sweepOrphanPanels(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 10 });
    await Promise.all(
      messages
        .filter(
          (m) =>
            m.author.id === client.user.id &&
            hasCustomId(m.components, "mp_queue"),
        )
        .map((m) => m.delete().catch(() => {})),
    );
  } catch {}
}

async function sendPanelNow(queue, track) {
  const md = queue.metadata;
  const channel = md && md.channel;
  if (!channel) return;

  const sp = spotifyByVideo.get(ytIdOf(track.url));

  const reqLine =
    !track.fromAutoplay && track.requestedBy && track.requestedBy.id
      ? [`-# requested by <@${track.requestedBy.id}>`]
      : [];

  let data;
  let slowCover = null;
  if (sp) {
    const lines = [`**${sp.artist || "Unknown Artist"}**`, ...reqLine];
    if (sp.album) lines.push(`💿 ${sp.album}${sp.year ? ` · ${sp.year}` : ""}`);
    else if (sp.year) lines.push(`📅 ${sp.year}`);
    if (typeof sp.popularity === "number") {
      lines.push(`🔥 \`${volumeBar(sp.popularity)} ${sp.popularity}/100\``);
    }
    data = {
      color:
        sp.sourceName === "Deezer"
          ? 0xa238ff
          : sp.sourceName === "Apple Music"
            ? 0xfa243c
            : 0x1db954,
      title: clip(sp.title, 70),
      url: sp.url,
      lines,
      thumb: isHttp(sp.cover)
        ? sp.cover
        : isHttp(track.thumbnail)
          ? track.thumbnail
          : null,
    };
  } else {
    const isUpload = /discordapp/.test(track.url || "");
    const isSC = isSoundCloudTrack(track);

    let art = null;
    if (!isUpload && !track.ytSource && !isSC) {
      const job = getCoverArt(
        track.title,
        cleanArtist(track.author),
        track.durationMS,
      ).catch(() => null);
      art = await Promise.race([
        job,
        new Promise((resolve) => setTimeout(() => resolve(undefined), 700)),
      ]);
      if (art === undefined) {
        art = null;
        slowCover = job;
      }
    }
    data = {
      color: trackColor(track),
      title: clip(track.title, 70),
      url: isHttp(track.url) && !isUpload ? track.url : null,
      lines: [`**${cleanArtist(track.author)}**`, ...reqLine],
      thumb:
        isSC && isHttp(track.thumbnail)
          ? scBigCover(track.thumbnail)
          : isHttp(art)
            ? art
            : isHttp(track.thumbnail)
              ? track.thumbnail
              : null,
    };
  }

  await applyCoverColor(data);
  md.panelData = data;

  const payload = {
    ...buildPanelPayload(queue),
    allowedMentions: { parse: [] },
  };
  const old = md.panel;
  let posted = false;

  // Panel lama masih pesan terbaru di channel yang sama -> edit di tempat
  if (old && old.channelId === channel.id && channel.lastMessageId === old.id) {
    try {
      md.panel = await old.edit(payload);
      posted = true;
    } catch {}
  }

  // Selain itu: hapus yang lama, kirim yang baru di paling bawah
  if (!posted) {
    clearPanel(queue);
    if (!old) await sweepOrphanPanels(channel);
    try {
      md.panel = await channel.send(payload);
    } catch (err) {
      console.error(
        "Gagal kirim panel (cek izin Send Messages & Embed Links):",
        err.message,
      );
    }
  }

  if (slowCover) {
    slowCover.then(async (cover) => {
      if (!cover || !isHttp(cover) || !md.panel) return;
      if (md.panelData !== data) return;
      data.thumb = cover;
      const c = await getDominantColor(cover).catch(() => null);
      if (c) data.color = c;
      if (md.panelData !== data || !md.panel) return;
      md.panel.edit(buildPanelPayload(queue)).catch(() => {});
    });
  }
}

// ---------- Panel Now Playing selalu di paling bawah chat ----------
const BUMP_DELAY = 2000;
const BUMP_MIN_GAP = 5000;
const bumpTimers = new Map();
const lastBump = new Map();

function scheduleBump(guildId) {
  if (bumpTimers.has(guildId)) return;
  const wait = Math.max(
    BUMP_DELAY,
    (lastBump.get(guildId) || 0) + BUMP_MIN_GAP - Date.now(),
  );
  bumpTimers.set(
    guildId,
    setTimeout(async () => {
      bumpTimers.delete(guildId);
      const queue = useQueue(guildId);
      const md = queue && queue.metadata;
      const panel = md && md.panel;
      if (!panel || !queue.currentTrack) return;
      if (panel.channel && panel.channel.lastMessageId === panel.id) return;
      lastBump.set(guildId, Date.now());
      await sendPanel(queue, queue.currentTrack);
    }, wait),
  );
}

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId) return;
  // Pesan bot sendiri (balasan sukses/gagal/panel) tidak boleh memicu bump —
  // kalau dibiarkan, setiap reply bot akan hapus+kirim ulang panel (boros 2 API call).
  if (message.author.bot) return;
  const queue = useQueue(message.guildId);
  const panel = queue && queue.metadata && queue.metadata.panel;
  if (!panel) return;
  if (message.channelId !== panel.channelId || message.id === panel.id) return;
  scheduleBump(message.guildId);
});

player.events.on("audioTrackAdd", (queue, track) => {
  const ids = queue.metadata && queue.metadata.autoplayIds;
  if (!ids || !ids.size || ids.has(track.id)) return;
  dropAutoplayTracks(queue);
});
player.events.on("audioTracksAdd", (queue) => dropAutoplayTracks(queue));
player.events.on("emptyQueue", (queue) => {
  const md = queue.metadata;
  if (md && md.autoplay && !md.autoplayStopped) {
    fillAutoplay(queue).catch(() => {});
  } else {
    clearPanel(queue);
  }
});
player.events.on("disconnect", (queue) => {
  clearPanel(queue);

  const channel = queue.metadata?.channel;
  if (!channel) return;

  const isAutoLeave = queue.tracks.size === 0 && !queue.currentTrack;

  const gs = getSettings(queue.guild.id);
  const tmp = (text) =>
    channel
      .send(text)
      .then((m) => {
        if (gs.autoDelete)
          setTimeout(() => m.delete().catch(() => {}), gs.autoDeleteSec * 1000);
      })
      .catch(() => {});
  if (isAutoLeave) tmp("ngapain aku di situ? ga ngapa2in juga. 🚶‍♂️💨");
  else tmp("anjing di kick aku 🐶👢");
});

// ---------- Auto-Restore Panel ----------
client.on(Events.MessageDelete, async (message) => {
  if (!message.guildId) return;

  const queue = useQueue(message.guildId);
  if (!queue || !queue.metadata || !queue.metadata.panel) return;

  if (message.id === queue.metadata.panel.id) {
    console.log("Panel musik terhapus! Mengirim ulang panel baru...");
    queue.metadata.panel = null;

    setTimeout(async () => {
      if (queue.channel && queue.currentTrack) {
        await sendPanel(queue, queue.currentTrack);
      }
    }, 1000);
  }
});

client.on(Events.MessageDeleteBulk, async (messages, channel) => {
  if (!channel.guildId) return;

  const queue = useQueue(channel.guildId);
  if (!queue || !queue.metadata || !queue.metadata.panel) return;

  if (messages.has(queue.metadata.panel.id)) {
    console.log("Panel musik terhapus massal! Mengirim ulang panel baru...");
    queue.metadata.panel = null;

    setTimeout(async () => {
      if (queue.channel && queue.currentTrack) {
        await sendPanel(queue, queue.currentTrack);
      }
    }, 1500);
  }
});

function apply247(queue) {
  const stay = getSettings(queue.guild.id).stay247;
  queue.options.leaveOnEmpty = !stay;
  queue.options.leaveOnEnd = !stay;
  queue.options.leaveOnStop = !stay;
}

// ---------- SETTINGS UI (GENERAL & DJ) ----------
// ---------- SETTINGS UI (GENERAL & DJ) ----------
const LOCK_ID = "1564759491419836437";
const OPEN_ID = "1564760915717521521";
const LOCK = `<:lockkeyfill:${LOCK_ID}>`;
const OPEN = `<:globefill:${OPEN_ID}>`;
const onOff = (b) => (b ? "🟢 Aktif" : "⚫ Mati");
const access = (b) => (b ? `${OPEN} Bebas` : `${LOCK} DJ saja`);

// Satu pesan settings: V2 = satu kotak dengan pemisah, fallback = embed biasa
function packSettings(accent, title, sections) {
  if (HAS_V2) {
    const box = new ContainerBuilder().setAccentColor(accent);
    sections.forEach((sec, i) => {
      if (i > 0)
        box.addSeparatorComponents(
          new SeparatorBuilder()
            .setDivider(true)
            .setSpacing(SeparatorSpacingSize.Small),
        );
      if (sec.text)
        box.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(sec.text),
        );
      if (sec.row) box.addActionRowComponents(sec.row);
    });
    return { components: [box], flags: MessageFlags.IsComponentsV2 };
  }
  const embed = new EmbedBuilder()
    .setColor(accent)
    .setTitle(title)
    .setDescription(
      sections
        .map((x) => x.text)
        .filter(Boolean)
        .join("\n\n")
        .replace(/^### .*\n/, "") || "\u200b",
    );
  return {
    embeds: [embed],
    components: sections.map((x) => x.row).filter(Boolean),
  };
}

function buildSettingsUI(interaction, view = "general") {
  const gid = interaction.guildId;
  const s = getSettings(gid);
  const queue = useQueue(gid);
  const dj = (queue && queue.metadata && queue.metadata.dj) || null;
  const viewer = interaction.user;
  const isDJ = Boolean(dj && dj.userId === viewer.id);
  const isAdmin = true; // semua member boleh mengubah pengaturan

  const allowReq = s.djAllowRequest ?? false;
  const allowCtrl = s.djAllowControl ?? false;
  const allowQueue = s.djAllowQueue ?? false;

  // ---------- VIEW: DJ SETTINGS ----------
  if (view === "dj" && isDJ) {
    const text =
      `### 🎧 DJ Settings\n` +
      `Kamu adalah **DJ** saat ini. Atur siapa saja yang boleh berinteraksi dengan bot:\n\n` +
      `**Request lagu** — ${access(allowReq)}\n` +
      `-# /play, /yt, /play-file. Jika ${LOCK} DJ saja, hanya kamu yang bisa menambah lagu.\n` +
      `**Kontrol playback** — ${access(allowCtrl)}\n` +
      `-# Pause, skip, stop, volume, seek, loop. Jika ${LOCK} DJ saja, hanya kamu yang bisa kontrol.\n` +
      `**Atur antrian** — ${access(allowQueue)}\n` +
      `-# /clear, /remove, /shuffle. Jika ${LOCK} DJ saja, hanya kamu yang bisa hapus/acak antrian.`;

    const toggle = (id, label, on) =>
      new ButtonBuilder()
        .setCustomId(id)
        .setLabel(`${label}: ${on ? "Bebas" : "DJ saja"}`)
        .setEmoji(on ? OPEN_ID : LOCK_ID)
        .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);

    const toggles = new ActionRowBuilder().addComponents(
      toggle("st_dj_allowreq", "Request", allowReq),
      toggle("st_dj_allowctrl", "Kontrol", allowCtrl),
      toggle("st_dj_allowqueue", "Antrian", allowQueue),
    );
    const actions = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("st_dj_release")
        .setLabel("Lepas DJ")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId("st_dj_back")
        .setLabel("Kembali")
        .setStyle(ButtonStyle.Secondary),
    );
    return packSettings(0xeb459e, "🎧 DJ Settings", [
      { text, row: toggles },
      { row: actions },
    ]);
  }

  // ---------- VIEW: GENERAL ----------
  const currentReq =
    queue && queue.currentTrack && queue.currentTrack.requestedBy;
  const canClaim = Boolean(
    !dj &&
    currentReq &&
    currentReq.id === viewer.id &&
    !queue.currentTrack.fromAutoplay,
  );

  let hint;
  if (isDJ) {
    hint =
      "-# Kamu adalah DJ. Klik **DJ Settings** di bawah untuk mengatur akses.";
  } else if (canClaim) {
    hint =
      "-# Kamu baru saja memutar lagu ini. Klik **Ambil DJ** untuk mengambil alih kontrol!";
  } else if (dj) {
    hint = `-# DJ saat ini dipegang oleh <@${dj.userId}>. Kamu tidak bisa mengontrol musik.`;
  } else if (!currentReq) {
    hint =
      "-# Belum ada lagu yang diputar. Putar lagu terlebih dahulu untuk bisa mengambil DJ.";
  } else {
    hint = `-# Hanya <@${currentReq.id}> (peminta lagu saat ini) yang bisa mengambil alih DJ.`;
  }

  const settingsText =
    `### ⚙️ Pengaturan Bot\n` +
    `**24/7 di voice** — ${onOff(s.stay247)}\n` +
    `-# Bot tidak keluar sendiri saat sepi / antrian habis\n` +
    `**Auto-delete balasan bot** — ${onOff(s.autoDelete)}\n` +
    `-# Pesan berhasil/gagal dll dihapus setelah **${s.autoDeleteSec} detik**\n` +
    `**Hapus pesan perintah prefix** — ${onOff(s.deleteUserCmd)}\n` +
    `-# Bot butuh izin Manage Messages` +
    (isAdmin
      ? ""
      : `\n-# 🔒 Hanya yang punya izin **Manage Server** yang bisa mengubah pengaturan ini.`);

  const adminRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("st_247")
      .setLabel("24/7")
      .setStyle(s.stay247 ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isAdmin),
    new ButtonBuilder()
      .setCustomId("st_autodel")
      .setLabel("Auto-delete")
      .setStyle(s.autoDelete ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isAdmin),
    new ButtonBuilder()
      .setCustomId("st_delay")
      .setLabel(`Jeda ${s.autoDeleteSec}s`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!isAdmin || !s.autoDelete),
    new ButtonBuilder()
      .setCustomId("st_usercmd")
      .setLabel("Hapus perintah user")
      .setStyle(s.deleteUserCmd ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(!isAdmin || !s.autoDelete),
  );

  const djText =
    `🎧 **Status DJ**\n` +
    `> **DJ saat ini:** ${dj ? `<@${dj.userId}>${isDJ ? " (Kamu)" : ""}` : "Belum ada"}\n` +
    `> **Request lagu:** ${access(allowReq)}\n` +
    `> **Kontrol playback:** ${access(allowCtrl)}\n` +
    `> **Atur antrian:** ${access(allowQueue)}\n` +
    hint;

  let djRow = null;
  if (canClaim) {
    djRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("st_dj_claim")
        .setLabel("Ambil DJ")
        .setStyle(ButtonStyle.Secondary)
        .setEmoji("🎧"),
    );
  } else if (isDJ) {
    djRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("st_dj_open")
        .setLabel("DJ Settings")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🎧"),
    );
  }

  return packSettings(dj ? 0xeb459e : 0x5865f2, "⚙️ Pengaturan Bot", [
    { text: settingsText, row: adminRow },
    { text: djText, row: djRow },
  ]);
}

// Error di Settings: pesan V2 tidak bisa diedit jadi teks biasa,
// jadi untuk tombol st_* dikirim sebagai followUp ephemeral.
const denySettings = (interaction, msg) =>
  interaction.customId === "mp_settings"
    ? interaction
        .editReply({ content: `❌ ${msg}`, embeds: [], components: [] })
        .catch(() => {})
    : interaction
        .followUp({ content: `❌ ${msg}`, flags: MessageFlags.Ephemeral })
        .catch(() => {});

async function handleSettings(interaction) {
  const gid = interaction.guildId;
  if (!gid) return;
  const id = interaction.customId;

  if (id === "mp_settings") {
    await interaction
      .deferReply({ flags: MessageFlags.Ephemeral })
      .catch(() => {});
  } else {
    await interaction.deferUpdate().catch(() => {});
  }

  const voiceDenied = await ensureSameVoiceOrMove(interaction);
  if (voiceDenied) return denySettings(interaction, voiceDenied);

  const s = getSettings(gid);
  const queue = useQueue(gid);
  const dj = (queue && queue.metadata && queue.metadata.dj) || null;
  const isDJ = Boolean(dj && dj.userId === interaction.user.id);
  const show = (view) =>
    interaction.editReply(buildSettingsUI(interaction, view)).catch(() => {});

  if (id === "mp_settings") return show("general");

  // --- toggle khusus admin (Manage Server) ---
  const adminActions = {
    st_247: () => {
      updateSettings(gid, { stay247: !s.stay247 });
      const q = useQueue(gid);
      if (q) apply247(q);
    },
    st_autodel: () => updateSettings(gid, { autoDelete: !s.autoDelete }),
    st_usercmd: () => updateSettings(gid, { deleteUserCmd: !s.deleteUserCmd }),
    st_delay: () => {
      const i = DELAY_STEPS.indexOf(s.autoDeleteSec);
      updateSettings(gid, {
        autoDeleteSec: DELAY_STEPS[(i + 1) % DELAY_STEPS.length],
      });
    },
  };
  if (adminActions[id]) {
    adminActions[id]();
    return show("general");
  }

  // --- toggle akses DJ ---
  const djKeys = {
    st_dj_allowreq: "djAllowRequest",
    st_dj_allowctrl: "djAllowControl",
    st_dj_allowqueue: "djAllowQueue",
  };
  if (djKeys[id]) {
    if (!isDJ)
      return denySettings(
        interaction,
        "Cuma DJ yang bisa ubah pengaturan ini.",
      );
    updateSettings(gid, { [djKeys[id]]: !(s[djKeys[id]] ?? false) });
    return show("dj");
  }

  switch (id) {
    case "st_dj_open":
      return isDJ
        ? show("dj")
        : denySettings(interaction, "Cuma DJ yang bisa membuka DJ Settings.");

    case "st_dj_back":
      return show("general");

    case "st_dj_claim": {
      if (dj) return denySettings(interaction, `Sudah ada DJ: <@${dj.userId}>`);
      const req = queue && queue.currentTrack && queue.currentTrack.requestedBy;
      if (
        !req ||
        queue.currentTrack.fromAutoplay ||
        req.id !== interaction.user.id
      ) {
        return denySettings(
          interaction,
          req && !queue.currentTrack.fromAutoplay
            ? `Cuma <@${req.id}> (peminta lagu yang sedang diputar) yang bisa ambil DJ.`
            : "Belum ada lagu yang diputar — belum ada yang bisa ambil DJ.",
        );
      }
      if (!queue.metadata) queue.metadata = {};
      queue.metadata.dj = {
        userId: interaction.user.id,
        claimedAt: Date.now(),
      };
      return show("dj");
    }

    case "st_dj_release":
      if (!isDJ) return denySettings(interaction, "Cuma DJ yang bisa melepas.");
      if (queue && queue.metadata) queue.metadata.dj = null;
      return show("general");
  }
}

function scheduleAutoDelete(guildId, cmdName, deleteFn) {
  if (!guildId || cmdName === "queue") return;
  const s = getSettings(guildId);
  if (!s.autoDelete) return;
  setTimeout(
    () =>
      Promise.resolve()
        .then(deleteFn)
        .catch(() => {}),
    s.autoDeleteSec * 1000,
  );
}

// ---------- Pengecekan masuk voice ----------
function checkVoiceAccess(voiceChannel, guild) {
  const me = guild.members.me;
  const perms = me && voiceChannel.permissionsFor(me);
  if (!perms) return "Aku nggak bisa membaca izin voice channel itu.";

  const missing = [];
  if (!perms.has(PermissionFlagsBits.ViewChannel)) missing.push("View Channel");
  if (!perms.has(PermissionFlagsBits.Connect)) missing.push("Connect");
  if (!perms.has(PermissionFlagsBits.Speak)) missing.push("Speak");
  if (missing.length) {
    return `Aku nggak punya izin **${missing.join(", ")}** di ${voiceChannel}. Minta admin menambahkan role bot ke voice channel itu dengan izin tersebut.`;
  }

  const limit = voiceChannel.userLimit;
  if (
    limit &&
    voiceChannel.members.size >= limit &&
    !perms.has(PermissionFlagsBits.MoveMembers)
  ) {
    return `${voiceChannel} sudah penuh (batas user tercapai), jadi aku nggak bisa masuk.`;
  }
  return null;
}

async function ensureConnected(guildId) {
  for (let i = 0; i < 20; i++) {
    const q = useQueue(guildId);
    if (!q) return false;
    if (!("dispatcher" in q)) return true;
    if (q.dispatcher) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  const q = useQueue(guildId);
  if (q) q.delete();
  return false;
}

function dropDeadQueue(guildId) {
  const q = useQueue(guildId);
  if (q && "dispatcher" in q && !q.dispatcher) q.delete();
}

async function ensureSameVoiceOrMove(interaction, { movePanel = true } = {}) {
  const guild = interaction.guild;
  if (!guild) return null;

  const me = guild.members.me;
  if (!me) return "Aku belum siap, coba lagi sebentar lagi.";

  const readVoice = () => ({
    botVoice: (me.voice && me.voice.channel) || null,
    userVoice:
      (interaction.member &&
        interaction.member.voice &&
        interaction.member.voice.channel) ||
      null,
  });

  let { botVoice, userVoice } = readVoice();
  if (!botVoice) return null;

  if (userVoice && userVoice.id === botVoice.id) {
    await new Promise((r) => setTimeout(r, 250));
    ({ botVoice, userVoice } = readVoice());
    if (!botVoice) return null;
  }

  if (!userVoice) return "Masuk ke voice channel dulu ya!";
  if (userVoice.id === botVoice.id) return null;

  const humans = botVoice.members.filter(
    (m) => !m.user.bot && m.id !== interaction.user.id,
  ).size;

  console.log(
    `[VoiceCheck] bot="${botVoice.name}" user="${userVoice.name}" humans=${humans}`,
  );

  if (humans === 0) {
    try {
      await me.voice.setChannel(userVoice);
    } catch (err) {
      console.error("Gagal pindah voice:", err);
      return `Gagal pindah ke ${userVoice}. Minta admin beri izin **Connect** untuk bot di channel itu.`;
    }

    if (movePanel) {
      relocatePanelTo(guild.id, interaction.channel);
    } else {
      const q = useQueue(guild.id);
      if (
        q &&
        q.metadata &&
        interaction.channel &&
        typeof interaction.channel.send === "function"
      ) {
        q.metadata.channel = interaction.channel;
      }
    }
    return null;
  }

  return `Aku sedang dipakai di ${botVoice}.`;
}

const VOICE_FAIL_TEXT =
  "Gagal masuk ke voice channel. Cek izin **View Channel / Connect / Speak** untuk bot di channel itu, lalu coba lagi.";

async function handleButton(interaction) {
  if (!interaction.customId.startsWith("mp_")) return;

  try {
    const queue = useQueue(interaction.guild.id);
    if (!queue) {
      await interaction
        .reply({
          content: "Sesi musik sudah berakhir.",
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
      interaction.message.delete().catch(() => {});
      return;
    }

    // PENGECEKAN VOICE DIPINDAH KE PALING ATAS
    const voiceDenied = await ensureSameVoiceOrMove(interaction, {
      movePanel: false,
    });
    if (voiceDenied) {
      return interaction
        .reply({ content: voiceDenied, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    if (interaction.customId === "mp_queue") {
      if (queue.tracks.size === 0 && !queue.currentTrack)
        return interaction
          .reply({ content: "Antrian kosong.", flags: MessageFlags.Ephemeral })
          .catch(() => {});
      return interaction
        .reply({
          ...buildQueueUI(queue, 0),
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }

    await interaction.deferUpdate().catch(() => {});

    const gs = getSettings(interaction.guild.id);
    const djInfo = queue.metadata?.dj;
    const viewerIsDJ = Boolean(djInfo && djInfo.userId === interaction.user.id);
    if (djInfo && !viewerIsDJ && !(gs.djAllowControl ?? false)) {
      return interaction
        .followUp({
          content: `🎧 DJ mode aktif. Cuma <@${djInfo.userId}> yang bisa kontrol playback.`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }

    switch (interaction.customId) {
      case "mp_play":
        queue.node.resume();
        return interaction.editReply(buildPanelPayload(queue)).catch(() => {});

      case "mp_skip": {
        if (!queue.isPlaying()) {
          return interaction
            .followUp({
              content: "❌ Nggak ada lagu yang diputar.",
              flags: MessageFlags.Ephemeral,
            })
            .catch(() => {});
        }
        skipCurrent(queue);
        return;
      }

      case "mp_pause":
        queue.node.pause();
        return interaction.editReply(buildPanelPayload(queue)).catch(() => {});

      case "mp_stop":
        queue.metadata.autoplayStopped = true;
        queue.node.stop();
        queue.tracks.clear();
        clearPanel(queue);
        return;

      case "mp_autoplay":
        setAutoplay(queue, !(queue.metadata && queue.metadata.autoplay));
        return interaction.editReply(buildPanelPayload(queue)).catch(() => {});

      case "mp_loop": {
        const m = queue.repeatMode;
        const next =
          m === QueueRepeatMode.OFF
            ? QueueRepeatMode.TRACK
            : m === QueueRepeatMode.TRACK
              ? QueueRepeatMode.QUEUE
              : QueueRepeatMode.OFF;
        queue.setRepeatMode(next);
        return interaction.editReply(buildPanelPayload(queue)).catch(() => {});
      }
      default:
        return;
    }
  } catch (err) {
    console.error("Error tombol:", err);
  }
}

player.events.on("error", (queue, error) =>
  console.error("Error queue:", error),
);
player.events.on("playerError", (queue, error) => {
  console.error("Error player:", error);
  const md = queue && queue.metadata;
  if (md && md.autoplay && !md.autoplayStopped) {
    setTimeout(() => {
      fillAutoplay(queue).catch(() => {});
      autoplayEnsurePlaying(queue);
    }, 1500);
  }
});
player.events.on("connection", () => console.log("Terhubung ke voice channel"));

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  const guild = oldState.guild;
  if (!guild) return;
  const queue = useQueue(guild.id);
  const dj = queue && queue.metadata && queue.metadata.dj;
  if (!dj) return;
  if (oldState.id !== dj.userId) return;

  const me = guild.members.me;
  const botVoiceId = me && me.voice && me.voice.channelId;
  const newVoiceId = newState.channelId;

  const shouldRelease =
    !newVoiceId || (botVoiceId && newVoiceId !== botVoiceId);
  if (!shouldRelease) return;

  queue.metadata.dj = null;
  console.log(`[DJ] Auto-release: ${oldState.id} keluar dari voice bot`);

  const channel = queue.metadata.channel;
  if (channel && typeof channel.send === "function") {
    const gs = getSettings(guild.id);
    channel
      .send(
        `🎧 <@${dj.userId}> keluar dari voice bot. Slot DJ bebas — yang sudah pernah request lagu bisa ambil lewat ⚙️ Settings.`,
      )
      .then((m) => {
        if (gs.autoDelete) {
          setTimeout(() => m.delete().catch(() => {}), gs.autoDeleteSec * 1000);
        }
      })
      .catch(() => {});
  }
});

// Bot diseret/dipindah manual ke voice lain -> panel ikut pindah
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.id !== client.user.id) return;
  if (!newState.channelId || oldState.channelId === newState.channelId) return;

  const queue = useQueue(newState.guild.id);
  if (!queue || !queue.metadata) return;

  console.log(
    `[Voice] Bot dipindah: ${oldState.channel?.name} -> ${newState.channel?.name}`,
  );

  // Mode PANEL_CHANNEL=voice: panel ada di chat voice, jadi ikut ke chat voice baru.
  // Mode teks biasa: panel tetap di channel teks, tidak perlu pindah.
  if (process.env.PANEL_CHANNEL === "voice" && newState.channel) {
    relocatePanelTo(newState.guild.id, newState.channel);
  }
});

// ---------- Samakan nama role bot dengan nama bot ----------
const roleSyncWarned = new Set();

async function syncBotRoleName(guild, fresh = false) {
  try {
    let me = guild.members.me;
    if (!me) return;
    const botRole = me.roles.botRole; // role bawaan bot di server ini
    if (!botRole) return;

    // Perlu izin Manage Roles + punya role lain yang posisinya di atas role bot
    const canEdit =
      me.permissions.has("ManageRoles") &&
      me.roles.highest.comparePositionTo(botRole) > 0;
    if (!canEdit) {
      if (!roleSyncWarned.has(guild.id)) {
        roleSyncWarned.add(guild.id);
        console.log(
          `[RoleSync] ${guild.name}: role bot tidak bisa diubah (butuh Manage Roles + role tambahan di atas role bawaan bot).`,
        );
      }
      return;
    }

    if (fresh) me = await guild.members.fetchMe(); // ambil nama terbaru
    const role = me.roles.botRole || botRole;
    const want = String(me.displayName || client.user.username).slice(0, 100);
    if (!want || role.name === want) return;

    const old = role.name;
    await role.setName(want, "Samakan nama role dengan nama bot");
    console.log(`[RoleSync] ${guild.name}: role "${old}" → "${want}"`);
  } catch (err) {
    console.log("[RoleSync] Gagal:", err.message);
  }
}

async function syncAllBotRoles() {
  for (const guild of client.guilds.cache.values()) {
    await syncBotRoleName(guild, true);
    await sleep(500);
  }
}

// langsung sinkron saat nickname bot diganti (kalau event-nya sampai)
client.on(Events.GuildMemberUpdate, (oldM, newM) => {
  if (client.user && newM.id === client.user.id) syncBotRoleName(newM.guild);
});

client.once(Events.ClientReady, async () => {
  try {
    await player.extractors.loadMulti(DefaultExtractors);
  } catch (err) {
    console.error("Gagal memuat extractor bawaan:", err);
  }

  try {
    await player.extractors.register(DirectFileExtractor, {});
    console.log("✅ Extractor upload aktif");
  } catch (err) {
    console.error("⚠️ Extractor upload gagal didaftarkan:", err.message);
  }

  if (YoutubeExtractor) {
    try {
      await player.extractors.register(YoutubeExtractor, {});
      console.log("✅ Extractor YouTube aktif");
    } catch (err) {
      console.error("⚠️ Extractor YouTube gagal didaftarkan:", err.message);
    }
  } else {
    console.log("⚠️ Extractor YouTube tidak ditemukan");
  }

  console.log(`✅ Bot online sebagai ${client.user.tag}`);

  // ---------- Status "Listening to ..." di bawah nama bot ----------
  const applyPresence = () => {
    try {
      client.user.setPresence({
        activities: [
          {
            name: "@randarzky<3",
            type: ActivityType.Listening, // ← "Listening to <name>"
          },
        ],
        status: "online",
      });
    } catch (err) {
      console.log("[Presence] Gagal set status:", err.message);
    }
  };
  applyPresence();
  // Discord kadang reset presence setelah reconnect, refresh berkala
  setInterval(applyPresence, 10 * 60 * 1000);

  // cek nama role bot sekali saat start, lalu tiap 2 menit
  syncAllBotRoles();
  setInterval(syncAllBotRoles, 2 * 60 * 1000);
});

// ---------- Autocomplete /play ----------
function trackToChoice(t) {
  if (!t.url || t.url.length > 100) return null;
  const dur = t.duration && t.duration !== "0:00" ? t.duration : "LIVE";
  return {
    name: clip(`${t.title} — ${t.author || "?"} • ${dur}`, 100),
    value: t.url,
  };
}

function buildChoices(ranked) {
  const seen = new Set();
  const out = [];
  for (const x of ranked) {
    const c = trackToChoice(x.t);
    if (c && !seen.has(c.value)) {
      seen.add(c.value);
      out.push(c);
    }
    if (out.length >= 25) break;
  }
  return out;
}

const acCache = new Map();

async function buildAutocompleteChoices(typed) {
  if (spotifyEnabled()) {
    try {
      const ranked = rankSpotify(await searchSpotifyTracks(typed), typed);
      const choices = ranked.slice(0, 10).map((x) => ({
        name: clip(
          `${x.i.title} — ${x.i.artist} • ${fmtMs(x.i.durationMs)}`,
          100,
        ),
        value: `https://open.spotify.com/track/${x.i.id}`,
      }));
      if (choices.length) return choices;
    } catch (err) {
      spotifyWarn(err);
    }
  }
  const [{ list }, lyric] = await Promise.all([
    searchCandidates(typed, undefined, { fast: true }),
    lyricWords(typed).length >= 4
      ? withTimeout(searchLyrics(typed), 1800, "lirik timeout").catch(() => [])
      : Promise.resolve([]),
  ]);
  const base = buildChoices(pickBest(list.slice(0, 15), { query: typed }));
  if (!lyric.length) return base;

  const fromLyric = lyric.slice(0, 3).map((c) => ({
    name: clip(`🎤 ${c.title} — ${c.artist} (cocok lirik)`, 100),
    value: `${String(c.artist).split(",")[0].trim()} ${c.title}`.slice(0, 100),
  }));
  return [...fromLyric, ...base].slice(0, 25);
}

async function handleAutocomplete(interaction) {
  const none = () => interaction.respond([]).catch(() => {});
  const cmd = interaction.commandName;
  if (cmd !== "play" && cmd !== "yt") return none();

  const typed = interaction.options.getFocused().trim();
  if (isSpamForAutocomplete(typed) && !/^https?:\/\//i.test(typed))
    return none();
  if (typed.length < 2 || /^https?:\/\//i.test(typed)) return none();

  const key = `${cmd}|${typed.toLowerCase()}`;
  const cached = acCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return interaction.respond(cached.choices).catch(() => {});
  }

  // throttle pencarian BARU (hasil cache tetap instan): 1 per user / 700ms, maks 3 paralel
  const uid = interaction.user.id;
  if (Date.now() - (acLast.get(uid) || 0) < 700 || acBusy >= 3) return none();
  acLast.set(uid, Date.now());
  if (acLast.size > 500) acLast.delete(acLast.keys().next().value);
  acBusy++;
  setTimeout(() => acBusy--, 2500);

  const work = (
    cmd === "yt"
      ? ytSearchCandidates(typed).then((list) =>
          buildChoices(ytRank(list, typed)),
        )
      : buildAutocompleteChoices(typed)
  )
    .then((choices) => {
      acCache.set(key, { at: Date.now(), choices });
      if (acCache.size > 200) acCache.delete(acCache.keys().next().value);
      return choices;
    })
    .catch(() => []);

  const choices = await Promise.race([
    work,
    new Promise((resolve) => setTimeout(() => resolve([]), 2400)),
  ]);
  return interaction.respond(choices).catch(() => {});
}

// ---------- UI Manajemen Antrian (/queue) ----------
const pendingRemove = new Map();

function buildRemoveConfirm(picked, page, action = "remove") {
  const cleanAuthor = (a) =>
    a ? a.replace(/\s*-\s*Topic$/i, "").trim() : "Unknown Artist";
  const list = picked
    .map(
      (t, i) =>
        `**${i + 1}.** ${clip(t.title, 50)} — *${cleanAuthor(t.author)}*`,
    )
    .join("\n");

  // Bikin teks dinamis tergantung berapa lagu yang dipilih
  const isSingle = picked.length === 1;
  const title = isSingle ? "⚡ Pilih Aksi" : "🗑️ Hapus Lagu?";
  const desc = isSingle
    ? `${list}\n\nKamu bisa memutar lagu ini sekarang atau menghapusnya dari antrian.`
    : `${list}\n\n**${picked.length}** lagu akan dihapus dari antrian.\n-# (Fitur putar sekarang hanya tersedia jika memilih 1 lagu)`;

  const embed = new EmbedBuilder()
    .setColor(isSingle ? 0x5865f2 : 0xed4245) // Biru kalau 1 lagu, Merah kalau banyak
    .setTitle(title)
    .setDescription(desc);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q_rmyes_${page}_${action}`)
      .setLabel(isSingle ? "Hapus" : "Ya, Hapus Semua")
      .setStyle(ButtonStyle.Danger),
  );

  // HANYA munculkan tombol "Putar Sekarang" jika user milih TEPAT 1 lagu
  if (isSingle) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`q_playnow_${page}`)
        .setLabel("Putar Sekarang")
        .setStyle(ButtonStyle.Success),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`q_rmno_${page}`)
      .setLabel("Batal")
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

function buildQueueUI(queue, page = 0) {
  const pageSize = 10;
  const tracks = queue.tracks.toArray();
  const totalPages = Math.ceil(tracks.length / pageSize) || 1;
  page = Math.max(0, Math.min(page, totalPages - 1));

  const cleanAuthor = (author) =>
    author ? author.replace(/\s*-\s*Topic$/i, "").trim() : "Unknown Artist";

  const reqName = (t) =>
    t.fromAutoplay || !t.requestedBy || !t.requestedBy.id
      ? ""
      : `<@${t.requestedBy.id}>`;

  const embed = new EmbedBuilder()
    .setColor(queue.metadata?.panelData?.color ?? 0x5865f2)
    .setTitle("<:queuefill:1564131658150584431> Queue")
    .setFooter({
      text: `Halaman ${page + 1} dari ${totalPages} • Total: ${tracks.length} lagu`,
    });

  if (queue.currentTrack) {
    const coverUrl =
      queue.metadata?.panelData?.thumb || queue.currentTrack.thumbnail;
    if (coverUrl) {
      embed.setThumbnail(coverUrl);
    }
  }

  const currentTracks = tracks.slice(page * pageSize, (page + 1) * pageSize);
  let desc = "";

  if (queue.currentTrack) {
    const t = queue.currentTrack;
    const who = reqName(t);
    desc += `__**Sedang Diputar :**__\n> **${t.title}**\n> ${cleanAuthor(t.author)}${who ? ` • ${who}` : ""}\n\n`;
  }

  if (tracks.length > 0) {
    desc += `__**Next Song :**__\n`;
    currentTracks.forEach((t, i) => {
      const index = page * pageSize + i + 1;
      const dur = t.duration && t.duration !== "0:00" ? t.duration : "LIVE";
      const who = reqName(t);
      desc += `**${index}.** ${clip(t.title, 40)} — *${cleanAuthor(t.author)}* • \`${dur}\`${who ? ` • ${who}` : ""}\n`;
    });
  } else {
    desc += `*Tidak ada lagu di antrian.*`;
  }

  embed.setDescription(desc);

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`q_remove_select_${page}`)
    .setPlaceholder("Pilih lagu untuk dihapus atau diputar...")
    .setMinValues(1)
    .setMaxValues(Math.max(1, currentTracks.length));

  if (currentTracks.length > 0) {
    currentTracks.forEach((t, i) => {
      selectMenu.addOptions({
        label: clip(t.title, 50),
        description: clip(cleanAuthor(t.author), 50),
        value: String(page * pageSize + i),
      });
    });
  } else {
    selectMenu.addOptions({ label: "Antrian Kosong", value: "none" });
    selectMenu.setDisabled(true);
  }

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`q_prev_${page}`)
      .setEmoji("1564657867112325140")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`q_next_${page}`)
      .setEmoji("1564657950985822350")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === totalPages - 1),
    new ButtonBuilder()
      .setCustomId("q_shuffle")
      .setEmoji("1564658442084294737")
      .setLabel("Acak")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(tracks.length < 2),
    new ButtonBuilder()
      .setCustomId("q_clear")
      .setEmoji("1564658561840316496")
      .setLabel("Hapus Semua")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(tracks.length === 0),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(selectMenu), buttons],
  };
}

// ---------- Router interaksi ----------
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction);

  if (
    interaction.isButton() &&
    (interaction.customId === "mp_settings" ||
      interaction.customId.startsWith("st_"))
  ) {
    return handleSettings(interaction);
  }

  if (interaction.isButton() && interaction.customId.startsWith("mp_")) {
    return handleButton(interaction);
  }

  // --- CEK ANTRIAN (TOMBOL) ---
  if (interaction.isButton() && interaction.customId.startsWith("q_")) {
    const queue = useQueue(interaction.guildId);
    if (!queue) return interaction.update({ components: [] }).catch(() => {});

    // CEK VOICE UNTUK TOMBOL ANTRIAN
    const qVoiceDenied = await ensureSameVoiceOrMove(interaction, {
      movePanel: false,
    });
    if (qVoiceDenied) {
      return interaction
        .reply({ content: qVoiceDenied, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    const parts = interaction.customId.split("_");
    const action = parts[1];
    const page = parts[2] ? parseInt(parts[2], 10) : 0;

    // --- LOGIKA PUTAR LANGSUNG ---
    if (action === "playnow") {
      const p = pendingRemove.get(interaction.message.id);
      if (!p || !p.tracks || !p.tracks.length) {
        return interaction.update(buildQueueUI(queue, page)).catch(() => {});
      }

      const trackToPlay = p.tracks[0]; // Ambil lagu pertama yang dipilih

      // 1. Hapus lagu ini dari antrian (kalau masih ada)
      const existingIndex = queue.tracks
        .toArray()
        .findIndex((t) => t.id === trackToPlay.id);
      if (existingIndex !== -1) {
        queue.removeTrack(existingIndex);
      }

      // 2. Masukkan lagu ini ke urutan paling atas (index 0)
      queue.insertTrack(trackToPlay, 0);
      pendingRemove.delete(interaction.message.id);

      // 3. Skip lagu saat ini agar lagu yang baru masuk langsung muter
      ensureResumed(queue);
      if (queue.currentTrack) {
        queue.node.skip();
      } else {
        queue.node.play();
      }

      return interaction.update(buildQueueUI(queue, page)).catch(() => {});
    }

    // PENGECEKAN DJ: Hanya untuk aksi yang MENGUBAH antrian
    if (["shuffle", "clear", "rmyes", "playnow"].includes(action)) {
      const gs = getSettings(interaction.guildId);
      const djInfo = queue.metadata?.dj;
      const viewerIsDJ = Boolean(
        djInfo && djInfo.userId === interaction.user.id,
      );
      if (djInfo && !viewerIsDJ && !(gs.djAllowQueue ?? false)) {
        return interaction
          .reply({
            content: `🎧 DJ mode aktif. Cuma <@${djInfo.userId}> yang bisa mengatur antrian.`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
    // ----------------------------

    if (action === "prev")
      return interaction.update(buildQueueUI(queue, page - 1)).catch(() => {});
    if (action === "next")
      return interaction.update(buildQueueUI(queue, page + 1)).catch(() => {});
    if (action === "shuffle") {
      queue.tracks.shuffle();
      return interaction.update(buildQueueUI(queue, 0)).catch(() => {});
    }
    if (action === "clear") {
      queue.tracks.clear();
      return interaction.update(buildQueueUI(queue, 0)).catch(() => {});
    }

    if (action === "rmno") {
      pendingRemove.delete(interaction.message.id);
      return interaction.update(buildQueueUI(queue, page)).catch(() => {});
    }

    if (action === "rmyes") {
      const p = pendingRemove.get(interaction.message.id);
      pendingRemove.delete(interaction.message.id);
      if (!p) return interaction.update(buildQueueUI(queue, 0)).catch(() => {});

      for (const t of queue.tracks.toArray()) {
        if (p.ids.includes(t.id)) queue.removeTrack(t);
      }
      return interaction.update(buildQueueUI(queue, p.page)).catch(() => {});
    }
    return;
  }

  // --- CEK ANTRIAN (DROPDOWN HAPUS) ---
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId.startsWith("q_remove_select")
  ) {
    const queue = useQueue(interaction.guildId);
    if (!queue) return interaction.update({ components: [] }).catch(() => {});

    // CEK VOICE UNTUK DROPDOWN HAPUS
    const dVoiceDenied = await ensureSameVoiceOrMove(interaction, {
      movePanel: false,
    });
    if (dVoiceDenied) {
      return interaction
        .reply({ content: dVoiceDenied, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }

    // PENGECEKAN DJ UNTUK HAPUS LAGU
    const gs = getSettings(interaction.guildId);
    const djInfo = queue.metadata?.dj;
    const viewerIsDJ = Boolean(djInfo && djInfo.userId === interaction.user.id);
    if (djInfo && !viewerIsDJ && !(gs.djAllowQueue ?? false)) {
      return interaction
        .reply({
          content: `🎧 DJ mode aktif. Cuma <@${djInfo.userId}> yang bisa mengatur antrian.`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
    // ----------------------------

    const page = parseInt(interaction.customId.split("_")[3], 10) || 0;
    const all = queue.tracks.toArray();
    const picked = interaction.values
      .map((v) => all[parseInt(v, 10)])
      .filter(Boolean);

    if (!picked.length)
      return interaction.update(buildQueueUI(queue, page)).catch(() => {});

    cacheSet(
      pendingRemove,
      interaction.message.id,
      { ids: picked.map((t) => t.id), page, tracks: picked }, // Simpan track aslinya
      100,
    );
    return interaction.update(buildRemoveConfirm(picked, page)).catch(() => {});
  }

  await handleCommand(interaction);
  if (interaction.isChatInputCommand()) {
    scheduleAutoDelete(interaction.guildId, interaction.commandName, () =>
      interaction.deleteReply(),
    );
  }
  return;
});

// ---------- Embed helper ----------
function makeEmbed(type, text, imageUrl = null, colorOverride = null) {
  const config = {
    success: { color: 0x57f287, emoji: "<:checkfatfill:1564138607650938931>" },
    error: { color: 0xed4245, emoji: "❌" },
    warn: { color: 0xfee75c, emoji: "⚠️" },
    info: { color: 0x5865f2, emoji: "ℹ️" },
  };
  const { color, emoji } = config[type] || config.info;

  const embed = new EmbedBuilder()
    .setColor(colorOverride ?? color)
    .setDescription(`${emoji} ${text}`);

  if (imageUrl && /^https?:\/\//.test(imageUrl)) {
    embed.setThumbnail(imageUrl);
  }

  return embed;
}

// ---------- Command ----------
async function handleCommand(interaction) {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName !== "purge") {
    const voiceDenied = await ensureSameVoiceOrMove(interaction);
    if (voiceDenied) {
      const payload = {
        embeds: [makeEmbed("error", voiceDenied)],
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
      return;
    }
  }

  const reply = (content, ephemeral = false) => {
    let type = "info";
    if (content.startsWith("❌")) type = "error";
    else if (content.startsWith("✅")) type = "success";
    else if (
      content.startsWith("⏹️") ||
      content.startsWith("🗑️") ||
      content.startsWith("🧹")
    )
      type = "warn";

    const cleanText = content.replace(
      /^[✅❌⏸️▶️⏭️⏹️🗑️🧹🔊🔀⏩➡️🔂🔁♾️📜🎵]\s*/,
      "",
    );

    return interaction.reply({
      embeds: [makeEmbed(type, cleanText)],
      flags: ephemeral ? MessageFlags.Ephemeral : undefined,
    });
  };

  const name = interaction.commandName;
  // ANTI-SPAM: cooldown per user + batas antrian
  if (["play", "yt", "play-file"].includes(name)) {
    const uid = interaction.user.id;
    const left = (cmdCooldown.get(uid) || 0) + 4000 - Date.now();
    if (left > 0)
      return reply(
        `⏳ Pelan-pelan, tunggu ${Math.ceil(left / 1000)} detik lagi.`,
        true,
      );
    cmdCooldown.set(uid, Date.now());
    if (cmdCooldown.size > 500)
      cmdCooldown.delete(cmdCooldown.keys().next().value);

    const q0 = useQueue(interaction.guild.id);
    if (q0 && q0.tracks.size >= MAX_QUEUE)
      return reply(`❌ Antrian penuh (maks ${MAX_QUEUE} lagu).`, true);
  }

  // CEK DJ (COMMANDS)
  {
    const q = useQueue(interaction.guild.id);
    const djInfo = q && q.metadata && q.metadata.dj;
    const viewerIsDJ = Boolean(djInfo && djInfo.userId === interaction.user.id);
    if (djInfo && !viewerIsDJ) {
      const gs = getSettings(interaction.guild.id);
      const REQUEST_CMDS = ["play", "yt", "play-file"];
      const CONTROL_CMDS = [
        "skip",
        "stop",
        "pause",
        "resume",
        "volume",
        "seek",
        "previous",
        "loop",
        "nowplaying",
      ];
      const QUEUE_CMDS = ["clear", "remove", "shuffle"];

      const allowReq = gs.djAllowRequest ?? false;
      const allowCtrl = gs.djAllowControl ?? false;
      const allowQueue = gs.djAllowQueue ?? false;

      if (REQUEST_CMDS.includes(name) && !allowReq) {
        return reply(
          `🎧 DJ mode aktif. Cuma <@${djInfo.userId}> yang bisa menambah lagu.`,
          true,
        );
      }
      if (CONTROL_CMDS.includes(name) && !allowCtrl) {
        return reply(
          `🎧 DJ mode aktif. Cuma <@${djInfo.userId}> yang bisa kontrol playback.`,
          true,
        );
      }
      if (QUEUE_CMDS.includes(name) && !allowQueue) {
        return reply(
          `🎧 DJ mode aktif. Cuma <@${djInfo.userId}> yang bisa mengatur antrian.`,
          true,
        );
      }
    }
  }

  try {
    // ----- /play -----
    if (name === "play") {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel)
        return reply("❌ Masuk ke voice channel dulu ya!", true);
      const voiceDenied = checkVoiceAccess(voiceChannel, interaction.guild);
      if (voiceDenied) return reply(`❌ ${voiceDenied}`, true);

      await interaction.deferReply();
      let input = cleanQuery(interaction.options.getString("query").trim());
      const badQuery = validateSearchQuery(input);
      if (badQuery) {
        return interaction.editReply({ embeds: [makeEmbed("warn", badQuery)] });
      }
      if (isSoundCloudUrl(input)) input = await normalizeSoundCloudUrl(input);
      const requestedBy = interaction.user;

      try {
        const isUrl = /^https?:\/\//i.test(input);
        const isSpotify = /open\.spotify\.com/i.test(input);

        if (isSpotify && /\/(playlist|album)\//.test(input)) {
          const col = await getSpotifyCollection(input).catch((err) => {
            console.log("[Spotify] Gagal baca playlist/album:", err.message);
            return null;
          });
          if (!col || !col.tracks.length) {
            return interaction.editReply({
              embeds: [
                makeEmbed(
                  "error",
                  "Gagal membaca playlist/album Spotify. Pastikan linknya publik.",
                ),
              ],
            });
          }

          const items = col.tracks.slice(0, 30);
          let startIdx = 0;
          let first = null;
          while (startIdx < items.length && !first) {
            first = await matchSpotifyItem(
              items[startIdx],
              col.cover,
              requestedBy,
            );
            startIdx++;
          }
          if (!first) {
            return interaction.editReply({
              embeds: [
                makeEmbed(
                  "error",
                  "Tidak ada lagu dari Spotify yang bisa dicocokkan di YouTube.",
                ),
              ],
            });
          }

          const sRes = await player.search(first.url, {
            requestedBy,
            searchEngine: "youtube",
          });
          if (sRes && sRes.tracks[0]) sRes.tracks[0].requestedBy = requestedBy;

          const firstResult = await player.play(voiceChannel, sRes, {
            requestedBy,
            nodeOptions: playNodeOptions(interaction),
          });

          if (!(await ensureConnected(interaction.guild.id))) {
            return interaction.editReply({
              embeds: [makeEmbed("error", VOICE_FAIL_TEXT)],
            });
          }

          const guildId = interaction.guild.id;
          const rest = items.slice(startIdx);
          (async () => {
            const BATCH = 2;
            for (let i = 0; i < rest.length; i += BATCH) {
              if (!useQueue(guildId)) return;
              const found = await Promise.all(
                rest.slice(i, i + BATCH).map(async (item) => {
                  try {
                    const best = await matchSpotifyItem(
                      item,
                      col.cover,
                      requestedBy,
                    );
                    if (!best) return null;
                    const r = await player.search(best.url, { requestedBy });
                    if (r.tracks[0]) r.tracks[0].requestedBy = requestedBy;
                    return r.tracks[0] || null;
                  } catch (err) {
                    console.log(
                      "[Spotify] Lewati lagu:",
                      item.title,
                      "-",
                      err.message,
                    );
                    return null;
                  }
                }),
              );
              const q2 = useQueue(guildId);
              if (!q2) return;
              const ok = found.filter(Boolean);
              if (ok.length) q2.addTrack(ok);
              await sleep(1500);
            }
          })();

          return interaction.editReply({
            embeds: [
              makeEmbed(
                "success",
                `Playlist/album Spotify **${col.name}** (${items.length} lagu) ditambahkan.\n-# requested by <@${requestedBy.id}>\n_Lagu lainnya masuk antrian bertahap._`,
                col.cover,
              ),
            ],
          });
        }
        let target = input;
        let matchedFrom = null;
        let lyricNote = null;

        let info = null;
        if (isSpotify && /\/track\//.test(input)) {
          info = await resolveSpotifyTrack(input).catch((err) => {
            console.log("[Spotify] Gagal baca info lagu:", err.message);
            return null;
          });
        } else if (!isUrl && spotifyEnabled()) {
          info = await bestSpotifyForQuery(input).catch((err) => {
            spotifyWarn(err);
            return null;
          });
        } else if (isUrl && !isSpotify) {
          info = await resolveOtherLinkInfo(input);
        }

        if (info) {
          const best = await findBestTrack(
            {
              query:
                `${info.primaryArtist || info.artist} ${info.title}`.trim(),
              title: info.title,
              artist: info.primaryArtist || info.artist,
              durationMs: info.durationMs,
            },
            requestedBy,
          );
          if (best) {
            target = best.url;
            matchedFrom = `${info.title}${info.artist ? " — " + info.artist : ""}`;
            rememberSpotifyForVideo(best.url, info);
          }
        } else if (!isUrl) {
          const found = await findBestSmart(input, requestedBy);
          const best = found.best;
          if (found.lyric)
            lyricNote = `${found.lyric.title} — ${found.lyric.artist}`;
          if (best) {
            target = best.url;
            getCoverArt(
              best.title,
              (best.author || "Unknown Artist")
                .replace(/\s*-\s*Topic$/i, "")
                .trim(),
              best.durationMS,
            ).catch(() => {});
          }
        }

        // 1. Cari lagu dulu (ini yang biasanya mengambil dari cache)
        const searchResult = await player.search(target, {
          requestedBy,
          searchEngine: isSoundCloudUrl(target) ? QueryType.AUTO : "youtube",
        });

        if (searchResult && searchResult.tracks) {
          for (const t of searchResult.tracks) t.requestedBy = requestedBy;
        }

        // 3. Putar hasilnya (discord-player akan pakai objek yang sudah kita timpa)
        const result = await player.play(voiceChannel, searchResult, {
          requestedBy,
          nodeOptions: playNodeOptions(interaction),
        });

        if (!(await ensureConnected(interaction.guild.id))) {
          return interaction.editReply({
            embeds: [makeEmbed("error", VOICE_FAIL_TEXT)],
          });
        }

        if (!result || !result.track) {
          return interaction.editReply({
            embeds: [makeEmbed("error", "Lagu tidak ditemukan.")],
          });
        }

        const pl = result.searchResult && result.searchResult.playlist;
        let text;
        let coverUrl = null;

        if (pl) {
          text = `Playlist **${pl.title}** (${pl.tracks.length} lagu) ditambahkan.\n-# requested by <@${requestedBy.id}>`;
          coverUrl = pl.thumbnail || (pl.tracks[0] && pl.tracks[0].thumbnail);
          if (isSoundCloudUrl(input) && coverUrl)
            coverUrl = scBigCover(coverUrl) || coverUrl;
        } else {
          const authorName = result.track.author
            ? result.track.author.replace(/\s*-\s*Topic$/i, "").trim()
            : "Unknown Artist";

          const trackName = `${result.track.title} - ${authorName}`;
          const trackUrl = result.track.url;
          const trackLabel = /^https?:\/\//.test(trackUrl || "")
            ? `[${mdSafe(trackName)}](${trackUrl})`
            : trackName;
          text = `Berhasil ditambahkan:\n**${trackLabel}**\n-# requested by <@${requestedBy.id}>`;

          const isSC = isSoundCloudTrack(result.track);
          const spInfo = spotifyByVideo.get(ytIdOf(result.track.url));
          coverUrl = isSC
            ? scBigCover(result.track.thumbnail)
            : (spInfo && spInfo.cover) ||
              (await getCoverArt(
                result.track.title,
                authorName,
                result.track.durationMS,
              ));
          if (!coverUrl && result.track.thumbnail)
            coverUrl = result.track.thumbnail;

          if (matchedFrom) {
            text += `\n_Dicocokkan dari ${(info && info.sourceName) || "Spotify"}: ${matchedFrom}_`;
          }
          if (lyricNote) {
            text += `\n_Ditemukan lewat lirik: ${lyricNote}_`;
          }
        }

        return interaction.editReply({
          embeds: [
            makeEmbed(
              "success",
              text,
              coverUrl,
              coverUrl
                ? await getDominantColor(coverUrl).catch(() => null)
                : null,
            ),
          ],
        });
      } catch (err) {
        console.error("Gagal play:", err);
        dropDeadQueue(interaction.guild.id);
        return interaction.editReply({
          embeds: [
            makeEmbed(
              "error",
              "Gagal memutar lagu. Coba kirim link YouTube langsung.",
            ),
          ],
        });
      }
    }

    // ----- /yt -----
    if (name === "yt") {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel)
        return reply("❌ Masuk ke voice channel dulu ya!", true);
      const voiceDenied = checkVoiceAccess(voiceChannel, interaction.guild);
      if (voiceDenied) return reply(`❌ ${voiceDenied}`, true);

      await interaction.deferReply();
      const requestedBy = interaction.user;

      try {
        const input = ytCleanUrl(interaction.options.getString("query").trim());
        const badQuery = validateSearchQuery(input);
        if (badQuery) {
          return interaction.editReply({
            embeds: [makeEmbed("warn", badQuery)],
          });
        }
        let target = input;

        if (!/^https?:\/\//i.test(input)) {
          const list = await ytSearchCandidates(input);
          const ranked = ytRank(list, input);
          if (!ranked.length) {
            return interaction.editReply({
              embeds: [makeEmbed("error", "Video tidak ditemukan di YouTube.")],
            });
          }
          console.log(
            `[YT] "${input}" ->`,
            ranked
              .slice(0, 3)
              .map((x) => `${Math.round(x.s)} | ${x.t.title} (${x.t.author})`),
          );
          target = ranked[0].t.url;
        }

        const res = await player.search(target, {
          requestedBy,
          searchEngine: "youtube",
        });
        const track = res.tracks[0];
        if (!track) {
          return interaction.editReply({
            embeds: [makeEmbed("error", "Video tidak ditemukan.")],
          });
        }
        track.ytSource = true;
        track.requestedBy = requestedBy;

        await player.play(voiceChannel, track, {
          requestedBy,
          nodeOptions: playNodeOptions(interaction),
        });

        if (!(await ensureConnected(interaction.guild.id))) {
          return interaction.editReply({
            embeds: [makeEmbed("error", VOICE_FAIL_TEXT)],
          });
        }

        const label = `[${mdSafe(`${track.title} - ${track.author}`)}](${track.url})`;
        return interaction.editReply({
          embeds: [
            makeEmbed(
              "success",
              `Berhasil ditambahkan (YouTube):\n**${label}**\n-# requested by <@${requestedBy.id}>`,
              track.thumbnail,
            ),
          ],
        });
      } catch (err) {
        console.error("Gagal /yt:", err);
        dropDeadQueue(interaction.guild.id);
        return interaction.editReply({
          embeds: [
            makeEmbed(
              "error",
              "Gagal memutar dari YouTube. Coba kirim link-nya langsung.",
            ),
          ],
        });
      }
    }

    if (name === "play-file") {
      const voiceChannel = interaction.member.voice.channel;
      if (!voiceChannel)
        return reply("❌ Masuk ke voice channel dulu ya!", true);
      const voiceDenied = checkVoiceAccess(voiceChannel, interaction.guild);
      if (voiceDenied) return reply(`❌ ${voiceDenied}`, true);

      const att = interaction.options.getAttachment("file");
      if (att && att.size > 30 * 1024 * 1024)
        return reply("❌ File terlalu besar (maks 30 MB).", true);
      const ext = path.extname(att.name || "").toLowerCase();
      const isAudio =
        (att.contentType && att.contentType.startsWith("audio")) ||
        AUDIO_EXT.includes(ext);
      if (!isAudio) {
        return reply(
          "❌ File harus berupa audio (mp3, flac, wav, m4a, ogg, opus).",
          true,
        );
      }

      await interaction.deferReply();
      try {
        const sRes = await player.search(att.url, {
          requestedBy: interaction.user,
          searchEngine: `ext:${DirectFileExtractor.identifier}`,
        });
        if (sRes && sRes.tracks[0])
          sRes.tracks[0].requestedBy = interaction.user;

        const { track } = await player.play(voiceChannel, sRes, {
          requestedBy: interaction.user,
          nodeOptions: playNodeOptions(interaction),
        });

        // Simpan user yang request ke antrean
        if (useQueue(interaction.guild.id)) {
          useQueue(interaction.guild.id).metadata.lastRequester =
            interaction.user;
        }

        if (!(await ensureConnected(interaction.guild.id))) {
          return interaction.editReply({
            embeds: [makeEmbed("error", VOICE_FAIL_TEXT)],
          });
        }
        await interaction.editReply({
          embeds: [
            makeEmbed(
              "success",
              `Berhasil ditambahkan dari upload:\n**${att.name || track.title}**\n-# requested by <@${interaction.user.id}>`,
            ),
          ],
        });
      } catch (err) {
        console.error("Gagal upload/play:", err);
        dropDeadQueue(interaction.guild.id);
        await interaction.editReply({
          embeds: [
            makeEmbed(
              "error",
              "Gagal memutar file. Cek terminal untuk detail error.",
            ),
          ],
        });
      }
      return;
    }

    const queue = useQueue(interaction.guild.id);

    if (name === "skip") {
      if (!queue || !queue.isPlaying())
        return reply("❌ Nggak ada lagu yang diputar.");

      const wasTrackLoop = queue.repeatMode === QueueRepeatMode.TRACK;
      if (wasTrackLoop) queue.setRepeatMode(QueueRepeatMode.OFF);

      queue.node.skip();

      if (wasTrackLoop) {
        setTimeout(() => {
          if (queue && queue.isPlaying())
            queue.setRepeatMode(QueueRepeatMode.TRACK);
        }, 1000);
      }

      return reply("⏭️ Lagu dilewati.");
    }

    if (name === "stop") {
      if (!queue) return reply("❌ Bot lagi nggak muter apa-apa.");
      if (getSettings(interaction.guild.id).stay247) {
        if (queue.metadata) queue.metadata.autoplayStopped = true;
        queue.tracks.clear();
        queue.node.stop();
        clearPanel(queue);
        return reply("⏹️ Berhenti. Mode 24/7 aktif, bot tetap di voice.");
      }
      queue.delete();
      return reply("⏹️ Berhenti dan keluar dari voice.");
    }

    if (name === "queue") {
      if (!queue || (queue.tracks.size === 0 && !queue.currentTrack))
        return reply("❌ Antrian kosong.");
      return interaction.reply(buildQueueUI(queue, 0));
    }

    if (name === "pause") {
      if (!queue || !queue.isPlaying())
        return reply("❌ Nggak ada lagu yang diputar.");
      queue.node.pause();
      return reply("⏸️ Dijeda.");
    }

    if (name === "resume") {
      if (!queue) return reply("❌ Nggak ada lagu untuk dilanjutkan.");
      queue.node.resume();
      return reply("▶️ Dilanjutkan.");
    }

    if (name === "nowplaying") {
      if (!queue || !queue.currentTrack)
        return reply("❌ Nggak ada lagu yang diputar.");
      await sendPanel(queue, queue.currentTrack);
      return reply("✅ Panel Now Playing berhasil dimunculkan kembali.", true);
    }

    if (name === "shuffle") {
      if (!queue || queue.tracks.size < 2)
        return reply("❌ Antrian terlalu sedikit untuk diacak.");
      queue.tracks.shuffle();
      return reply("🔀 Antrian diacak.");
    }

    if (name === "volume") {
      if (!queue) return reply("❌ Bot lagi nggak muter apa-apa.");
      const level = interaction.options.getInteger("level");
      applyVolume(queue, level);
      return reply(`🔊 Volume diatur ke **${level}%**`);
    }

    if (name === "previous") {
      if (!queue || queue.history.isEmpty())
        return reply("❌ Belum ada lagu sebelumnya.");
      await queue.history.previous();
      return reply("⏮️ Kembali ke lagu sebelumnya.");
    }

    if (name === "seek") {
      if (!queue || !queue.currentTrack)
        return reply("❌ Nggak ada lagu yang diputar.");
      const raw = interaction.options.getString("waktu");
      const ms = parseTime(raw);
      if (ms === null)
        return reply("❌ Format waktu salah. Contoh: `1:30` atau `90`.", true);
      const ok = await queue.node.seek(ms);
      if (ok) {
        setWebProgressAnchor(interaction.guild.id, queue, ms);
      }
      return reply(
        ok
          ? `⏩ Lompat ke **${raw}**`
          : "❌ Gagal lompat. Sumber lagu ini mungkin nggak mendukung seek.",
      );
    }

    if (name === "remove") {
      const pos = interaction.options.getInteger("nomor");
      if (!queue || pos > queue.tracks.size)
        return reply("❌ Nomor itu nggak ada di antrian.", true);
      const removed = queue.removeTrack(pos - 1);
      return reply(`🗑️ Dihapus: **${removed ? removed.title : "lagu"}**`);
    }

    if (name === "clear") {
      if (!queue || queue.tracks.size === 0)
        return reply("❌ Antrian sudah kosong.");
      queue.tracks.clear();
      return reply(
        "🧹 Antrian dikosongkan. Lagu yang sedang diputar tetap jalan.",
      );
    }

    if (name === "purge") {
      await interaction.deferReply({ ephemeral: true });

      const limit = Math.min(
        100,
        Math.max(1, Number(interaction.options?.getInteger?.("jumlah")) || 50),
      );

      try {
        const messages = await interaction.channel.messages.fetch({ limit });
        const panelId = queue?.metadata?.panel?.id;

        const botMessages = messages.filter((m) => {
          if (m.author.id !== client.user.id) return false;
          if (panelId && m.id === panelId) return false;
          return true;
        });

        if (botMessages.size === 0) {
          return interaction.editReply({
            embeds: [
              makeEmbed("error", "Tidak ada pesan bot yang bisa dihapus"),
            ],
          });
        }

        try {
          await interaction.channel.bulkDelete(botMessages, true);
          return interaction.editReply({
            embeds: [
              makeEmbed(
                "success",
                `Berhasil menghapus **${botMessages.size}** message bot.`,
              ),
            ],
          });
        } catch (bulkError) {
          let deleted = 0;
          for (const msg of botMessages.values()) {
            try {
              await msg.delete();
              deleted++;
            } catch {}
          }
          return interaction.editReply({
            embeds: [
              makeEmbed(
                "success",
                `Berhasil menghapus **${deleted}** pesan bot (mode lambat).`,
              ),
            ],
          });
        }
      } catch (err) {
        console.error("Gagal purge:", err);
        return interaction.editReply({
          embeds: [
            makeEmbed(
              "error",
              "Gagal menghapus pesan. Cek izin bot (Manage Messages).",
            ),
          ],
        });
      }
    }

    if (name === "loop") {
      if (!queue) return reply("❌ Bot lagi nggak muter apa-apa.");
      const mode = interaction.options.getString("mode");
      const modes = {
        off: [QueueRepeatMode.OFF, "➡️ Loop dimatikan."],
        track: [QueueRepeatMode.TRACK, "🔂 Mengulang lagu ini."],
        queue: [QueueRepeatMode.QUEUE, "🔁 Mengulang seluruh antrian."],
      };
      queue.setRepeatMode(modes[mode][0]);
      return reply(modes[mode][1]);
    }
  } catch (err) {
    console.error("Error command:", err);
    if (interaction.deferred || interaction.replied) {
      interaction
        .editReply({
          embeds: [makeEmbed("error", "Terjadi kesalahan internal.")],
        })
        .catch(() => {});
    } else {
      reply("❌ Terjadi error.", true).catch(() => {});
    }
  }
}

// ---------- Perintah prefix ----------
const PREFIX = process.env.PREFIX || "!";

const ALIASES = {
  p: "play",
  pf: "play-file",
  s: "skip",
  fs: "skip",
  leave: "stop",
  dc: "stop",
  disconnect: "stop",
  q: "queue",
  np: "nowplaying",
  now: "nowplaying",
  vol: "volume",
  v: "volume",
  prev: "previous",
  back: "previous",
  l: "loop",
  repeat: "loop",
  sh: "shuffle",
  rm: "remove",
  pu: "pause",
  r: "resume",
  unpause: "resume",
  cl: "clear",
  j: "seek",
  purge: "purge",
  clean: "purge",
  bersihkan: "purge",
  yt: "yt",
  youtube: "yt",
};

const VALID_COMMANDS = [
  "play",
  "play-file",
  "skip",
  "stop",
  "queue",
  "pause",
  "resume",
  "nowplaying",
  "shuffle",
  "volume",
  "loop",
  "previous",
  "seek",
  "remove",
  "clear",
  "purge",
  "yt",
];

const HELP_TEXT = [
  "**Perintah** (awalan `" + PREFIX + "` atau slash `/`):",
  "`play <judul/link>` (p) · `play-file` + lampirkan file (pf)",
  "`skip` (s) · `previous` (prev) · `stop` (dc) · `pause` · `resume` (r)",
  "`queue` (q) · `nowplaying` (np) · `shuffle` · `clear` · `remove <no>`",
  "`volume <1-100>` (vol) · `loop <off|track|queue>` · `seek <1:30>`",
  "`purge [jumlah]` (clean) · hapus pesan bot di channel ini",
  "`yt <judul/link>` · cari langsung di YouTube (bukan YT Music)",
].join("\n");

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.member) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let cmd = (args.shift() || "").toLowerCase();
  cmd = ALIASES[cmd] || cmd;

  const gs = getSettings(message.guild.id);
  const origReply = message.reply.bind(message);
  message.reply = async (opts) => {
    const m = await origReply(opts);
    if (gs.autoDelete && cmd !== "queue")
      setTimeout(() => m.delete().catch(() => {}), gs.autoDeleteSec * 1000);
    return m;
  };

  const send = (text) =>
    message
      .reply({ content: text, allowedMentions: { repliedUser: false } })
      .catch(() => {});

  const sendEmbed = (type, text) => {
    message
      .reply({
        embeds: [makeEmbed(type, text)],
        allowedMentions: { repliedUser: false },
      })
      .catch(() => {});
  };

  if (cmd === "help" || cmd === "h") return sendEmbed("info", HELP_TEXT);
  if (!VALID_COMMANDS.includes(cmd)) return;
  if (gs.autoDelete && gs.deleteUserCmd)
    setTimeout(() => message.delete().catch(() => {}), gs.autoDeleteSec * 1000);

  const num = Number(args[0]);
  if (cmd === "play" && args.length === 0)
    return sendEmbed("warn", `Pakai: \`${PREFIX}play judul atau link\``);
  if (cmd === "play-file" && message.attachments.size === 0) {
    return sendEmbed(
      "warn",
      `Lampirkan file audio di pesan yang sama: \`${PREFIX}play-file\` + file.`,
    );
  }
  if (cmd === "volume" && !(Number.isInteger(num) && num >= 1 && num <= 100)) {
    return sendEmbed("warn", `Pakai: \`${PREFIX}volume 1-100\``);
  }
  if (cmd === "seek" && !args[0])
    return sendEmbed("warn", `Pakai: \`${PREFIX}seek 1:30\``);
  if (cmd === "remove" && !(Number.isInteger(num) && num >= 1)) {
    return sendEmbed(
      "warn",
      `Pakai: \`${PREFIX}remove nomor\` (lihat nomor di ${PREFIX}queue)`,
    );
  }
  if (
    cmd === "loop" &&
    !["off", "track", "queue"].includes((args[0] || "").toLowerCase())
  ) {
    return sendEmbed(
      "warn",
      `Pakai: \`${PREFIX}loop off\`, \`${PREFIX}loop track\`, atau \`${PREFIX}loop queue\``,
    );
  }

  const fake = {
    commandName: cmd,
    user: message.author,
    member: message.member,
    guild: message.guild,
    channel: message.channel,
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    options: {
      getString: (name) => {
        if (name === "query") return args.join(" ");
        if (name === "waktu") return args[0];
        if (name === "mode") return (args[0] || "").toLowerCase();
        return null;
      },
      getInteger: () => num,
      getAttachment: () => message.attachments.first(),
    },
    async reply(opts) {
      this.replied = true;
      if (typeof opts === "string") return send(opts);
      if (opts.embeds) {
        return message
          .reply({
            embeds: opts.embeds,
            allowedMentions: { repliedUser: false },
          })
          .catch(() => {});
      }
      return send(opts.content);
    },
    async deferReply() {
      this.deferred = true;
      await message.channel.sendTyping().catch(() => {});
    },
    async editReply(opts) {
      this.replied = true;
      if (typeof opts === "string") return send(opts);
      if (opts.embeds) {
        return message
          .reply({
            embeds: opts.embeds,
            allowedMentions: { repliedUser: false },
          })
          .catch(() => {});
      }
      return send(opts.content);
    },
  };

  handleCommand(fake);
});

// ---------- Pembersih cache berkala (bot jalan 24/7) ----------
setInterval(
  () => {
    const now = Date.now();
    const ttlCaches = [
      [searchCache, SEARCH_TTL],
      [ytCache, SEARCH_TTL],
      [acCache, 5 * 60 * 1000],
      [lyricCache, 10 * 60 * 1000],
    ];
    for (const [map, ttl] of ttlCaches)
      for (const [k, v] of map) if (now - v.at > ttl) map.delete(k);
    for (const [k, t] of cmdCooldown)
      if (now - t > 60000) cmdCooldown.delete(k);
    for (const [k, t] of acLast) if (now - t > 60000) acLast.delete(k);
  },
  5 * 60 * 1000,
).unref();

// ---------- Heartbeat autoplay: jaga rantai tetap hidup 24 jam ----------
setInterval(() => {
  try {
    for (const q of player.queues.cache.values()) {
      const md = q.metadata;
      if (!md || !md.autoplay || md.autoplayStopped) continue;
      if (q.tracks.size < 1) fillAutoplay(q).catch(() => {});
      else autoplayEnsurePlaying(q);
    }
  } catch {}
}, 45 * 1000).unref();

// ---------- Shutdown rapi (Ctrl+C / pm2 stop / systemctl stop) ----------
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    console.log(`\n👋 ${sig} diterima, menutup bot dengan rapi...`);
    try {
      for (const q of player.queues.cache.values()) {
        clearPanel(q);
        q.delete();
      }
    } catch {}
    setTimeout(() => process.exit(0), 3000).unref();
    setTimeout(() => {
      Promise.resolve(client.destroy()).finally(() => process.exit(0));
    }, 500);
  });
}

client.on("error", (err) => showError("Client error", err));
client.on("shardDisconnect", (event, id) =>
  console.error(
    `🔌 Terputus dari Discord (shard ${id}), kode: ${event && event.code}`,
  ),
);

// --- API UNTUK WEB DASHBOARD ---
const express = require("express");
const cors = require("cors");
const apiApp = express();
apiApp.use(cors());
apiApp.use(express.json());

const WEB_API_PORT = 3001;

// Cari server & voice channel berdasarkan User ID (App User)
function getUserVoiceContext(userId) {
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(userId);
    if (member && member.voice && member.voice.channel) {
      return { guild, voiceChannel: member.voice.channel };
    }
  }
  return null;
}

// Voice channel tempat bot sedang memutar (null kalau tidak ada antrian)
function botVoiceOf(queue, guild) {
  if (!queue) return null;
  return (
    queue.channel ||
    (guild.members.me && guild.members.me.voice.channel) ||
    null
  );
}

// Middleware: ambil konteks voice + queue (dipakai endpoint kontrol)
function withCtx(needQueue = true) {
  return (req, res, next) => {
    const ctx = getUserVoiceContext(req.body.userId || req.query.userId);
    if (!ctx)
      return res
        .status(400)
        .json({ error: "Kamu harus masuk ke Voice Channel dulu di Discord!" });
    req.ctx = ctx;
    req.queue = useQueue(ctx.guild.id);
    const botVc = botVoiceOf(req.queue, ctx.guild);
    if (botVc && botVc.id !== ctx.voiceChannel.id)
      return res.status(403).json({
        error: `Kamu beda voice dengan bot. Masuk ke 🔊 ${botVc.name} dulu supaya bisa mengontrol.`,
        voiceMismatch: { id: botVc.id, name: botVc.name },
      });
    if (needQueue && !req.queue)
      return res.status(404).json({ error: "Tidak ada antrian" });
    next();
  };
}

// ===== AKSES DJ UNTUK WEB DASHBOARD =====
// Aturan sama dengan command & tombol Discord: kalau ada DJ dan kamu bukan DJ,
// boleh atau tidaknya mengikuti toggle Request / Kontrol / Antrian dari DJ.
function djAccess(queue, guildId, userId) {
  const dj = (queue && queue.metadata && queue.metadata.dj) || null;
  if (!dj || dj.userId === userId) {
    return { locked: false, request: true, control: true, queue: true };
  }
  const gs = getSettings(guildId);
  return {
    locked: true,
    request: gs.djAllowRequest ?? false,
    control: gs.djAllowControl ?? false,
    queue: gs.djAllowQueue ?? false,
  };
}

const DJ_DENY_TEXT = {
  request: "menambah lagu",
  control: "kontrol playback",
  queue: "mengatur antrian",
};

// Pasang SETELAH withCtx(). kind: "request" | "control" | "queue"
const needDJ = (kind) => (req, res, next) => {
  const acc = djAccess(req.queue, req.ctx.guild.id, req.body.userId);
  if (!acc[kind]) {
    const m = req.ctx.guild.members.cache.get(req.queue.metadata.dj.userId);
    const name = m ? m.displayName : "DJ";
    return res.status(403).json({
      error: `🎧 DJ mode aktif. Cuma ${name} yang bisa ${DJ_DENY_TEXT[kind]}.`,
    });
  }
  next();
};

const webErr = (msg) => Object.assign(new Error(msg), { web: true });
const ytThumb = (url) => {
  const id = ytIdOf(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
};
const toResult = (t, source, extra = {}) => ({
  title: t.title,
  artist: cleanArtist(t.author),
  duration:
    t.duration && t.duration !== "0:00" ? t.duration : fmtMs(t.durationMS),
  thumbnail: t.thumbnail || ytThumb(t.url),
  url: t.url,
  source,
  ...extra,
});

// ===== PENCARIAN GABUNGAN (sama seperti autocomplete /play + /yt) =====
const webSearchCache = new Map();
// Skor gabungan untuk hasil YT Music + YouTube di dashboard.
// Prinsip: semua kata query harus ketemu (judul + artis) → itu yang paling menentukan.
function webScore(t, query, isMusic, idx) {
  const words = normU(query)
    .split(" ")
    .filter((w) => w.length > 1);
  if (!words.length) return -idx;
  const tt = normU(t.title);
  const hay = `${tt} ${normU(t.author)}`;
  const hit = words.filter((w) => hay.includes(w)).length / words.length;
  const inTitle = words.filter((w) => tt.includes(w)).length / words.length;

  let s = hit * 60;
  if (hit === 1)
    s += 40; // semua kata query ada
  else if (hit < 0.67) s -= 25; // banyak kata tidak nyambung
  s += inTitle * 15; // kata ada di judul lebih relevan daripada cuma di nama artis
  if (isMusic) s += 15; // YT Music "song" = versi studio
  if (/\btopic\b/.test(normU(t.author))) s += 10;

  // versi yang tidak diminta (remix, live, cover, dll)
  const q = norm(query);
  const tn = norm(t.title);
  for (let i = 0; i < BAD_RES.length; i++)
    if (BAD_RES[i].test(tn) && !BAD_RES[i].test(q)) s -= 15;

  const sec = (t.durationMS || 0) / 1000;
  if (sec > 0 && sec < 60) s -= 30;
  if (sec > 720) s -= 25;

  s -= idx * 0.8; // urutan asli dari mesin pencari ikut jadi sinyal
  return s;
}

// Skor gabungan hasil YT Music + YouTube di dashboard.
// Semua kata query harus ketemu (judul + artis) → itu yang paling menentukan.
function webScore(t, query, isMusic, idx) {
  const words = normU(query)
    .split(" ")
    .filter((w) => w.length > 1);
  if (!words.length) return -idx;
  const tt = normU(t.title);
  const hay = `${tt} ${normU(t.author)}`;
  const hit = words.filter((w) => hay.includes(w)).length / words.length;
  const inTitle = words.filter((w) => tt.includes(w)).length / words.length;

  let s = hit * 60;
  if (hit === 1)
    s += 40; // semua kata query ada
  else if (hit < 0.67) s -= 25; // banyak kata tidak nyambung
  s += inTitle * 15; // kata di judul lebih relevan daripada di nama artis
  if (isMusic) s += 15; // YT Music "song" = versi studio
  if (/\btopic\b/.test(normU(t.author))) s += 10;

  // versi yang tidak diminta (remix, live, cover, dll)
  const q = norm(query);
  const tn = norm(t.title);
  for (let i = 0; i < BAD_RES.length; i++)
    if (BAD_RES[i].test(tn) && !BAD_RES[i].test(q)) s -= 15;

  const sec = (t.durationMS || 0) / 1000;
  if (sec > 0 && sec < 60) s -= 30;
  if (sec > 720) s -= 25;

  s -= idx * 0.8; // urutan asli mesin pencari ikut jadi sinyal
  return s;
}

apiApp.get("/api/search", async (req, res) => {
  const q = cleanQuery(String(req.query.q || "").trim());
  const bad = validateSearchQuery(q);
  if (bad) return res.status(400).json({ error: bad });

  const key = q.toLowerCase();
  const hit = webSearchCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return res.json(hit.results);

  const [sp, mu, yt, ly] = await Promise.allSettled([
    spotifyEnabled()
      ? withTimeout(searchSpotifyTracks(q), 3500, "spotify timeout")
      : Promise.resolve([]),
    // YT Music (jalur /play) & YouTube asli (jalur /yt), masing-masing dibatasi waktu
    withTimeout(webMusicList(q), 11000, "musik timeout"),
    withTimeout(ytSearchCandidates(q, 40), 12000, "youtube timeout"),
    lyricWords(q).length >= 4
      ? withTimeout(searchLyrics(q), 2500, "lirik timeout")
      : Promise.resolve([]),
  ]);

  const out = [];
  const seen = new Set();
  const push = (r) => {
    const k = ytIdOf(r.url || "") || r.url || r.query;
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(r);
  };

  if (ly.status === "fulfilled")
    ly.value.slice(0, 3).forEach((c) => {
      const artist = String(c.artist).split(",")[0].trim();
      push({
        title: c.title,
        artist: c.artist,
        duration: "",
        thumbnail: null,
        url: null,
        query: `${artist} ${c.title}`.trim(),
        source: "lyric",
      });
    });

  if (sp.status === "fulfilled")
    rankSpotify(sp.value, q)
      .slice(0, 10)
      .forEach((x) =>
        push({
          title: x.i.title,
          artist: x.i.artist,
          duration: fmtMs(x.i.durationMs),
          thumbnail: x.i.cover,
          url: `https://open.spotify.com/track/${x.i.id}`,
          source: "spotify",
        }),
      );

  // gabungkan musik + YouTube lalu urutkan dengan satu skor yang sama
  const merged = [];
  if (mu.status === "fulfilled")
    mu.value.list.forEach((t, i) =>
      merged.push({ t, kind: "music", s: webScore(t, q, true, i) }),
    );
  if (yt.status === "fulfilled")
    yt.value.forEach((t, i) =>
      merged.push({ t, kind: "youtube", s: webScore(t, q, false, i) }),
    );
  merged.sort((a, b) => b.s - a.s);
  merged.slice(0, 60).forEach((x) => push(toResult(x.t, x.kind)));

  // dua sumber utama sama-sama gagal & tidak ada hasil -> kasih tahu (bukan "kosong")
  if (!out.length && mu.status === "rejected" && yt.status === "rejected")
    return res
      .status(502)
      .json({ error: "Pencarian gagal. Coba lagi sebentar." });

  if (out.length)
    cacheSet(webSearchCache, key, { at: Date.now(), results: out }, 100);
  res.json(out);
});

// ===== RESOLVER PLAY (sama seperti handler /play dan /yt) =====
// Link pendek Spotify (spotify.link / spotify.app.link) → link open.spotify.com
async function expandSpotifyShortLink(url) {
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": SP_UA },
      signal: AbortSignal.timeout(8000),
    });
    const re =
      /https?:\/\/open\.spotify\.com\/(?:[\w-]+\/)?(?:track|playlist|album)\/[A-Za-z0-9]+/i;
    if (re.test(r.url || "")) return r.url.match(re)[0];
    const html = await r.text();
    const m = html.match(re);
    return m ? m[0] : url;
  } catch {
    return url;
  }
}

async function resolveForWeb(raw, requestedBy, kind) {
  let input = cleanQuery(String(raw || "").trim());
  const bad = validateSearchQuery(input);
  if (bad) throw webErr(bad);
  const isUrl = /^https?:\/\//i.test(input);

  // --- jalur /yt ---
  if (kind === "youtube") {
    input = ytCleanUrl(input);
    let target = input;
    if (!isUrl) {
      const ranked = ytRank(await ytSearchCandidates(input), input);
      if (!ranked.length) throw webErr("Video tidak ditemukan di YouTube.");
      target = ranked[0].t.url;
    }
    const r = await player.search(target, {
      requestedBy,
      searchEngine: "youtube",
    });
    const track = r.tracks[0];
    if (!track) throw webErr("Video tidak ditemukan.");
    track.ytSource = true;
    track.requestedBy = requestedBy;
    return { toPlay: track, note: null };
  }

  // --- jalur /play ---
  if (isSoundCloudUrl(input)) input = await normalizeSoundCloudUrl(input);
  const isSpotify = /open\.spotify\.com/i.test(input);
  if (isSpotify && /\/(playlist|album)\//.test(input))
    throw webErr(
      "Playlist/album Spotify belum didukung dari web, pakai /play di Discord.",
    );

  let target = input;
  let note = null;
  let info = null;
  if (isSpotify) info = await resolveSpotifyTrack(input).catch(() => null);
  else if (!isUrl && spotifyEnabled())
    info = await bestSpotifyForQuery(input).catch(() => null);
  else if (isUrl) info = await resolveOtherLinkInfo(input);

  if (info) {
    const artist = info.primaryArtist || info.artist;
    const best = await findBestTrack(
      {
        query: `${artist} ${info.title}`.trim(),
        title: info.title,
        artist,
        durationMs: info.durationMs,
      },
      requestedBy,
    );
    if (best) {
      target = best.url;
      note = `Dicocokkan dari ${info.title}${info.artist ? " — " + info.artist : ""}`;
      rememberSpotifyForVideo(best.url, info);
    }
  } else if (!isUrl) {
    const found = await findBestSmart(input, requestedBy);
    if (found.best) target = found.best.url;
    if (found.lyric)
      note = `Ditemukan lewat lirik: ${found.lyric.title} — ${found.lyric.artist}`;
  }

  const sr = await player.search(target, {
    requestedBy,
    searchEngine: isSoundCloudUrl(target) ? QueryType.AUTO : "youtube",
  });
  if (!sr || !sr.tracks.length) throw webErr("Lagu tidak ditemukan.");
  for (const t of sr.tracks) t.requestedBy = requestedBy;
  return { toPlay: sr, note };
}

// ---------- Progress dashboard ----------
// Posisi lagu dihitung dari jam internal kita sendiri:
//   posisi = base + (waktu berjalan sejak `since`, hanya saat tidak di-pause)
// - mulai dari 0 saat lagu baru mulai (playerStart)
// - di-set ulang saat seek
// - dibekukan / dijalankan saat pause / resume
// Jam TIDAK bergantung pada playbackDuration maupun id track, karena keduanya
// bisa berubah/kembali ke 0 saat stream dibuat ulang.
// Debug: isi DEBUG_PROGRESS=1 di .env untuk melihat log-nya.
const webClock = new Map(); // guildId -> { key, trackId, base, since, running, auto }
const DEBUG_PROGRESS = process.env.DEBUG_PROGRESS === "1";
const dbgProg = (...a) => {
  if (DEBUG_PROGRESS) console.log("[Progress]", ...a);
};
const trackKey = (t) => `${t.url || t.title}|${Number(t.durationMS) || 0}`;
const clockPos = (c, at = Date.now()) =>
  c.base + (c.running ? at - c.since : 0);

// Posisi menurut discord-player (hanya dipakai kalau jam belum ada)
function nodeTimeMs(queue) {
  try {
    const ts = queue.node.getTimestamp && queue.node.getTimestamp();
    const v = ts && ts.current ? Number(ts.current.value) : NaN;
    if (Number.isFinite(v) && v >= 0) return v;
  } catch {}
  for (const k of [
    "estimatedPlaybackTime",
    "playbackTime",
    "playbackDuration",
  ]) {
    const v = Number(queue.node[k]);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

function setWebProgressAnchor(
  guildId,
  queue,
  position,
  track = queue.currentTrack,
  auto = false,
) {
  if (!track) {
    webClock.delete(guildId);
    return null;
  }
  const c = {
    key: trackKey(track),
    trackId: track.id,
    base: Math.max(0, Number(position) || 0),
    since: Date.now(),
    running: !queue.node.isPaused(),
    auto, // true = dibuat dari tebakan, boleh ditimpa playerStart
  };
  webClock.set(guildId, c);
  return c;
}

player.events.on("playerStart", (queue, track) => {
  startWebProgress(queue, track);
  try {
    queue.node.setBitrate(320);
  } catch {}

  // set volume awal kalau belum pernah diubah user
  if (!queue.metadata) queue.metadata = {};
  if (typeof queue.metadata.webVolume !== "number") {
    applyVolume(queue, 50);
  }

  sendPanel(queue, track);
  fillAutoplay(queue, track);
});

// Samakan jam dengan status pause yang sebenarnya
function syncWebClock(queue) {
  const c = webClock.get(queue.guild.id);
  if (!c) return;
  const paused = queue.node.isPaused();
  if (c.running === paused) {
    const now = Date.now();
    c.base = clockPos(c, now); // bekukan / lanjutkan dari posisi sekarang
    c.since = now;
    c.running = !paused;
  }
}

function startWebProgress(queue, track) {
  const gid = queue.guild.id;
  const c = webClock.get(gid);
  // playerStart untuk lagu yang SAMA di tengah lagu (mis. stream dibuat ulang
  // setelah seek) bukan lagu baru -> jangan reset ke 0.
  if (c && !c.auto && c.trackId === track.id && c.key === trackKey(track)) {
    const dur = Number(track.durationMS) || 0;
    if (!dur || clockPos(c) < dur - 5000) {
      dbgProg("playerStart ganda diabaikan:", track.title);
      return;
    }
  }
  setWebProgressAnchor(gid, queue, 0, track);
  dbgProg("lagu mulai dari 0:", track.title);
}

function realProgress(guildId, queue) {
  const cur = queue.currentTrack;
  if (!cur) {
    webClock.delete(guildId);
    return 0;
  }

  let c = webClock.get(guildId);
  if (!c || c.key !== trackKey(cur)) {
    c = setWebProgressAnchor(guildId, queue, nodeTimeMs(queue), cur, true);
    dbgProg("jam dibuat dari posisi player:", cur.title, Math.round(c.base));
  }
  syncWebClock(queue); // jaga-jaga kalau event pause/resume terlewat

  let pos = clockPos(c);
  const dur = Number(cur.durationMS) || 0;
  if (dur > 0 && pos >= dur) {
    if (queue.repeatMode === QueueRepeatMode.TRACK) {
      pos %= dur;
      c.base = pos;
      c.since = Date.now();
    } else {
      pos = dur;
    }
  }
  return Math.max(0, pos);
}

player.events.on("playerPause", (queue) => syncWebClock(queue));
player.events.on("playerResume", (queue) => syncWebClock(queue));

// Atur volume. Sumber kebenaran disimpan di queue.metadata.webVolume
// supaya tidak bergantung pada queue.node.volume (yang bisa reset ke 100
// oleh discord-player saat stream baru dibuat).
function applyVolume(queue, v) {
  if (!queue) {
    console.log("[Volume] queue undefined, skip.");
    return false;
  }

  v = Math.max(0, Math.min(100, Math.round(v)));
  if (!queue.metadata) queue.metadata = {};
  queue.metadata.webVolume = v;

  // 1. Coba lewat VolumeTransformer langsung (paling eksplisit)
  try {
    const volFilter = queue.filters && queue.filters.volume;
    if (volFilter && typeof volFilter.setVolume === "function") {
      volFilter.setVolume(v);
    }
  } catch (e) {
    console.log("[Volume] transformer gagal:", e.message);
  }

  // 2. Fallback ke node.setVolume
  try {
    queue.node.setVolume(v);
  } catch (e) {
    console.log("[Volume] node.setVolume gagal:", e.message);
  }

  // 3. Fallback terakhir: audioResource.volume
  try {
    const r =
      queue.dispatcher &&
      queue.dispatcher.audioResource &&
      queue.dispatcher.audioResource.volume;
    if (r && typeof r.setVolumeLogarithmic === "function")
      r.setVolumeLogarithmic(v / 100);
  } catch (_) {}

  console.log(
    `[Volume] diminta ${v}, node=${Math.round(queue.node.volume)}, saved=${v}`,
  );
  return true;
}
// Warna dominan cover untuk progress bar dashboard (di-cache; dihitung di latar
// belakang supaya /api/queue tidak menunggu). Null dulu sampai warnanya siap.
const coverColorCache = new Map(); // url -> "#rrggbb" | false (gagal)
function colorToHex(c) {
  const h2 = (v) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  if (typeof c === "number" && Number.isFinite(c))
    return "#" + (c & 0xffffff).toString(16).padStart(6, "0");
  if (typeof c === "string" && /^#?[0-9a-f]{6}$/i.test(c.trim()))
    return "#" + c.trim().replace("#", "");
  if (Array.isArray(c) && c.length >= 3)
    return "#" + c.slice(0, 3).map(h2).join("");
  if (c && typeof c === "object" && "r" in c)
    return "#" + [c.r, c.g, c.b].map(h2).join("");
  return null;
}
function coverColorOf(url) {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return null;
  if (coverColorCache.has(url)) return coverColorCache.get(url) || null;
  coverColorCache.set(url, false);
  if (coverColorCache.size > 100)
    coverColorCache.delete(coverColorCache.keys().next().value);
  Promise.resolve()
    .then(() => getDominantColor(url))
    .then((c) => {
      const hex = colorToHex(c);
      if (hex) coverColorCache.set(url, hex);
    })
    .catch(() => {});
  return null;
}

// Nama requester untuk dashboard: nickname server → display name → username.
// Di-refresh di belakang tiap ±5 dtk supaya ganti nickname langsung terlihat.
const reqNameCache = new Map(); // "guildId:userId" -> { name, at, busy }
function requesterName(guild, u) {
  if (!u) return null;
  const key = guild.id + ":" + u.id;
  let hit = reqNameCache.get(key);
  if (!hit) {
    hit = { name: null, at: 0, busy: false };
    reqNameCache.set(key, hit);
  }
  if (!hit.busy && Date.now() - hit.at > 5000) {
    hit.busy = true;
    guild.members
      .fetch({ user: u.id, force: true })
      .then((m) => {
        hit.name = m.displayName;
      })
      .catch(() => {})
      .finally(() => {
        hit.at = Date.now();
        hit.busy = false;
      });
  }
  const m = guild.members.cache.get(u.id);
  return (
    hit.name ||
    (m && m.displayName) ||
    u.webName ||
    u.globalName ||
    u.username ||
    null
  );
}

// 1. Antrian + status player
apiApp.get("/api/queue", (req, res) => {
  const ctx = getUserVoiceContext(req.query.userId);
  if (!ctx)
    return res.json({
      playing: null,
      queue: [],
      error: "User tidak di voice channel",
    });
  const queue = useQueue(ctx.guild.id);
  if (!queue) return res.json({ playing: null, queue: [] });

  const cur = queue.currentTrack;
  const apIds = queue.metadata && queue.metadata.autoplayIds;
  const webVol =
    queue.metadata && typeof queue.metadata.webVolume === "number"
      ? queue.metadata.webVolume
      : Math.round(queue.node.volume);
  res.json({
    autoplay: !!(queue.metadata && queue.metadata.autoplay),
    volume: webVol,
    playing: cur
      ? {
          id: cur.id,
          title: cur.title,
          author: cleanArtist(cur.author),
          thumbnail: cur.thumbnail,
          url: cur.url,
          durationMS: cur.durationMS || 0,
          progress: realProgress(ctx.guild.id, queue),
          isPaused: queue.node.isPaused(),
          color: coverColorOf(cur.thumbnail),
          requestedBy: cur.fromAutoplay
            ? null
            : requesterName(ctx.guild, cur.requestedBy),
          ytSource: !!cur.ytSource,
        }
      : null,
    loopMode: queue.repeatMode,
    voiceMismatch: (() => {
      const b = botVoiceOf(queue, ctx.guild);
      return b && b.id !== ctx.voiceChannel.id
        ? { id: b.id, name: b.name }
        : null;
    })(),
    queue: queue.tracks.toArray().map((t) => ({
      id: t.id,
      title: t.title,
      author: cleanArtist(t.author),
      thumbnail: t.thumbnail,
      duration: t.duration,
      url: t.url,
      auto: !!(t.fromAutoplay || (apIds && apIds.has(t.id))),
      requestedBy:
        t.fromAutoplay || (apIds && apIds.has(t.id))
          ? null
          : requesterName(ctx.guild, t.requestedBy),
      ytSource: !!t.ytSource,
    })),
  });
});

// 2. Play dari web (kind: "youtube" = jalur /yt, selain itu jalur /play)
apiApp.post(
  "/api/play",
  withCtx(false),
  needDJ("request"),
  async (req, res) => {
    let { query, kind, userId } = req.body;
    const { guild, voiceChannel } = req.ctx;
    if (
      /^https?:\/\/(spotify\.link|spotify\.app\.link)\//i.test(
        String(query || "").trim(),
      )
    )
      query = await expandSpotifyShortLink(String(query).trim());
    try {
      if (req.queue && req.queue.tracks.size >= MAX_QUEUE)
        return res
          .status(400)
          .json({ error: `Antrian penuh (maks ${MAX_QUEUE} lagu).` });

      const member = await guild.members.fetch(userId).catch(() => null);
      const requestedBy = {
        id: userId,
        username: "Web Dashboard",
        webName: (member && member.displayName) || req.body.username || null,
      };
      const fakeInteraction = {
        guild,
        channel: guild.systemChannel,
        member: { voice: { channel: voiceChannel } },
      };

      // ===== Playlist / album Spotify =====
      if (
        /open\.spotify\.com\/(?:[\w-]+\/)?(playlist|album)\//i.test(
          String(query || ""),
        )
      ) {
        const col = await getSpotifyCollection(String(query).trim()).catch(
          (err) => {
            console.log("[Spotify] Gagal baca playlist/album:", err.message);
            return null;
          },
        );
        if (!col || !col.tracks.length)
          return res.status(404).json({
            error:
              "Gagal membaca playlist/album Spotify. Pastikan linknya publik.",
          });

        const items = col.tracks.slice(0, 30);
        // cocokkan 3 lagu pertama sekaligus, pakai yang pertama berhasil (urutan tetap)
        const head = items.slice(0, 3);
        const headRes = await Promise.all(
          head.map((it) =>
            matchSpotifyItem(it, col.cover, requestedBy).catch(() => null),
          ),
        );
        let startIdx = headRes.findIndex(Boolean);
        let first = startIdx >= 0 ? headRes[startIdx] : null;
        if (first) {
          startIdx++;
        } else {
          startIdx = head.length;
          while (startIdx < items.length && !first) {
            first = await matchSpotifyItem(
              items[startIdx],
              col.cover,
              requestedBy,
            ).catch(() => null);
            startIdx++;
          }
        }
        if (!first)
          return res.status(404).json({
            error:
              "Tidak ada lagu dari Spotify yang bisa dicocokkan di YouTube.",
          });

        const sRes = await player.search(first.url, {
          requestedBy,
          searchEngine: "youtube",
        });
        if (!sRes || !sRes.tracks[0])
          return res.status(404).json({ error: "Lagu tidak ditemukan." });
        sRes.tracks[0].requestedBy = requestedBy;

        await player.play(voiceChannel, sRes, {
          requestedBy,
          nodeOptions: { ...playNodeOptions(fakeInteraction) },
        });

        // sisa lagu masuk bertahap di latar belakang
        const guildId = guild.id;
        const rest = items.slice(startIdx);
        (async () => {
          const BATCH = 5;
          for (let i = 0; i < rest.length; i += BATCH) {
            if (!useQueue(guildId)) return;
            const found = await Promise.all(
              rest.slice(i, i + BATCH).map(async (item) => {
                try {
                  const best = await matchSpotifyItem(
                    item,
                    col.cover,
                    requestedBy,
                  );
                  if (!best) return null;
                  const r = await player.search(best.url, { requestedBy });
                  if (r.tracks[0]) r.tracks[0].requestedBy = requestedBy;
                  return r.tracks[0] || null;
                } catch (err) {
                  console.log(
                    "[Spotify] Lewati lagu:",
                    item.title,
                    "-",
                    err.message,
                  );
                  return null;
                }
              }),
            );
            const q2 = useQueue(guildId);
            if (!q2) return;
            const ok = found.filter(Boolean);
            const room = MAX_QUEUE - q2.tracks.size;
            if (ok.length && room > 0) q2.addTrack(ok.slice(0, room));
            await sleep(250);
          }
        })();

        return res.json({
          success: true,
          title: `${col.name} (${items.length} lagu)`,
          note: "sisanya masuk antrian bertahap",
        });
      }

      const { toPlay, note } = await resolveForWeb(query, requestedBy, kind);
      const { track } = await player.play(voiceChannel, toPlay, {
        requestedBy,
        nodeOptions: {
          ...playNodeOptions(fakeInteraction),
        },
      });
      res.json({
        success: true,
        message: "Lagu ditambahkan!",
        title: track && track.title,
        note,
      });
    } catch (error) {
      if (error.web) return res.status(404).json({ error: error.message });
      console.error("[Web] Gagal play:", error);
      res
        .status(500)
        .json({ error: "Gagal memutar lagu. Coba link YouTube langsung." });
    }
  },
);

// 3. Skip
apiApp.post("/api/skip", withCtx(false), needDJ("control"), (req, res) => {
  if (req.queue) skipCurrent(req.queue);
  res.json({ success: true });
});

// 4. Kontrol (pause, resume, volume, loop, seek)
apiApp.post("/api/control", withCtx(), needDJ("control"), async (req, res) => {
  const { action, value } = req.body;
  const queue = req.queue;
  try {
    if (action === "pause") {
      queue.node.pause();
      syncWebClock(queue);
      refreshPanel(queue);
    } else if (action === "resume") {
      queue.node.resume();
      syncWebClock(queue);
      refreshPanel(queue);
    } else if (action === "volume") {
      const v = parseInt(value);
      if (Number.isNaN(v))
        return res.status(400).json({ error: "Volume tidak valid" });
      const target = Math.max(0, Math.min(100, v));
      const ok = applyVolume(queue, target);
      return res.json({
        success: true,
        ok,
        volume:
          queue.metadata && typeof queue.metadata.webVolume === "number"
            ? queue.metadata.webVolume
            : Math.round(queue.node.volume),
      });
    } else if (action === "autoplay") {
      const on =
        value === true || value === "true" || value === 1 || value === "1";
      setAutoplay(queue, on);
      refreshPanel(queue);
      return res.json({ success: true, autoplay: on });
    } else if (action === "loop") {
      queue.setRepeatMode(parseInt(value));
      refreshPanel(queue);
    } else if (action === "seek") {
      const dur = (queue.currentTrack && queue.currentTrack.durationMS) || 0;
      let ms = parseInt(value);
      if (Number.isNaN(ms))
        return res.status(400).json({ error: "Posisi tidak valid" });
      ms = Math.max(0, dur ? Math.min(ms, dur - 1000) : ms);
      const volBefore = Math.round(queue.node.volume);
      const okSeek = await queue.node.seek(ms);
      if (okSeek === false)
        return res
          .status(400)
          .json({ error: "Sumber lagu ini tidak mendukung seek." });
      setWebProgressAnchor(req.ctx.guild.id, queue, ms);
      await sleep(300);
      // seek membuat stream baru → pastikan volume tidak ikut reset
      if (Math.round(queue.node.volume) !== volBefore)
        applyVolume(
          queue,
          queue.metadata && typeof queue.metadata.webVolume === "number"
            ? queue.metadata.webVolume
            : volBefore,
        );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Atur antrian: pindah urutan / hapus / putar sekarang
// Client kirim index + id lagu; kalau antrian sudah berubah → 409 supaya UI sync ulang.
function pickQueueTrack(req, res) {
  const arr = req.queue.tracks.toArray();
  const i = Number(req.body.index ?? req.body.from);
  if (!Number.isInteger(i) || i < 0 || i >= arr.length) {
    res.status(400).json({ error: "Posisi lagu tidak valid" });
    return null;
  }
  if (req.body.id && arr[i].id !== req.body.id) {
    res.status(409).json({ error: "Antrian sudah berubah, memuat ulang…" });
    return null;
  }
  return { arr, i };
}

apiApp.post("/api/queue/move", withCtx(), needDJ("queue"), (req, res) => {
  const p = pickQueueTrack(req, res);
  if (!p) return;
  const to = Number(req.body.to);
  if (!Number.isInteger(to) || to < 0 || to >= p.arr.length)
    return res.status(400).json({ error: "Tujuan tidak valid" });
  const [t] = p.arr.splice(p.i, 1);
  p.arr.splice(to, 0, t);
  req.queue.tracks.clear();
  req.queue.tracks.add(p.arr);
  res.json({ success: true });
});

apiApp.post("/api/queue/remove", withCtx(), needDJ("queue"), (req, res) => {
  const p = pickQueueTrack(req, res);
  if (!p) return;
  req.queue.removeTrack(p.arr[p.i]);
  res.json({ success: true });
});

apiApp.post("/api/queue/jump", withCtx(), needDJ("control"), (req, res) => {
  const p = pickQueueTrack(req, res);
  if (!p) return;
  ensureResumed(req.queue);
  req.queue.node.jump(p.arr[p.i]);
  res.json({ success: true });
});

// ===== DJ UNTUK WEB DASHBOARD =====
function djPayload(ctx, queue, userId) {
  const dj = (queue && queue.metadata && queue.metadata.dj) || null;
  const cur = queue && queue.currentTrack;

  let djUser = null;
  if (dj) {
    const m = ctx.guild.members.cache.get(dj.userId);
    djUser = {
      userId: dj.userId,
      username: m ? m.user.username : dj.userId,
      displayName: m ? m.displayName : null,
      avatar: m ? m.displayAvatarURL({ extension: "png", size: 128 }) : null,
      claimedAt: dj.claimedAt,
    };
  }
  return {
    dj: djUser,
    isDJ: Boolean(dj && dj.userId === userId),
    // aturan sama dengan tombol "Ambil DJ" di Discord
    canClaim: Boolean(
      !dj &&
      cur &&
      !cur.fromAutoplay &&
      cur.requestedBy &&
      cur.requestedBy.id === userId,
    ),
    hasTrack: Boolean(cur),
    // hak akses viewer saat ini (dipakai dashboard untuk mengunci tombol)
    access: djAccess(queue, ctx.guild.id, userId),
  };
}

apiApp.get("/api/dj", (req, res) => {
  const userId = req.query.userId;
  const ctx = getUserVoiceContext(userId);
  if (!ctx)
    return res.json({
      dj: null,
      isDJ: false,
      canClaim: false,
      hasTrack: false,
      error: "User tidak di voice channel",
    });
  res.json(djPayload(ctx, useQueue(ctx.guild.id), userId));
});

apiApp.post("/api/dj/claim", withCtx(), (req, res) => {
  const { userId } = req.body;
  const p = djPayload(req.ctx, req.queue, userId);
  if (p.dj)
    return res
      .status(409)
      .json({ error: `Sudah ada DJ: ${p.dj.displayName || p.dj.username}` });
  if (!p.hasTrack)
    return res.status(400).json({ error: "Belum ada lagu yang diputar." });
  if (!p.canClaim)
    return res.status(403).json({
      error: "Cuma peminta lagu yang sedang diputar yang bisa ambil DJ.",
    });
  if (!req.queue.metadata) req.queue.metadata = {};
  req.queue.metadata.dj = { userId, claimedAt: Date.now() };
  res.json({ success: true, ...djPayload(req.ctx, req.queue, userId) });
});

apiApp.post("/api/dj/release", withCtx(), (req, res) => {
  const { userId } = req.body;
  const p = djPayload(req.ctx, req.queue, userId);
  if (!p.isDJ)
    return res.status(403).json({ error: "Cuma DJ yang bisa melepas." });
  req.queue.metadata.dj = null;
  res.json({ success: true, ...djPayload(req.ctx, req.queue, userId) });
});

apiApp.listen(WEB_API_PORT, () => {
  console.log(`🌐 API Web berjalan di http://localhost:${WEB_API_PORT}`);
});

client.login(process.env.TOKEN).catch((err) => {
  showError("Login gagal", err);
  if (/disallowed intents/i.test(err.message)) {
    console.error(
      '👉 Nyalakan "Message Content Intent" di Developer Portal (Bot > Privileged Gateway Intents), klik Save Changes.',
    );
    console.error(
      "👉 Atau sementara tambahkan PREFIX_ENABLED=false di .env untuk mematikan prefix.",
    );
  } else if (/token/i.test(err.message)) {
    console.error(
      "👉 Token di .env salah atau sudah di-reset. Salin token baru dari Bot > Reset Token.",
    );
  }
});
