// Session store sederhana berbasis file JSON (tanpa dependency tambahan).
// Dipakai supaya login Discord cukup sekali: sesi tetap ada walau server di-restart.
const fs = require("fs");
const session = require("express-session");

class FileStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.data = {}; // sid -> JSON string (sama seperti MemoryStore)
    this.dirty = false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, "utf8")) || {};
    } catch {
      /* file belum ada / rusak → mulai kosong */
    }
    this._prune();

    // touch (perpanjang masa berlaku) terjadi di setiap request → cukup ditulis berkala
    this.flushTimer = setInterval(() => this._flush(), 30 * 1000);
    this.flushTimer.unref();
    this.pruneTimer = setInterval(() => this._prune(), 60 * 60 * 1000);
    this.pruneTimer.unref();
    process.on("exit", () => this._flush());
  }

  _flush() {
    if (!this.dirty) return;
    try {
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      console.error("[Session] Gagal menyimpan sesi:", err.message);
    }
  }

  _expired(sess) {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return !!exp && new Date(exp).getTime() <= Date.now();
  }

  _prune() {
    for (const [sid, raw] of Object.entries(this.data)) {
      let s = null;
      try {
        s = JSON.parse(raw);
      } catch {}
      if (!s || this._expired(s)) {
        delete this.data[sid];
        this.dirty = true;
      }
    }
    this._flush();
  }

  get(sid, cb) {
    const raw = this.data[sid];
    if (!raw) return cb(null, null);
    let s;
    try {
      s = JSON.parse(raw);
    } catch {
      return cb(null, null);
    }
    if (this._expired(s)) {
      delete this.data[sid];
      this.dirty = true;
      return cb(null, null);
    }
    cb(null, s);
  }

  set(sid, sess, cb) {
    this.data[sid] = JSON.stringify(sess);
    this.dirty = true;
    this._flush(); // login / logout jarang terjadi → langsung simpan
    cb && cb(null);
  }

  touch(sid, sess, cb) {
    if (this.data[sid]) {
      this.data[sid] = JSON.stringify(sess);
      this.dirty = true;
    }
    cb && cb(null);
  }

  destroy(sid, cb) {
    delete this.data[sid];
    this.dirty = true;
    this._flush();
    cb && cb(null);
  }
}

module.exports = FileStore;
