/**
 * ============================================================================
 * BACKEND API SERVER - APLIKASI FINFLOW (CATATAN KEUANGAN PRIBADI)
 * ============================================================================
 * Modul yang didukung:
 * 1. Autentikasi Pengguna (Register & Login dengan Bcrypt Hashing)
 * 2. Kelola Catatan Keuangan (Tampil, Tambah, Edit, Hapus Transaksi)
 * 3. Kelola Preset / Input Cepat (Tampil, Tambah, Quick Input, Edit, Hapus)
 * 4. Informasi Keuangan & Grafik (Ringkasan Periode & Filter Tanggal)
 * 5. Target Keuangan & Limit Pengeluaran Harian (CRUD Target, Progres, Limit)
 * 6. Mengelola Profil & Logging Aktivitas Real-Time
 * ============================================================================
 */

const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;

// ============================================================================
// KONFIGURASI MIDDLEWARE & CORS
// ============================================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// ============================================================================
// KONEKSI DATABASE MYSQL
// ============================================================================
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Naufal356._',
  database: 'catatan_keuangan_db',
  dateStrings: true
});

db.connect((err) => {
  if (err) {
    console.error('[DATABASE] Gagal terhubung ke MySQL:', err.message);
  } else {
    console.log('[DATABASE] Terhubung ke MySQL Database (catatan_keuangan_db)!');
  }
});

// ============================================================================
// FUNGSI HELPER (UTILITY FUNCTIONS)
// ============================================================================

/**
 * Menghasilkan User ID unik berformat USR-XXXXXX
 */
function generateUserId() {
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `USR-${randomHex}`;
}

/**
 * Mencatat setiap aktivitas pengguna ke tabel activity_log secara sinkron
 */
function catatLogAktivitas(userId, modul, aksi, detail = '') {
  if (!userId) return;
  const sql = `INSERT INTO activity_log (user_id, modul, aksi, detail) VALUES (?, ?, ?, ?)`;
  db.query(sql, [userId, modul, aksi, detail], (err) => {
    if (err) {
      console.error('[LOGGING] Gagal mencatat aktivitas:', err.message);
    }
  });
}

/**
 * Menyinkronkan ulang total_pemasukan, total_pengeluaran, dan saldo milik user
 */
function sinkronkanSaldoUser(userId, callback) {
  const sqlRecalc = `
    UPDATE catatan_keuangan c
    SET 
      total_pemasukan = COALESCE((SELECT SUM(jumlah) FROM pemasukan WHERE catatan_id = c.catatan_id), 0),
      total_pengeluaran = COALESCE((SELECT SUM(jumlah) FROM pengeluaran WHERE catatan_id = c.catatan_id), 0),
      saldo = COALESCE((SELECT SUM(jumlah) FROM pemasukan WHERE catatan_id = c.catatan_id), 0) - 
              COALESCE((SELECT SUM(jumlah) FROM pengeluaran WHERE catatan_id = c.catatan_id), 0)
    WHERE c.user_id = ?
  `;
  db.query(sqlRecalc, [userId], callback);
}

// ============================================================================
// 1. ENDPOINT AUTENTIKASI (USE CASE 1: REGISTER & LOGIN)
// ============================================================================

// Registrasi Pengguna Baru
app.post('/api/register', async (req, res) => {
  const { nama_lengkap, username, password, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password wajib diisi!' });
  }

  try {
    const newUserId = generateUserId();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const defaultEmail = email && email.trim() !== ''
      ? email.trim()
      : `${username.toLowerCase().replace(/\s+/g, '')}@mail.com`;

    const sql = 'INSERT INTO user (user_id, nama_lengkap, username, email, password) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [newUserId, nama_lengkap || username, username, defaultEmail, hashedPassword], (err) => {
      if (err) {
        console.error('[REGISTER] Error:', err.message);
        return res.status(400).json({ success: false, message: 'Username sudah terdaftar atau gagal disimpan!' });
      }

      catatLogAktivitas(
        newUserId,
        'Autentikasi',
        'Registrasi Akun Baru',
        `Username: ${username} (${defaultEmail})`
      );

      res.json({ success: true, message: 'Registrasi berhasil!', user_id: newUserId });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal memproses enkripsi password.' });
  }
});

// Login Pengguna
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  const sql = 'SELECT * FROM user WHERE username = ? LIMIT 1';
  db.query(sql, [username], async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    if (results.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (isMatch) {
      delete user.password;

      catatLogAktivitas(
        user.user_id,
        'Autentikasi',
        'Login ke Aplikasi',
        `Pengguna "${user.username}" masuk ke sistem FinFlow`
      );

      res.json({ success: true, message: 'Login berhasil!', user: user });
    } else {
      res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }
  });
});

// ============================================================================
// 2. ENDPOINT CATATAN KEUANGAN (USE CASE 2: TAMPIL & TAMBAH TRANSAKSI)
// ============================================================================

// Ambil Seluruh Riwayat Transaksi User (Pemasukan & Pengeluaran)
app.get('/api/transaksi/:userId', (req, res) => {
  const { userId } = req.params;

  const sql = `
    SELECT p.pemasukan_id AS id, p.nama_catatan AS judul, 'Pemasukan' AS jenis, 
           p.kategori, p.jumlah AS nominal, DATE_FORMAT(p.date, '%Y-%m-%d') AS tanggal, 
           p.deskripsi, p.created_at 
    FROM pemasukan p
    JOIN catatan_keuangan c ON p.catatan_id = c.catatan_id
    WHERE c.user_id = ?
    UNION ALL
    SELECT g.pengeluaran_id AS id, g.nama_catatan AS judul, 'Pengeluaran' AS jenis, 
           g.kategori, g.jumlah AS nominal, DATE_FORMAT(g.date, '%Y-%m-%d') AS tanggal, 
           g.deskripsi, g.created_at 
    FROM pengeluaran g
    JOIN catatan_keuangan c ON g.catatan_id = c.catatan_id
    WHERE c.user_id = ?
    ORDER BY tanggal DESC, created_at DESC, id DESC
  `;

  db.query(sql, [userId, userId], (err, results) => {
    if (err) {
      console.error('[TRANSAKSI] Error ambil data:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, data: results });
  });
});

// Tambah Transaksi Baru (Pemasukan / Pengeluaran)
app.post('/api/transaksi', (req, res) => {
  const { user_id, jenis, nama_catatan, nominal, kategori, tanggal, deskripsi } = req.body;
  const nominalNum = parseFloat(nominal) || 0;

  db.query('SELECT catatan_id FROM catatan_keuangan WHERE user_id = ?', [user_id], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    const prosesInsertTransaksi = (catatanId) => {
      if (jenis === 'Pemasukan') {
        const sqlInsert = 'INSERT INTO pemasukan (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
        db.query(sqlInsert, [catatanId, nominalNum, kategori || 'Pemasukan', tanggal, deskripsi || '', nama_catatan], (errIns, result) => {
          if (errIns) return res.status(500).json({ success: false, message: errIns.message });

          db.query('UPDATE catatan_keuangan SET total_pemasukan = total_pemasukan + ?, saldo = saldo + ? WHERE catatan_id = ?', [nominalNum, nominalNum, catatanId]);

          catatLogAktivitas(
            user_id,
            'Catatan Keuangan',
            'Tambah Transaksi Pemasukan',
            `${nama_catatan} • Rp ${nominalNum.toLocaleString('id-ID')} (${kategori || 'Pemasukan'})`
          );

          res.json({ success: true, message: 'Pemasukan berhasil disimpan!', id: result.insertId });
        });
      } else {
        const sqlInsert = 'INSERT INTO pengeluaran (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
        db.query(sqlInsert, [catatanId, nominalNum, kategori || 'Lainnya', tanggal, deskripsi || '', nama_catatan], (errIns, result) => {
          if (errIns) return res.status(500).json({ success: false, message: errIns.message });

          db.query('UPDATE catatan_keuangan SET total_pengeluaran = total_pengeluaran + ?, saldo = saldo - ? WHERE catatan_id = ?', [nominalNum, nominalNum, catatanId]);

          catatLogAktivitas(
            user_id,
            'Catatan Keuangan',
            'Tambah Transaksi Pengeluaran',
            `${nama_catatan} • Rp ${nominalNum.toLocaleString('id-ID')} (${kategori || 'Lainnya'})`
          );

          res.json({ success: true, message: 'Pengeluaran berhasil disimpan!', id: result.insertId });
        });
      }
    };

    if (rows.length > 0) {
      prosesInsertTransaksi(rows[0].catatan_id);
    } else {
      db.query('INSERT INTO catatan_keuangan (user_id, total_pemasukan, total_pengeluaran, saldo) VALUES (?, 0, 0, 0)', [user_id], (errCreate, insertRes) => {
        if (errCreate) return res.status(500).json({ success: false, message: errCreate.message });
        prosesInsertTransaksi(insertRes.insertId);
      });
    }
  });
});

// ============================================================================
// 3. ENDPOINT EDIT & HAPUS TRANSAKSI (USE CASE 2 PART 3)
// ============================================================================

// Edit Transaksi (Mencatat perubahan nominal/nama untuk mencegah manipulasi)
app.put('/api/transaksi/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, jenis, nama_catatan, kategori, jumlah, date } = req.body;
  const tabel = jenis === 'Pemasukan' ? 'pemasukan' : 'pengeluaran';
  const kolomId = jenis === 'Pemasukan' ? 'pemasukan_id' : 'pengeluaran_id';

  // 1. Ambil data lama terlebih dahulu sebelum di-update
  db.query(`SELECT nama_catatan, jumlah FROM ${tabel} WHERE ${kolomId} = ?`, [id], (errOld, oldRows) => {
    const dataLama = oldRows && oldRows.length > 0 ? oldRows[0] : null;

    const sqlUpdate = jenis === 'Pemasukan'
      ? `UPDATE pemasukan SET nama_catatan = ?, jumlah = ?, date = ? WHERE pemasukan_id = ?`
      : `UPDATE pengeluaran SET nama_catatan = ?, kategori = ?, jumlah = ?, date = ? WHERE pengeluaran_id = ?`;

    const params = jenis === 'Pemasukan'
      ? [nama_catatan, jumlah, date, id]
      : [nama_catatan, kategori || 'Lainnya', jumlah, date, id];

    db.query(sqlUpdate, params, (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      // 2. Catat perbandingan Sebelum -> Sesudah ke activity_log
      const infoPerubahan = dataLama
        ? `"${dataLama.nama_catatan}" (Rp ${Number(dataLama.jumlah).toLocaleString('id-ID')}) -> "${nama_catatan}" (Rp ${Number(jumlah).toLocaleString('id-ID')})`
        : `${nama_catatan} (Rp ${Number(jumlah).toLocaleString('id-ID')})`;

      catatLogAktivitas(
        user_id,
        'Catatan Keuangan',
        `Edit Transaksi (${jenis})`,
        infoPerubahan
      );

      res.json({ success: true, message: 'Transaksi berhasil diperbarui!' });
    });
  });
});

// Hapus Transaksi (Mencatat item & nominal yang dihapus agar tidak bisa dihilangkan diam-diam)
app.delete('/api/transaksi/:id', (req, res) => {
  const { id } = req.params;
  const { jenis, userId } = req.query;
  const tabel = jenis === 'Pemasukan' ? 'pemasukan' : 'pengeluaran';
  const kolomId = jenis === 'Pemasukan' ? 'pemasukan_id' : 'pengeluaran_id';

  db.query(`SELECT nama_catatan, jumlah FROM ${tabel} WHERE ${kolomId} = ?`, [id], (errOld, oldRows) => {
    const dataLama = oldRows && oldRows.length > 0 ? oldRows[0] : null;

    db.query(`DELETE FROM ${tabel} WHERE ${kolomId} = ?`, [id], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      const infoHapus = dataLama
        ? `Menghapus "${dataLama.nama_catatan}" senilai Rp ${Number(dataLama.jumlah).toLocaleString('id-ID')}`
        : `Menghapus transaksi ID: ${id}`;

      catatLogAktivitas(
        userId,
        'Catatan Keuangan',
        `Hapus Transaksi (${jenis || 'Transaksi'})`,
        infoHapus
      );

      res.json({ success: true, message: 'Transaksi berhasil dihapus!' });
    });
  });
});
// ============================================================================
// 4. ENDPOINT PRESET / INPUT CEPAT (USE CASE 2 PART 2)
// ============================================================================

// Ambil Daftar Preset User
app.get('/api/preset/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = 'SELECT * FROM preset WHERE user_id = ? ORDER BY preset_id DESC';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: results });
  });
});

// Tambah Preset Baru
app.post('/api/preset', (req, res) => {
  const { user_id, jenis, nama_catatan, jumlah, kategori, deskripsi } = req.body;
  const jumlahNum = parseFloat(jumlah) || 0;
  const sql = 'INSERT INTO preset (user_id, jenis, jumlah, kategori, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';

  db.query(sql, [user_id, jenis || 'Pengeluaran', jumlahNum, kategori || 'Lainnya', deskripsi || '', nama_catatan], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    catatLogAktivitas(
      user_id,
      'Preset Cepat',
      'Tambah Preset Baru',
      `${nama_catatan} (${jenis || 'Pengeluaran'}) • Rp ${jumlahNum.toLocaleString('id-ID')}`
    );

    res.json({ success: true, message: 'Preset berhasil disimpan!', id: result.insertId });
  });
});

// Eksekusi Input Cepat dari Preset
app.post('/api/preset/quick-input', (req, res) => {
  const { preset_id } = req.body;

  db.query('SELECT * FROM preset WHERE preset_id = ?', [preset_id], (err, presetRows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (presetRows.length === 0) return res.status(404).json({ success: false, message: 'Preset tidak ditemukan!' });

    const preset = presetRows[0];
    const nominalPreset = parseFloat(preset.jumlah) || 0;
    const tanggalHariIni = new Date().toLocaleDateString('en-CA');

    db.query('SELECT catatan_id FROM catatan_keuangan WHERE user_id = ?', [preset.user_id], (errCat, catatanRows) => {
      if (errCat) return res.status(500).json({ success: false, message: errCat.message });

      const simpanDariPreset = (catatanId) => {
        if (preset.jenis === 'Pemasukan') {
          const sqlInsert = 'INSERT INTO pemasukan (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
          db.query(sqlInsert, [catatanId, nominalPreset, preset.kategori || 'Pemasukan', tanggalHariIni, preset.deskripsi, preset.nama_catatan], (errIns, result) => {
            if (errIns) return res.status(500).json({ success: false, message: errIns.message });

            db.query('UPDATE catatan_keuangan SET total_pemasukan = total_pemasukan + ?, saldo = saldo + ? WHERE catatan_id = ?', [nominalPreset, nominalPreset, catatanId]);

            catatLogAktivitas(
              preset.user_id,
              'Preset Cepat',
              'Eksekusi Input Cepat (Pemasukan)',
              `${preset.nama_catatan} • Rp ${nominalPreset.toLocaleString('id-ID')}`
            );

            res.json({
              success: true,
              message: `Input cepat "${preset.nama_catatan}" berhasil dicatat!`,
              data: {
                id: result.insertId,
                judul: preset.nama_catatan,
                jenis: 'Pemasukan',
                kategori: preset.kategori || 'Pemasukan',
                nominal: nominalPreset,
                tanggal: tanggalHariIni,
                deskripsi: preset.deskripsi || ''
              }
            });
          });
        } else {
          const sqlInsert = 'INSERT INTO pengeluaran (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
          db.query(sqlInsert, [catatanId, nominalPreset, preset.kategori || 'Lainnya', tanggalHariIni, preset.deskripsi, preset.nama_catatan], (errIns, result) => {
            if (errIns) return res.status(500).json({ success: false, message: errIns.message });

            db.query('UPDATE catatan_keuangan SET total_pengeluaran = total_pengeluaran + ?, saldo = saldo - ? WHERE catatan_id = ?', [nominalPreset, nominalPreset, catatanId]);

            catatLogAktivitas(
              preset.user_id,
              'Preset Cepat',
              'Eksekusi Input Cepat (Pengeluaran)',
              `${preset.nama_catatan} • Rp ${nominalPreset.toLocaleString('id-ID')}`
            );

            res.json({
              success: true,
              message: `Input cepat "${preset.nama_catatan}" berhasil dicatat!`,
              data: {
                id: result.insertId,
                judul: preset.nama_catatan,
                jenis: 'Pengeluaran',
                kategori: preset.kategori || 'Lainnya',
                nominal: nominalPreset,
                tanggal: tanggalHariIni,
                deskripsi: preset.deskripsi || ''
              }
            });
          });
        }
      };

      if (catatanRows.length > 0) {
        simpanDariPreset(catatanRows[0].catatan_id);
      } else {
        db.query('INSERT INTO catatan_keuangan (user_id, total_pemasukan, total_pengeluaran, saldo) VALUES (?, 0, 0, 0)', [preset.user_id], (errCreate, ins) => {
          if (errCreate) return res.status(500).json({ success: false, message: errCreate.message });
          simpanDariPreset(ins.insertId);
        });
      }
    });
  });
});

// Edit Preset
app.put('/api/preset/:presetId', (req, res) => {
  const { presetId } = req.params;
  const { jenis, nama_catatan, jumlah, deskripsi } = req.body;
  const jumlahNum = parseFloat(jumlah) || 0;

  db.query('SELECT user_id FROM preset WHERE preset_id = ?', [presetId], (errSel, rows) => {
    const ownerId = rows && rows.length > 0 ? rows[0].user_id : null;
    const sql = 'UPDATE preset SET jenis = ?, nama_catatan = ?, jumlah = ?, deskripsi = ? WHERE preset_id = ?';

    db.query(sql, [jenis, nama_catatan, jumlahNum, deskripsi, presetId], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      catatLogAktivitas(
        ownerId,
        'Preset Cepat',
        'Edit Preset Cepat',
        `${nama_catatan} (${jenis}) • Rp ${jumlahNum.toLocaleString('id-ID')}`
      );

      res.json({ success: true, message: 'Preset berhasil diperbarui!' });
    });
  });
});

// Hapus Preset
app.delete('/api/preset/:presetId', (req, res) => {
  const { presetId } = req.params;

  db.query('SELECT user_id, nama_catatan FROM preset WHERE preset_id = ?', [presetId], (errSel, rows) => {
    const ownerId = rows && rows.length > 0 ? rows[0].user_id : null;
    const namaPreset = rows && rows.length > 0 ? rows[0].nama_catatan : `Preset #${presetId}`;

    db.query('DELETE FROM preset WHERE preset_id = ?', [presetId], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      catatLogAktivitas(
        ownerId,
        'Preset Cepat',
        'Hapus Preset Cepat',
        `Preset "${namaPreset}" dihapus`
      );

      res.json({ success: true, message: 'Preset berhasil dihapus!' });
    });
  });
});

// ============================================================================
// 5. ENDPOINT INFORMASI KEUANGAN & GRAFIK (USE CASE 3)
// ============================================================================

// Ambil Ringkasan & Data Grafik Berdasarkan Periode / Rentang Tanggal
app.get('/api/laporan/:userId', (req, res) => {
  const { userId } = req.params;
  const { startDate, endDate } = req.query;

  let filterDateSql = '';
  if (startDate && endDate) {
    filterDateSql = ' AND DATE(date) BETWEEN ? AND ?';
  }

  const sql = `
    SELECT p.pemasukan_id AS id, p.nama_catatan AS judul, 'Pemasukan' AS jenis,
           p.kategori, p.jumlah AS nominal, DATE_FORMAT(p.date, '%Y-%m-%d') AS tanggal,
           p.deskripsi
    FROM pemasukan p
    JOIN catatan_keuangan c ON p.catatan_id = c.catatan_id
    WHERE c.user_id = ? ${filterDateSql}
    UNION ALL
    SELECT g.pengeluaran_id AS id, g.nama_catatan AS judul, 'Pengeluaran' AS jenis,
           g.kategori, g.jumlah AS nominal, DATE_FORMAT(g.date, '%Y-%m-%d') AS tanggal,
           g.deskripsi
    FROM pengeluaran g
    JOIN catatan_keuangan c ON g.catatan_id = c.catatan_id
    WHERE c.user_id = ? ${filterDateSql}
    ORDER BY tanggal DESC, id DESC
  `;

  const queryParams = startDate && endDate
    ? [userId, startDate, endDate, userId, startDate, endDate]
    : [userId, userId];

  db.query(sql, queryParams, (err, rows) => {
    if (err) {
      console.error('[LAPORAN] Error ambil laporan:', err.message);
      return res.status(500).json({ success: false, message: err.message });
    }

    let totalPemasukan = 0;
    let totalPengeluaran = 0;
    const kategoriMap = {};

    rows.forEach((item) => {
      const nom = parseFloat(item.nominal) || 0;
      if (item.jenis === 'Pemasukan') {
        totalPemasukan += nom;
      } else {
        totalPengeluaran += nom;
        const kat = item.kategori || 'Lainnya';
        kategoriMap[kat] = (kategoriMap[kat] || 0) + nom;
      }
    });

    res.json({
      success: true,
      ringkasan: {
        total_pemasukan: totalPemasukan,
        total_pengeluaran: totalPengeluaran,
        saldo: totalPemasukan - totalPengeluaran,
      },
      kategori_pengeluaran: kategoriMap,
      transaksi: rows,
    });
  });
});

// ============================================================================
// 6. ENDPOINT TARGET KEUANGAN & LIMIT HARIAN (USE CASE 4)
// ============================================================================

// Ambil Daftar Target + Total Pengeluaran Hari Ini + Pengaturan Limit Harian
app.get('/api/target/:userId', (req, res) => {
  const { userId } = req.params;

  const sqlTarget = `
    SELECT target_id, user_id, jenis, nama_target, nominal_target, nominal_terkumpul,
           DATE_FORMAT(tenggat, '%Y-%m-%d') AS tenggat, keterangan, batasi_harian
    FROM target_keuangan
    WHERE user_id = ?
    ORDER BY tenggat ASC, target_id DESC
  `;
  const sqlLimit = `SELECT * FROM limit_pengeluaran_harian WHERE user_id = ? LIMIT 1`;
  const sqlPengeluaranHariIni = `
    SELECT COALESCE(SUM(g.jumlah), 0) AS total_hari_ini
    FROM pengeluaran g
    JOIN catatan_keuangan c ON g.catatan_id = c.catatan_id
    WHERE c.user_id = ? AND DATE(g.date) = CURDATE()
  `;

  db.query(sqlTarget, [userId], (errTarget, targets) => {
    if (errTarget) return res.status(500).json({ success: false, message: errTarget.message });

    db.query(sqlLimit, [userId], (errLimit, limits) => {
      if (errLimit) return res.status(500).json({ success: false, message: errLimit.message });

      db.query(sqlPengeluaranHariIni, [userId], (errHari, hariRows) => {
        if (errHari) return res.status(500).json({ success: false, message: errHari.message });

        const limitData = limits.length > 0
          ? limits[0]
          : { is_aktif: 0, jumlah_limit: 100000, ambang_persen: 80, notif_push: 1 };

        res.json({
          success: true,
          targets,
          limit_harian: limitData,
          pengeluaran_hari_ini: parseFloat(hariRows[0]?.total_hari_ini || 0),
        });
      });
    });
  });
});

// Tambah Target Keuangan Baru
app.post('/api/target', (req, res) => {
  const { user_id, jenis, nama_target, nominal_target, nominal_terkumpul, tenggat, keterangan, batasi_harian } = req.body;
  const nomTarget = parseFloat(nominal_target) || 0;

  if (!user_id || !jenis || !nama_target || nomTarget <= 0 || !tenggat) {
    return res.status(400).json({ success: false, message: 'Data target belum lengkap!' });
  }

  const sql = `
    INSERT INTO target_keuangan
    (user_id, jenis, nama_target, nominal_target, nominal_terkumpul, tenggat, keterangan, batasi_harian)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    sql,
    [user_id, jenis, nama_target, nomTarget, nominal_terkumpul || 0, tenggat, keterangan || '', batasi_harian ? 1 : 0],
    (err, result) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      if (batasi_harian) {
        const sqlActivateLimit = `
          INSERT INTO limit_pengeluaran_harian (user_id, is_aktif, jumlah_limit, ambang_persen, notif_push)
          VALUES (?, 1, 100000, 80, 1)
          ON DUPLICATE KEY UPDATE is_aktif = 1
        `;
        db.query(sqlActivateLimit, [user_id]);
      }

      catatLogAktivitas(
        user_id,
        'Target Keuangan',
        `Buat Target ${jenis}`,
        `${nama_target} • Target Rp ${nomTarget.toLocaleString('id-ID')} (Tenggat: ${tenggat})`
      );

      res.json({
        success: true,
        message: 'Target keuangan berhasil disimpan!',
        target_id: result.insertId,
      });
    }
  );
});

// Tambah Progres Nominal Terkumpul Target (Quick Add dari Detail Target)
app.post('/api/target/:targetId/progres', (req, res) => {
  const { targetId } = req.params;
  const { tambahan_nominal } = req.body;

  const nominalVal = parseFloat(tambahan_nominal);
  if (!nominalVal || nominalVal <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Nominal tambahan harus lebih dari Rp 0!',
    });
  }

  db.query('SELECT user_id, nama_target, jenis FROM target_keuangan WHERE target_id = ?', [targetId], (errSel, rows) => {
    const ownerId = rows && rows.length > 0 ? rows[0].user_id : null;
    const namaTarget = rows && rows.length > 0 ? rows[0].nama_target : `Target #${targetId}`;

    const sql = `UPDATE target_keuangan SET nominal_terkumpul = nominal_terkumpul + ? WHERE target_id = ?`;
    db.query(sql, [nominalVal, targetId], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      catatLogAktivitas(
        ownerId,
        'Target Keuangan',
        'Tambah Progres Target',
        `${namaTarget} • +Rp ${nominalVal.toLocaleString('id-ID')}`
      );

      res.json({
        success: true,
        message: `Berhasil menambahkan progres sebesar Rp ${nominalVal.toLocaleString('id-ID')}!`,
      });
    });
  });
});

// Edit Target Keuangan
app.put('/api/target/:targetId', (req, res) => {
  const { targetId } = req.params;
  const { jenis, nama_target, nominal_target, nominal_terkumpul, tenggat, keterangan } = req.body;
  const nomTarget = parseFloat(nominal_target) || 0;

  db.query('SELECT user_id FROM target_keuangan WHERE target_id = ?', [targetId], (errSel, rows) => {
    const ownerId = rows && rows.length > 0 ? rows[0].user_id : null;

    const sql = `
      UPDATE target_keuangan
      SET jenis = ?, nama_target = ?, nominal_target = ?, nominal_terkumpul = ?, tenggat = ?, keterangan = ?
      WHERE target_id = ?
    `;

    db.query(
      sql,
      [jenis, nama_target, nomTarget, nominal_terkumpul || 0, tenggat, keterangan || '', targetId],
      (err) => {
        if (err) return res.status(500).json({ success: false, message: err.message });

        catatLogAktivitas(
          ownerId,
          'Target Keuangan',
          'Edit Target Keuangan',
          `${nama_target} (${jenis}) • Rp ${nomTarget.toLocaleString('id-ID')}`
        );

        res.json({ success: true, message: 'Target keuangan berhasil diperbarui!' });
      }
    );
  });
});

// Hapus Target Keuangan
app.delete('/api/target/:targetId', (req, res) => {
  const { targetId } = req.params;

  db.query('SELECT user_id, nama_target FROM target_keuangan WHERE target_id = ?', [targetId], (errSel, rows) => {
    const ownerId = rows && rows.length > 0 ? rows[0].user_id : null;
    const namaTarget = rows && rows.length > 0 ? rows[0].nama_target : `Target #${targetId}`;

    db.query('DELETE FROM target_keuangan WHERE target_id = ?', [targetId], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      catatLogAktivitas(
        ownerId,
        'Target Keuangan',
        'Hapus Target Keuangan',
        `Target "${namaTarget}" dihapus`
      );

      res.json({ success: true, message: 'Target keuangan berhasil dihapus!' });
    });
  });
});

// Simpan Pengaturan Limit Pengeluaran Harian
app.post('/api/limit-harian', (req, res) => {
  const { user_id, is_aktif, jumlah_limit, ambang_persen, notif_push } = req.body;
  const limitNum = parseFloat(jumlah_limit) || 100000;

  const sql = `
    INSERT INTO limit_pengeluaran_harian (user_id, is_aktif, jumlah_limit, ambang_persen, notif_push)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      is_aktif = VALUES(is_aktif),
      jumlah_limit = VALUES(jumlah_limit),
      ambang_persen = VALUES(ambang_persen),
      notif_push = VALUES(notif_push)
  `;

  db.query(
    sql,
    [user_id, is_aktif ? 1 : 0, limitNum, ambang_persen, notif_push ? 1 : 0],
    (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      catatLogAktivitas(
        user_id,
        'Target Keuangan',
        'Pengaturan Limit Harian',
        is_aktif
          ? `Aktif • Batas Rp ${limitNum.toLocaleString('id-ID')} (Ambang ${ambang_persen}%)`
          : 'Limit pengeluaran harian dinonaktifkan'
      );

      res.json({ success: true, message: 'Pengaturan limit pengeluaran harian disimpan!' });
    }
  );
});

// ============================================================================
// 7. ENDPOINT MENGELOLA PROFIL (USE CASE 5)
// ============================================================================

// Ambil Data Profil User (Generate default email: username@mail.com)
app.get('/api/profil/:userId', (req, res) => {
  const { userId } = req.params;

  db.query('SELECT * FROM user WHERE user_id = ? LIMIT 1', [userId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User tidak ditemukan' });
    }

    const u = rows[0];
    const username = u.username || 'user';
    const defaultEmail = `${username.toLowerCase().replace(/\s+/g, '')}@mail.com`;

    res.json({
      success: true,
      profil: {
        user_id: u.user_id,
        username: username,
        nama_lengkap: u.nama_lengkap && u.nama_lengkap.trim() !== '' ? u.nama_lengkap : username,
        email: u.email && u.email.trim() !== '' ? u.email : defaultEmail,
        no_telp: u.no_telp || '',
        foto_profil: u.foto_profil || 'avatar_1',
        notif_aktif: u.notif_aktif !== undefined ? u.notif_aktif : 1,
      },
    });
  });
});

// Update Data Profil (Nama Lengkap, Email, No Telepon, Avatar)
app.put('/api/profil/:userId', (req, res) => {
  const { userId } = req.params;
  const { nama_lengkap, email, no_telp, foto_profil } = req.body;

  if (!nama_lengkap || nama_lengkap.trim() === '' || !email || email.trim() === '') {
    return res.status(400).json({ success: false, message: 'Data profil tidak boleh kosong' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email.trim())) {
    return res.status(400).json({ success: false, message: 'Format email atau password tidak valid' });
  }

  const sql = `
    UPDATE user
    SET nama_lengkap = ?, email = ?, no_telp = ?, foto_profil = ?
    WHERE user_id = ?
  `;

  db.query(
    sql,
    [nama_lengkap.trim(), email.trim(), (no_telp || '').trim(), foto_profil || 'avatar_1', userId],
    (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      catatLogAktivitas(
        userId,
        'Profil',
        'Memperbarui Data Profil',
        `Nama: ${nama_lengkap.trim()} • Email: ${email.trim()}`
      );

      res.json({ success: true, message: 'Profil berhasil diperbarui!' });
    }
  );
});

// Ubah Password Pengguna (Verifikasi Bcrypt & Hash Password Baru)
app.put('/api/profil/:userId/password', (req, res) => {
  const { userId } = req.params;
  const { password_lama, password_baru, konfirmasi_password } = req.body;

  if (!password_lama || !password_baru || !konfirmasi_password) {
    return res.status(400).json({ success: false, message: 'Semua kolom password wajib diisi!' });
  }

  if (password_baru !== konfirmasi_password || password_baru.length < 4) {
    return res.status(400).json({ success: false, message: 'Format email atau password tidak valid' });
  }

  db.query('SELECT password FROM user WHERE user_id = ? LIMIT 1', [userId], async (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const currentPasswordHash = rows[0].password;
    const isMatch = await bcrypt.compare(password_lama, currentPasswordHash);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Password lama salah' });
    }

    const salt = await bcrypt.genSalt(10);
    const newHashedPassword = await bcrypt.hash(password_baru, salt);

    db.query('UPDATE user SET password = ? WHERE user_id = ?', [newHashedPassword, userId], (errUpd) => {
      if (errUpd) return res.status(500).json({ success: false, message: errUpd.message });

      catatLogAktivitas(
        userId,
        'Profil',
        'Mengubah Password Akun',
        'Kata sandi akun berhasil diperbarui'
      );

      res.json({ success: true, message: 'Password berhasil diubah!' });
    });
  });
});

// Simpan Pengaturan Notifikasi Akun
app.put('/api/profil/:userId/notifikasi', (req, res) => {
  const { userId } = req.params;
  const { notif_aktif } = req.body;
  const val = notif_aktif ? 1 : 0;

  db.query('UPDATE user SET notif_aktif = ? WHERE user_id = ?', [val, userId], (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    catatLogAktivitas(
      userId,
      'Profil',
      'Mengubah Preferensi Notifikasi',
      val === 1 ? 'Notifikasi aplikasi diaktifkan' : 'Notifikasi aplikasi dinonaktifkan'
    );

    res.json({ success: true, message: 'Pengaturan notifikasi disimpan!' });
  });
});

// ============================================================================
// 8. ENDPOINT LOGGING AKTIVITAS PENGGUNA (REAL-TIME PER DETIK)
// ============================================================================

// Mencatat Log Aktivitas dari Sisi Frontend (misal: Export CSV/PDF, Logout)
app.post('/api/logs', (req, res) => {
  const { user_id, modul, aksi, detail } = req.body;
  catatLogAktivitas(user_id, modul || 'Sistem', aksi || 'Aktivitas', detail || '');
  res.json({ success: true });
});

// Mengambil Riwayat Log Aktivitas User (Terurut hingga detik terbaru)
app.get('/api/logs/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = `
    SELECT log_id, user_id, modul, aksi, detail,
           DATE_FORMAT(waktu_kejadian, '%d %b %Y • %H:%i:%s') AS waktu_format
    FROM activity_log
    WHERE user_id = ?
    ORDER BY waktu_kejadian DESC, log_id DESC
    LIMIT 150
  `;

  db.query(sql, [userId], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, logs: rows });
  });
});

// ============================================================================
// MENJALANKAN SERVER EXPRESS
// ============================================================================
app.listen(PORT, () => {
  console.log(`[SERVER] FinFlow API Server berjalan di http://localhost:${PORT}`);
});