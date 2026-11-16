require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Putar lagu (ketik judul, hasil pencarian muncul otomatis)")
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription("Judul atau link lagu")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("play-file")
    .setDescription("Upload file musik lalu langsung diputar")
    .addAttachmentOption((o) =>
      o
        .setName("file")
        .setDescription("File audio (mp3, flac, wav, m4a, ogg)")
        .setRequired(true),
    ),
  new SlashCommandBuilder().setName("skip").setDescription("Lewati lagu"),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop dan keluar dari voice"),
  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Lihat antrian lagu"),
  new SlashCommandBuilder()
    .setName("previous")
    .setDescription("Kembali ke lagu sebelumnya"),
  new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Lompat ke menit tertentu di lagu")
    .addStringOption((o) =>
      o
        .setName("waktu")
        .setDescription("Contoh: 1:30 atau 90 (detik)")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Hapus satu lagu dari antrian")
    .addIntegerOption((o) =>
      o
        .setName("nomor")
        .setDescription("Nomor lagu di /queue")
        .setMinValue(1)
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Kosongkan antrian (lagu yang jalan tetap)"),
  new SlashCommandBuilder().setName("pause").setDescription("Jeda lagu"),
  new SlashCommandBuilder().setName("resume").setDescription("Lanjutkan lagu"),
  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Lihat lagu yang sedang diputar"),
  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Acak urutan antrian"),
  new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Atur mode ulang")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Pilih mode")
        .setRequired(true)
        .addChoices(
          { name: "Mati", value: "off" },
          { name: "Ulang lagu ini", value: "track" },
          { name: "Ulang seluruh antrian", value: "queue" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("yt")
    .setDescription("Cari & putar langsung dari YouTube (bukan YouTube Music)")
    .addStringOption((o) =>
      o
        .setName("query")
        .setDescription("Judul atau link YouTube")
        .setRequired(true)
        .setAutocomplete(true),
    ),
  new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Hapus pesan bot di channel ini")
    .addIntegerOption((o) =>
      o
        .setName("jumlah")
        .setDescription("Berapa pesan terakhir yang dicek (1-100)")
        .setMinValue(1)
        .setMaxValue(100),
    ),
].map((c) => c.toJSON());

module.exports = { commands };

// =====================================================================
// SEMUA server (termasuk server testing) memakai command GLOBAL saja.
//
//   node deploy-commands.js          -> kirim command ke semua server + cek hasilnya
//   node deploy-commands.js status   -> cek command di Discord sudah sama dengan kode
//   node deploy-commands.js clean    -> SEKALI SAJA: hapus sisa command dobel lama
//                                       di semua server (lambat kalau servernya banyak)
//
// Server baru yang meng-invite bot otomatis dapat command ini,
// jadi TIDAK perlu kode guildCreate di index.js.
// =====================================================================
if (require.main === module) {
  const mode = (process.argv[2] || "deploy").toLowerCase();
  const { TOKEN, CLIENT_ID } = process.env;

  if (!TOKEN || !CLIENT_ID) {
    console.error("❌ TOKEN atau CLIENT_ID belum ada di .env");
    process.exit(1);
  }

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  // Bandingkan command di Discord dengan yang ada di kode ini
  async function verify() {
    const live = await rest.get(Routes.applicationCommands(CLIENT_ID));
    const want = new Set(commands.map((c) => c.name));
    const have = new Set(live.map((c) => c.name));
    const missing = [...want].filter((n) => !have.has(n));
    const extra = [...have].filter((n) => !want.has(n));
    if (!missing.length && !extra.length && live.length === commands.length) {
      console.log(
        `✅ OK: ${live.length} command di Discord = ${commands.length} di kode (tidak dobel, tidak kurang).`,
      );
    } else {
      if (missing.length)
        console.log("❌ Kurang di Discord:", missing.join(", "));
      if (extra.length)
        console.log("❌ Kelebihan di Discord:", extra.join(", "));
      console.log("👉 Jalankan: node deploy-commands.js");
    }
  }

  // Hapus command per-server di semua server tempat bot berada (global tidak ikut terhapus)
  async function clean() {
    // Discord hanya memberi maksimal 200 server per permintaan -> ambil bertahap
    const guilds = [];
    let after;
    for (;;) {
      const page = await rest.get(Routes.userGuilds(), {
        query: new URLSearchParams({
          limit: "200",
          ...(after ? { after } : {}),
        }),
      });
      guilds.push(...page);
      if (page.length < 200) break;
      after = page[page.length - 1].id;
    }
    console.log(
      `🧹 Membersihkan command per-server di ${guilds.length} server...`,
    );
    for (const g of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, g.id), {
          body: [],
        });
        console.log(`   ✅ ${g.name} (${g.id})`);
      } catch (err) {
        console.log(`   ⚠️ Gagal di ${g.name} (${g.id}): ${err.message}`);
      }
    }
    console.log("✅ Selesai. Sekarang jalankan: node deploy-commands.js");
  }

  (async () => {
    try {
      if (mode === "deploy") {
        console.log("⏳ Mengirim command ke semua server...");
        await rest.put(Routes.applicationCommands(CLIENT_ID), {
          body: commands,
        });
        await verify();
      } else if (mode === "status") {
        await verify();
      } else if (mode === "clean") {
        await clean();
      } else {
        console.log(
          [
            "Pakai salah satu:",
            "  node deploy-commands.js          (kirim command ke semua server)",
            "  node deploy-commands.js status   (cek sudah sama dengan kode)",
            "  node deploy-commands.js clean    (sekali saja, bersihkan sisa dobel lama)",
          ].join("\n"),
        );
      }
    } catch (error) {
      console.error("❌ Gagal:", error);
    }
  })();
}
