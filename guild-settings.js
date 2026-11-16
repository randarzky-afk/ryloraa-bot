// Pengaturan per-server, disimpan di guild-settings.json (tetap ada setelah bot restart)
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "guild-settings.json");

const DEFAULTS = {
  stay247: false, // bot tetap di voice (tidak keluar sendiri)
  autoDelete: false, // hapus balasan bot (berhasil/gagal/dll) otomatis
  autoDeleteSec: 10, // jeda sebelum dihapus
  deleteUserCmd: false, // ikut hapus pesan perintah prefix milik user
};

const DELAY_STEPS = [5, 10, 30, 60];

let data = {};
try {
  data = JSON.parse(fs.readFileSync(FILE, "utf8")) || {};
} catch {
  data = {};
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(FILE, JSON.stringify(data, null, 2), (err) => {
      if (err) console.error("Gagal simpan guild-settings.json:", err.message);
    });
  }, 500);
}

function getSettings(guildId) {
  return { ...DEFAULTS, ...(data[guildId] || {}) };
}

function updateSettings(guildId, patch) {
  data[guildId] = { ...getSettings(guildId), ...patch };
  save();
  return data[guildId];
}

module.exports = { getSettings, updateSettings, DELAY_STEPS };
