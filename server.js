const express = require("express");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const app  = express();
app.use(express.json());

// ============================================================
// KONFIGURASI
// ============================================================
const CONFIG = {
  TELEGRAM_BOT_TOKEN:           process.env.TELEGRAM_BOT_TOKEN,
  GEMINI_API_KEY:               process.env.GEMINI_API_KEY,
  SPREADSHEET_ID:               process.env.SPREADSHEET_ID,
  ALLOWED_USER_IDS:             (process.env.ALLOWED_USER_IDS || "").split(","),
  SHEET_NAME:                   "Transaksi",
  TIMEZONE:                     "Asia/Jakarta",
  GOOGLE_SERVICE_ACCOUNT_EMAIL: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY:           process.env.GOOGLE_PRIVATE_KEY,
};

// ============================================================
// ROUTES
// ============================================================
app.get("/", (req, res) => res.send("Bot Keuangan OK!"));

app.post("/webhook", async (req, res) => {
  // Langsung return 200 ke Telegram — cegah retry
  res.status(200).json({ ok: true });

  try {
    const body     = req.body;
    const updateId = body?.update_id;
    if (!updateId) return;

    if (body.callback_query) {
      await handleCallbackQuery(body.callback_query);
    } else if (body.message) {
      await handleUpdate(body);
    }
  } catch (err) {
    console.error("webhook error:", err);
  }
});

// ============================================================
// HANDLE UPDATE
// ============================================================
async function handleUpdate(update) {
  const msg    = update.message;
  const chatId = String(msg.chat.id);
  const userId = String(msg.from?.id);
  const text   = msg.text?.trim() || "";

  if (msg.from?.is_bot) return;
  if (!CONFIG.ALLOWED_USER_IDS.includes(userId)) {
    await sendMessage(chatId, "Akses ditolak. User ID kamu: " + userId);
    return;
  }
  if (!text) return;

  const cmd = text.toLowerCase().replace(/@\S+/g, "").trim();

  if      (cmd === "/start")                      await handleStart(chatId);
  else if (cmd === "/saldo")                      await handleSaldo(chatId);
  else if (cmd === "/hariini")                    await handleHariIni(chatId);
  else if (cmd === "/bulanini")                   await handleBulanIni(chatId);
  else if (cmd === "/laporan")                    await handleLaporan(chatId);
  else if (cmd === "/kategori")                   await handleKategori(chatId);
  else if (cmd === "/bantuan" || cmd === "/help") await handleBantuan(chatId);
  else if (cmd.startsWith("/"))                   await sendMessage(chatId, "Perintah tidak dikenal. Ketik /bantuan.");
  else                                            await handleTransaksi(chatId, text);
}

// ============================================================
// HANDLE CALLBACK QUERY
// ============================================================
async function handleCallbackQuery(cb) {
  const chatId    = String(cb.message.chat.id);
  const userId    = String(cb.from?.id);
  const messageId = cb.message.message_id;
  const data      = cb.data;

  await editMessageReplyMarkup(chatId, messageId);
  if (!CONFIG.ALLOWED_USER_IDS.includes(userId)) return;

  if (data.startsWith("koreksi_konfirm:")) {
    const parts       = data.split(":");
    const rowIndex    = parseInt(parts[1]);
    const nominalBaru = parseInt(parts[2]);
    await konfirmasiKoreksi(chatId, rowIndex, nominalBaru);
  } else if (data === "koreksi_batal") {
    await sendMessage(chatId, "OK, transaksi tidak diubah.");
  }

  await answerCallbackQuery(cb.id);
}

// ============================================================
// PERINTAH
// ============================================================
async function handleStart(chatId) {
  await sendMessage(chatId,
    "*Halo! Selamat datang di Bot Keuangan Pribadi* 💰\n\n"
    + "Cukup ketik transaksi secara natural:\n\n"
    + "• Makan bakso 35 ribu\n"
    + "• Isi bensin motor 100 ribu\n"
    + "• Gaji bulan ini 5 juta\n"
    + "• Kemarin beli obat 50 ribu\n\n"
    + "/saldo /hariini /bulanini /laporan /kategori /bantuan"
  );
}

async function handleBantuan(chatId) {
  await sendMessage(chatId,
    "*PANDUAN BOT KEUANGAN* 📖\n\n"
    + "*PENGELUARAN:*\n"
    + "• Makan bakso 35 ribu\n"
    + "• Bensin motor 100000\n"
    + "• Belanja minimarket 75rb\n\n"
    + "*PEMASUKAN:*\n"
    + "• Gaji bulan ini 5 juta\n"
    + "• Dapat bonus 500 ribu\n"
    + "• Hasil freelance 1.5 juta\n\n"
    + "*KOREKSI:*\n"
    + "• Tadi salah, bensinnya 80 ribu bukan 100 ribu\n\n"
    + "/saldo — Saldo saat ini\n"
    + "/hariini — Transaksi hari ini\n"
    + "/bulanini — Ringkasan bulan ini\n"
    + "/laporan — Laporan lengkap\n"
    + "/kategori — Breakdown per kategori"
  );
}

async function handleSaldo(chatId) {
  const saldo = await getSaldo();
  await sendMessage(chatId,
    (saldo >= 0 ? "💚" : "🔴") + " *SALDO SAAT INI*\n\n"
    + "Saldo: *" + formatRupiah(saldo) + "*\n\n"
    + "_" + formatTanggal(new Date()) + "_"
  );
}

async function handleHariIni(chatId) {
  const sheet    = await getSheet();
  const rows     = await sheet.getRows();
  const todayStr = getTodayStr();
  let totalMasuk = 0, totalKeluar = 0;
  const lines    = [];

  for (const r of rows) {
    if (!r.get("Tanggal") || r.get("Tanggal").substring(0, 10) !== todayStr) continue;
    const nominal = parseInt(r.get("Nominal")) || 0;
    if (r.get("Jenis") === "Pemasukan") {
      totalMasuk += nominal;
      lines.push("💚 +" + formatRupiah(nominal) + " " + r.get("Kategori") + ": " + r.get("Keterangan"));
    } else {
      totalKeluar += nominal;
      lines.push("❤️ -" + formatRupiah(nominal) + " " + r.get("Kategori") + ": " + r.get("Keterangan"));
    }
  }

  let msg = "*HARI INI* — _" + formatTanggalLengkap(new Date()) + "_\n\n";
  msg += lines.length ? lines.join("\n") + "\n\n" : "Belum ada transaksi.\n\n";
  msg += "---\n💚 Masuk: *" + formatRupiah(totalMasuk) + "*  ❤️ Keluar: *" + formatRupiah(totalKeluar) + "*\n💰 Saldo: *" + formatRupiah(await getSaldo()) + "*";
  await sendMessage(chatId, msg);
}

async function handleBulanIni(chatId) {
  const sheet    = await getSheet();
  const rows     = await sheet.getRows();
  const now      = new Date();
  const bln      = now.getMonth(), thn = now.getFullYear();
  let totalMasuk = 0, totalKeluar = 0;
  const katMasuk = {}, katKeluar = {};

  for (const r of rows) {
    if (!r.get("Tanggal")) continue;
    const tgl = new Date(r.get("Tanggal"));
    if (tgl.getMonth() !== bln || tgl.getFullYear() !== thn) continue;
    const nominal = parseInt(r.get("Nominal")) || 0;
    if (r.get("Jenis") === "Pemasukan") {
      totalMasuk += nominal;
      katMasuk[r.get("Kategori")] = (katMasuk[r.get("Kategori")] || 0) + nominal;
    } else {
      totalKeluar += nominal;
      katKeluar[r.get("Kategori")] = (katKeluar[r.get("Kategori")] || 0) + nominal;
    }
  }

  let msg = "*" + getBulanIndonesia(bln).toUpperCase() + " " + thn + "* 📊\n\n";
  if (Object.keys(katMasuk).length) {
    msg += "💚 *Pemasukan: " + formatRupiah(totalMasuk) + "*\n";
    Object.entries(katMasuk).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => msg += "  • " + k + ": " + formatRupiah(v) + "\n");
    msg += "\n";
  }
  if (Object.keys(katKeluar).length) {
    msg += "❤️ *Pengeluaran: " + formatRupiah(totalKeluar) + "*\n";
    Object.entries(katKeluar).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => msg += "  • " + k + ": " + formatRupiah(v) + "\n");
    msg += "\n";
  }
  if (!totalMasuk && !totalKeluar) msg += "Belum ada transaksi bulan ini.\n\n";
  msg += "---\n💰 Saldo: *" + formatRupiah(await getSaldo()) + "*";
  await sendMessage(chatId, msg);
}

async function handleLaporan(chatId) {
  const sheet  = await getSheet();
  const rows   = await sheet.getRows();
  const now    = new Date();
  const bln    = now.getMonth(), thn = now.getFullYear();
  let masukAll = 0, keluarAll = 0, masukBln = 0, keluarBln = 0;

  for (const r of rows) {
    if (!r.get("Tanggal")) continue;
    const tgl     = new Date(r.get("Tanggal"));
    const nominal = parseInt(r.get("Nominal")) || 0;
    const isBln   = tgl.getMonth() === bln && tgl.getFullYear() === thn;
    if (r.get("Jenis") === "Pemasukan") { masukAll += nominal; if (isBln) masukBln += nominal; }
    else { keluarAll += nominal; if (isBln) keluarBln += nominal; }
  }

  await sendMessage(chatId,
    "*LAPORAN LENGKAP* 📋\n\n"
    + "*" + getBulanIndonesia(bln) + " " + thn + ":*\n"
    + "  💚 Pemasukan: " + formatRupiah(masukBln) + "\n"
    + "  ❤️ Pengeluaran: " + formatRupiah(keluarBln) + "\n"
    + "  📈 Net: " + formatRupiah(masukBln - keluarBln) + "\n\n"
    + "*Semua Waktu:*\n"
    + "  💚 Total Pemasukan: " + formatRupiah(masukAll) + "\n"
    + "  ❤️ Total Pengeluaran: " + formatRupiah(keluarAll) + "\n"
    + "  🔢 Total Transaksi: " + rows.length + "\n\n"
    + "---\n💰 *Saldo: " + formatRupiah(await getSaldo()) + "*"
  );
}

async function handleKategori(chatId) {
  const sheet    = await getSheet();
  const rows     = await sheet.getRows();
  const now      = new Date();
  const bln      = now.getMonth(), thn = now.getFullYear();
  const katMasuk = {}, katKeluar = {};

  for (const r of rows) {
    if (!r.get("Tanggal")) continue;
    const tgl = new Date(r.get("Tanggal"));
    if (tgl.getMonth() !== bln || tgl.getFullYear() !== thn) continue;
    const nominal = parseInt(r.get("Nominal")) || 0;
    if (r.get("Jenis") === "Pemasukan") katMasuk[r.get("Kategori")] = (katMasuk[r.get("Kategori")] || 0) + nominal;
    else katKeluar[r.get("Kategori")] = (katKeluar[r.get("Kategori")] || 0) + nominal;
  }

  let msg = "*KATEGORI — " + getBulanIndonesia(bln).toUpperCase() + " " + thn + "*\n\n";
  if (Object.keys(katKeluar).length) {
    const tot = Object.values(katKeluar).reduce((a,b) => a+b, 0);
    msg += "❤️ *Pengeluaran (" + formatRupiah(tot) + "):*\n";
    Object.entries(katKeluar).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
      msg += "  • " + k + ": " + formatRupiah(v) + " (" + Math.round(v/tot*100) + "%)\n";
    });
    msg += "\n";
  }
  if (Object.keys(katMasuk).length) {
    const tot = Object.values(katMasuk).reduce((a,b) => a+b, 0);
    msg += "💚 *Pemasukan (" + formatRupiah(tot) + "):*\n";
    Object.entries(katMasuk).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
      msg += "  • " + k + ": " + formatRupiah(v) + " (" + Math.round(v/tot*100) + "%)\n";
    });
  }
  if (!Object.keys(katKeluar).length && !Object.keys(katMasuk).length) msg += "Belum ada transaksi bulan ini.";
  await sendMessage(chatId, msg);
}

// ============================================================
// TRANSAKSI NATURAL
// ============================================================
async function handleTransaksi(chatId, text) {
  try {
    if (isKoreksiRequest(text)) { await handleKoreksi(chatId, text); return; }
    const hasil = await parseTransaksiDenganGemini(text);
    if (!hasil || hasil.is_transaksi === false) {
      await sendMessage(chatId, "Tidak paham transaksimu 🤔\nContoh: _makan siang 25rb_ atau _gaji 5 juta_\n/bantuan untuk panduan.");
      return;
    }
    const saldoBaru = await simpanTransaksi(hasil);
    const tanda     = hasil.jenis === "Pemasukan" ? "+" : "-";
    await sendMessage(chatId,
      "✅ *" + hasil.jenis + " tercatat!*\n\n"
      + (hasil.jenis === "Pemasukan" ? "💚" : "❤️") + " " + hasil.kategori + "\n"
      + "📝 " + hasil.keterangan + "\n"
      + "📅 " + formatTanggalDisplay(hasil.tanggal) + "\n"
      + "💵 *" + tanda + formatRupiah(hasil.nominal) + "*\n"
      + "---\n💰 Saldo: *" + formatRupiah(saldoBaru) + "*"
    );
  } catch (err) {
    console.error("handleTransaksi error:", err);
    await sendMessage(chatId, "Gagal mencatat. Coba lagi.");
  }
}

// ============================================================
// KOREKSI
// ============================================================
function isKoreksiRequest(text) {
  const kw = ["salah","koreksi","ralat","ubah","ganti","bukan","harusnya","seharusnya","tadi salah"];
  return kw.some(k => text.toLowerCase().includes(k));
}

async function handleKoreksi(chatId, text) {
  try {
    const raw  = await callGeminiAPI(
      "Analisis koreksi transaksi berikut. Balas HANYA JSON tanpa markdown:\n"
      + "Teks: \"" + text + "\"\n"
      + "Format: {\"kata_kunci_transaksi\":string, \"nominal_baru\":number atau null}"
    );
    const info = JSON.parse(raw);
    const kk   = info.kata_kunci_transaksi?.toLowerCase();
    const nb   = info.nominal_baru || null;
    if (!kk) { await sendMessage(chatId, "Tidak paham transaksi mana. Coba lebih spesifik."); return; }

    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    let targetRow = null, targetIdx = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].get("Keterangan")?.toLowerCase().includes(kk) || rows[i].get("Kategori")?.toLowerCase().includes(kk)) {
        targetRow = rows[i]; targetIdx = i; break;
      }
    }
    if (!targetRow) { await sendMessage(chatId, 'Transaksi "' + kk + '" tidak ditemukan.'); return; }
    if (!nb) {
      await sendMessage(chatId,
        "Ketemu: *" + targetRow.get("Keterangan") + "* (" + formatRupiah(parseInt(targetRow.get("Nominal"))) + ")\nNominal yang benar berapa?"
      );
      return;
    }
    await sendMessageWithInlineKeyboard(chatId,
      "✏️ *Konfirmasi Koreksi*\n\n" + targetRow.get("Keterangan")
      + "\nLama: *" + formatRupiah(parseInt(targetRow.get("Nominal"))) + "*"
      + "\nBaru: *" + formatRupiah(nb) + "*\n\nUbah?",
      [[
        { text: "✅ Ya",    callback_data: "koreksi_konfirm:" + (targetIdx + 2) + ":" + nb },
        { text: "❌ Tidak", callback_data: "koreksi_batal" }
      ]]
    );
  } catch(err) {
    console.error("handleKoreksi:", err);
    await sendMessage(chatId, "Gagal proses koreksi.");
  }
}

async function konfirmasiKoreksi(chatId, rowIndex, nominalBaru) {
  try {
    const sheet = await getSheet();
    const rows  = await sheet.getRows();
    const row   = rows[rowIndex - 2];
    const lama  = parseInt(row.get("Nominal"));
    row.set("Nominal", nominalBaru);
    await row.save();
    await recalculateSaldo(rows, rowIndex - 2);
    await sendMessage(chatId,
      "✅ Diubah!\n" + formatRupiah(lama) + " → *" + formatRupiah(nominalBaru) + "*\n💰 Saldo: *" + formatRupiah(await getSaldo()) + "*"
    );
  } catch(err) { await sendMessage(chatId, "Gagal ubah: " + err.message); }
}

async function recalculateSaldo(rows, fromIdx) {
  let saldo = fromIdx > 0 ? (parseInt(rows[fromIdx - 1].get("Saldo")) || 0) : 0;
  for (let i = fromIdx; i < rows.length; i++) {
    const nominal = parseInt(rows[i].get("Nominal")) || 0;
    if (rows[i].get("Jenis") === "Pemasukan") saldo += nominal;
    else saldo -= nominal;
    rows[i].set("Saldo", saldo);
    await rows[i].save();
  }
}

// ============================================================
// GEMINI
// ============================================================
async function parseTransaksiDenganGemini(text) {
  try {
    const today   = getTodayStr();
    const kemarin = getRelativeDate(-1, today);
    const prompt  = "Kamu parser transaksi keuangan. Balas HANYA JSON tanpa markdown.\n\n"
      + "Teks: \"" + text + "\"\nHari ini: " + today + " | Kemarin: " + kemarin + "\n\n"
      + "Format: {\"jenis\":\"Pemasukan\" atau \"Pengeluaran\",\"kategori\":string,\"keterangan\":string,"
      + "\"nominal\":number,\"tanggal\":\"yyyy-MM-dd\",\"is_transaksi\":true atau false}\n\n"
      + "Kategori keluar: Makan & Minum, Transportasi, Belanja, Tagihan & Utilitas, Kesehatan, Pendidikan, Hiburan, Lainnya\n"
      + "Kategori masuk: Gaji, Bonus, Freelance, Investasi, Penjualan, Hadiah, Pemasukan Lainnya\n"
      + "Bukan transaksi: is_transaksi false";
    const raw = await callGeminiAPI(prompt);
    const p   = JSON.parse(raw);
    if (!p.nominal || p.nominal <= 0) return null;
    if (p.jenis !== "Pemasukan" && p.jenis !== "Pengeluaran") return null;
    if (!p.tanggal || p.tanggal === "hari ini") p.tanggal = today;
    return p;
  } catch(err) {
    console.error("Gemini fallback:", err);
    return parseRuleBased(text);
  }
}

async function callGeminiAPI(prompt) {
  const url  = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + CONFIG.GEMINI_API_KEY;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
    })
  });
  const json = await resp.json();
  if (json.error) throw new Error("Gemini: " + json.error.message);
  let raw = json.candidates[0].content.parts[0].text.trim();
  if (raw.startsWith("```")) raw = raw.substring(raw.indexOf("\n") + 1);
  if (raw.endsWith("```")) raw = raw.substring(0, raw.lastIndexOf("```"));
  return raw.trim();
}

// ============================================================
// FALLBACK RULE-BASED
// ============================================================
function parseRuleBased(text) {
  const lo  = text.toLowerCase().trim();
  const nom = extractNominal(lo);
  if (!nom || nom <= 0) return null;
  const desc  = removeNominal(lo);
  const jenis = tentukanJenis(desc);
  return {
    jenis, kategori: tentukanKategori(desc, jenis),
    keterangan: bersihkan(desc) || text, nominal: nom,
    tanggal: getTodayStr(), is_transaksi: true
  };
}

function extractNominal(t) {
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*(ribu|rbu|rb|juta|jt)\b/i);
  if (m) {
    const n = parseFloat(m[1].replace(",", "."));
    const s = m[2].toLowerCase();
    if (/ribu|rbu|rb/.test(s)) return Math.round(n * 1000);
    if (/juta|jt/.test(s)) return Math.round(n * 1000000);
  }
  const tt = t.match(/\b(\d{1,3}(?:\.\d{3})+)\b/);
  if (tt) { const n2 = parseInt(tt[1].replace(/\./g, "")); if (n2 >= 100) return n2; }
  const all = t.match(/\b\d{4,}\b/g);
  if (all) { const mx = Math.max(...all.map(Number)); if (mx >= 1000) return mx; }
  return null;
}

function removeNominal(t) {
  return t.replace(/\d+(?:[.,]\d+)?\s*(?:ribu|rbu|rb|juta|jt)\b/gi, "")
    .replace(/\b\d{1,3}(?:\.\d{3})+\b/g, "").replace(/\b\d{4,}\b/g, "")
    .replace(/\s+/g, " ").trim().replace(/^[-,.\s]+|[-,.\s]+$/g, "");
}

function tentukanJenis(d) {
  const masuk = ["gaji","salary","bonus","dapat","terima","dapet","penghasilan","pendapatan","untung","profit","dividen","freelance","komisi","hadiah","cashback","refund","balik","kembali","bayaran","honor","lembur","jual"];
  return masuk.some(k => d.includes(k)) ? "Pemasukan" : "Pengeluaran";
}

function tentukanKategori(d, j) {
  if (j === "Pemasukan") {
    if (/gaji|salary|honor/.test(d)) return "Gaji";
    if (/bonus/.test(d)) return "Bonus";
    if (/freelance|proyek/.test(d)) return "Freelance";
    if (/investasi|saham|dividen/.test(d)) return "Investasi";
    if (/jual/.test(d)) return "Penjualan";
    if (/hadiah/.test(d)) return "Hadiah";
    return "Pemasukan Lainnya";
  }
  if (/makan|minum|bakso|soto|nasi|mie|kopi|snack|jajan|warung|resto|cafe|gofood|grabfood/.test(d)) return "Makan & Minum";
  if (/bensin|bbm|pertamax|pertalite|ojek|grab|gojek|taksi|bus|kereta|parkir/.test(d)) return "Transportasi";
  if (/belanja|supermarket|minimarket|indomaret|alfamart|shopee|tokopedia|beli/.test(d)) return "Belanja";
  if (/listrik|pln|air|pdam|internet|wifi|pulsa|paket/.test(d)) return "Tagihan & Utilitas";
  if (/sewa|kos|kontrakan/.test(d)) return "Sewa & Tempat Tinggal";
  if (/obat|dokter|apotik|apotek|klinik/.test(d)) return "Kesehatan";
  if (/sekolah|kuliah|kursus|les|buku/.test(d)) return "Pendidikan";
  if (/nonton|bioskop|netflix|spotify|game/.test(d)) return "Hiburan";
  if (/baju|celana|sepatu|pakaian/.test(d)) return "Pakaian";
  return "Lainnya";
}

function bersihkan(d) {
  const kw = ["tadi","barusan","abis","habis","udah","sudah","baru","lagi","mau","untuk","buat"];
  let r = d;
  kw.forEach(k => { r = r.replace(new RegExp("^" + k + "\\s+", "i"), ""); });
  r = r.trim();
  return r.length > 0 ? r.charAt(0).toUpperCase() + r.slice(1) : d;
}

// ============================================================
// GOOGLE SHEETS
// ============================================================
let _sheet = null;

async function getSheet() {
  if (_sheet) return _sheet;
  const auth = new JWT({
    email:   CONFIG.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key:     CONFIG.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    scopes:  ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const doc = new GoogleSpreadsheet(CONFIG.SPREADSHEET_ID, auth);
  await doc.loadInfo();
  let sheet = doc.sheetsByTitle[CONFIG.SHEET_NAME];
  if (!sheet) {
    sheet = await doc.addSheet({
      title: CONFIG.SHEET_NAME,
      headerValues: ["Tanggal","Jenis","Kategori","Keterangan","Nominal","Saldo"]
    });
  }
  _sheet = sheet;
  return sheet;
}

async function getSaldo() {
  const sheet = await getSheet();
  const rows  = await sheet.getRows();
  if (rows.length === 0) return 0;
  return parseInt(rows[rows.length - 1].get("Saldo")) || 0;
}

async function simpanTransaksi(t) {
  const sheet     = await getSheet();
  const saldo     = await getSaldo();
  const saldoBaru = t.jenis === "Pemasukan" ? saldo + t.nominal : saldo - t.nominal;
  await sheet.addRow({
    Tanggal:    t.tanggal || getTodayStr(),
    Jenis:      t.jenis,
    Kategori:   t.kategori,
    Keterangan: t.keterangan,
    Nominal:    t.nominal,
    Saldo:      saldoBaru
  });
  return saldoBaru;
}

// ============================================================
// TELEGRAM HELPERS
// ============================================================
async function sendMessage(chatId, text) {
  await fetch("https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
  });
}

async function sendMessageWithInlineKeyboard(chatId, text, buttons) {
  await fetch("https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", reply_markup: { inline_keyboard: buttons } })
  });
}

async function editMessageReplyMarkup(chatId, messageId) {
  await fetch("https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/editMessageReplyMarkup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
  });
}

async function answerCallbackQuery(id) {
  await fetch("https://api.telegram.org/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id })
  });
}

// ============================================================
// FORMAT & UTILS
// ============================================================
function formatRupiah(n) {
  if (n === null || n === undefined) return "Rp0";
  const abs = Math.abs(n);
  const fmt = abs.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (n < 0 ? "-" : "") + "Rp" + fmt;
}

function getTodayStr() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: CONFIG.TIMEZONE });
}

function getRelativeDate(n, base) {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d.toISOString().substring(0, 10);
}

function formatTanggal(d) {
  const hr = ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"];
  const bl = ["Jan","Feb","Mar","Apr","Mei","Jun","Jul","Agu","Sep","Okt","Nov","Des"];
  return hr[d.getDay()] + ", " + d.getDate() + " " + bl[d.getMonth()] + " " + d.getFullYear()
    + " " + String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}

function formatTanggalLengkap(d) {
  const hr = ["Minggu","Senin","Selasa","Rabu","Kamis","Jumat","Sabtu"];
  return hr[d.getDay()] + ", " + d.getDate() + " " + getBulanIndonesia(d.getMonth()) + " " + d.getFullYear();
}

function formatTanggalDisplay(s) {
  if (!s) return "-";
  return formatTanggalLengkap(new Date(s + "T00:00:00"));
}

function getBulanIndonesia(i) {
  return ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"][i];
}

// ============================================================
// START SERVER
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bot berjalan di port " + PORT));
