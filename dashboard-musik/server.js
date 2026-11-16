require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
const express = require("express");
const session = require("express-session");
const path = require("path");
const crypto = require("crypto");
const FileStore = require("./session-store");
const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// ===== Selalu ambil versi terbaru saat halaman dibuka/di-refresh =====
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store"); // data API tidak pernah di-cache
  } else if (
    req.method === "GET" &&
    (req.path === "/" || req.path.endsWith(".html"))
  ) {
    res.set("Cache-Control", "no-cache, must-revalidate"); // selalu cek ke server dulu
  }
  next();
});

// Setup Session — login Discord cukup SEKALI:
// - cookie berlaku 1 tahun (dan diperpanjang tiap kali dashboard dipakai)
// - sesi disimpan di sessions.json, jadi tidak hilang saat server di-restart
if (!process.env.SESSION_SECRET)
  console.warn(
    "⚠️  SESSION_SECRET belum diisi di .env — isi dengan teks acak yang panjang.",
  );
const SESSION_COOKIE = "mr.sid";
app.use(
  session({
    name: SESSION_COOKIE,
    secret: process.env.SESSION_SECRET || "secret",
    store: new FileStore(path.join(__dirname, "sessions.json")),
    resave: false,
    saveUninitialized: false, // jangan buat sesi untuk pengunjung yang belum login
    rolling: true, // perpanjang masa berlaku setiap ada aktivitas
    cookie: {
      httpOnly: true,
      sameSite: "lax", // tetap terkirim saat kembali dari halaman Discord
      secure: false, // false karena pakai localhost (http)
      maxAge: 365 * 24 * 60 * 60 * 1000,
    },
  }),
);

const BOT_API_URL = "http://localhost:3001/api";

// --- RUTE OAUTH2 DISCORD ---

// 1. Arahkan user ke halaman login Discord
app.get("/auth/discord", (req, res) => {
  // state = pengaman CSRF; prompt=none = kalau sudah pernah authorize, layar "Authorize" dilewati
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const url = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&scope=identify&prompt=none&state=${state}`;
  req.session.save(() => res.redirect(url));
});

// 2. Callback setelah user klik "Authorize"
app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect("/?error=cancelled");
  if (!req.query.state || req.query.state !== req.session.oauthState)
    return res.redirect("/?error=auth_failed");
  delete req.session.oauthState;

  try {
    // Tukar code dengan access token
    const params = new URLSearchParams();
    params.append("client_id", process.env.DISCORD_CLIENT_ID);
    params.append("client_secret", process.env.DISCORD_CLIENT_SECRET);
    params.append("grant_type", "authorization_code");
    params.append("code", code);
    params.append("redirect_uri", process.env.DISCORD_REDIRECT_URI);

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      body: params,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const tokenData = await tokenRes.json();

    if (tokenData.error) throw new Error(tokenData.error_description);

    // Ambil data User (ID, Username, Avatar)
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // Simpan di Session
    req.session.userId = userData.id;
    req.session.username = userData.username;
    req.session.avatar = userData.avatar;

    // pastikan sesi sudah tersimpan sebelum pindah halaman
    req.session.save(() => res.redirect("/"));
  } catch (err) {
    console.error("OAuth Error:", err);
    res.redirect("/?error=auth_failed");
  }
});

// 3. Cek siapa yang sedang login
app.get("/api/me", async (req, res) => {
  if (req.session.userId) {
    const avatarUrl = req.session.avatar
      ? `https://cdn.discordapp.com/avatars/${req.session.userId}/${req.session.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    res.json({
      botAvatar: await getBotAvatar(),
      loggedIn: true,
      id: req.session.userId,
      username: req.session.username,
      avatar: avatarUrl,
    });
  } else {
    res.json({ loggedIn: false });
  }
});

// 4. Logout
app.get("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE);
    res.redirect("/");
  });
});

// --- RUTE API KE BOT ---

// Helper: wajib login + teruskan request ke bot (status & pesan error ikut diteruskan)
function needLogin(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: "Kamu belum login!" });
  next();
}

async function callBot(method, path, body) {
  const r = await fetch(`${BOT_API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const forward =
  (method, path, pick = () => ({})) =>
  async (req, res) => {
    try {
      const { status, data } = await callBot(
        method,
        typeof path === "function" ? path(req) : path,
        method === "GET"
          ? undefined
          : { userId: req.session.userId, ...pick(req) },
      );
      res.status(status).json(data);
    } catch (err) {
      res.status(502).json({ error: "Bot Discord offline." });
    }
  };

// ===== Avatar bot (untuk favicon dashboard) =====
let botAvatarCache = { url: "", at: 0 };
async function getBotAvatar() {
  if (botAvatarCache.url && Date.now() - botAvatarCache.at < 6 * 3600 * 1000)
    return botAvatarCache.url;
  try {
    const r = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` },
    });
    if (!r.ok) return botAvatarCache.url;
    const u = await r.json();
    const url = u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
      : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
    botAvatarCache = { url, at: Date.now() };
    return url;
  } catch {
    return botAvatarCache.url;
  }
}

// Pencarian gabungan (algoritma sama dengan /play + /yt di bot).
// Kalau bot offline → fallback ke youtube-sr supaya pencarian tetap jalan.

app.get("/api/search", needLogin, async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);

  // Pencarian utama dari bot
  try {
    const r = await fetch(`${BOT_API_URL}/search?q=${encodeURIComponent(q)}`, {
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => null);

    // Bot menjawab dengan daftar (kosong pun artinya memang tidak ada hasil)
    if (r.ok && Array.isArray(data)) return res.json(data);

    // Error validasi dari bot (query terlalu pendek, dll) tampilkan apa adanya
    if (r.status >= 400 && r.status < 500 && r.status !== 404) {
      return res
        .status(r.status)
        .json(data || { error: "Query pencarian tidak valid." });
    }

    console.warn("[Search] Bot error HTTP", r.status, "- coba fallback.");
  } catch (err) {
    console.warn("[Search] Bot gagal:", err.message);
  }

  // Fallback YouTube hanya jika bot offline / error
  try {
    const YouTube = require("youtube-sr").default || require("youtube-sr");
    const results = await YouTube.search(q, { limit: 40, type: "video" });

    return res.json(
      results.map((v) => ({
        title: v.title,
        artist: v.channel ? v.channel.name : "",
        duration: v.durationFormatted || "",
        thumbnail: v.thumbnail ? v.thumbnail.url : null,
        url: v.url,
        source: "youtube",
      })),
    );
  } catch (err) {
    console.error("[Search] Fallback gagal:", err.message);
    return res.status(502).json({
      error: "Pencarian gagal. Pastikan bot Discord menyala.",
    });
  }
});

app.post(
  "/api/queue",
  needLogin,
  forward("POST", "/play", (req) => ({
    query: req.body.url,
    kind: req.body.kind,
    username: req.session.username,
  })),
);
app.get(
  "/api/queue",
  needLogin,
  forward(
    "GET",
    (req) => `/queue?userId=${encodeURIComponent(req.session.userId)}`,
  ),
);
app.post(
  "/api/queue/move",
  needLogin,
  forward("POST", "/queue/move", (req) => ({
    from: req.body.from,
    to: req.body.to,
    id: req.body.id,
  })),
);
app.post(
  "/api/queue/remove",
  needLogin,
  forward("POST", "/queue/remove", (req) => ({
    index: req.body.index,
    id: req.body.id,
  })),
);
app.post(
  "/api/queue/jump",
  needLogin,
  forward("POST", "/queue/jump", (req) => ({
    index: req.body.index,
    id: req.body.id,
  })),
);
app.post("/api/skip", needLogin, forward("POST", "/skip"));
app.post(
  "/api/control",
  needLogin,
  forward("POST", "/control", (req) => ({
    action: req.body.action,
    value: req.body.value,
  })),
);

// ================= DJ =================
app.get("/api/dj", needLogin, async (req, res) => {
  try {
    const { status, data } = await callBot(
      "GET",
      `/dj?userId=${encodeURIComponent(req.session.userId)}`,
    );
    // bot lama (belum di-restart) belum punya endpoint ini
    if (status === 404 && !data.error) return res.json({ supported: false });
    res.status(status).json({ supported: true, ...data });
  } catch (err) {
    res.status(502).json({ error: "Bot Discord offline." });
  }
});
app.post("/api/dj/claim", needLogin, forward("POST", "/dj/claim"));
app.post("/api/dj/release", needLogin, forward("POST", "/dj/release"));

// Endpoint Proxy untuk melewati blokir CORS gambar dari luar
app.get("/api/proxy-image", needLogin, async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send("URL required");

  try {
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error("Failed to fetch image");

    // Teruskan header content-type (misal: image/webp, image/jpeg)
    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "image/jpeg",
    );
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache 1 hari agar ringan

    // Kirim data gambar
    const arrayBuffer = await response.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error("[Proxy Image Error]", err.message);
    res.status(500).send("Error fetching image");
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Web Dashboard berjalan di http://localhost:${PORT}`);
});
