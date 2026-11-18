const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // Import bcryptjs
const app = express();
const crypto = require('crypto');

// Fungsi pembuat User ID unik (Contoh hasil: USR-8F3A9C)
function generateUserId() {
  const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `USR-${randomHex}`;
}

// CORS biar Flutter Web tidak diblokir browser
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Koneksi Database MySQL
const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'Naufal356._',
  database: 'catatan_keuangan_db',
  dateStrings: true
});

db.connect(err => {
  if (err) console.error('Gagal terhubung ke MySQL:', err);
  else console.log('Terhubung ke MySQL Database!');
});


// ENDPOINT REGISTER (Dengan Password Hashing)

app.post('/api/register', async (req, res) => {
  const { nama_lengkap, username, password, email } = req.body;

  try {
    const newUserId = generateUserId(); // Generate ID unik format USR-XXXXXX
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Sertakan user_id ke dalam kolom dan values INSERT
    const sql = 'INSERT INTO USER (user_id, nama_lengkap, username, email, password) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [newUserId, nama_lengkap, username, email || `${username}@mail.com`, hashedPassword], (err, result) => {
      if (err) {
        console.error('Error register:', err);
        return res.status(400).json({ success: false, message: 'Username/Email sudah terdaftar atau gagal simpan!' });
      }
      res.json({ success: true, message: 'Registrasi berhasil!', user_id: newUserId });
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Gagal memproses enkripsi password.' });
  }
});


// ENDPOINT LOGIN (Verifikasi Hash Password)

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // 1. Cari user berdasarkan username
  const sql = 'SELECT * FROM USER WHERE username = ?';
  db.query(sql, [username], async (err, results) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    if (results.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }

    const user = results[0];

    // 2. bandingin password ketikan user dengan hash yang ada di database
    const isMatch = await bcrypt.compare(password, user.password);

    if (isMatch) {
      // Hapus field password sebelum objek user dikirim balik ke Flutter (anti sniffing)
      delete user.password;
      res.json({ success: true, message: 'Login berhasil', user: user });
    } else {
      res.status(401).json({ success: false, message: 'Username atau Password salah!' });
    }
  });
});


// 1. ENDPOINT AMBIL SEMUA TRANSAKSI USER

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
      console.error('Error ambil transaksi:', err);
      return res.status(500).json({ success: false, message: err.message });
    }
    res.json({ success: true, data: results });
  });
});

// ==========================================
// 2. ENDPOINT TAMBAH TRANSAKSI BARU
// ==========================================
app.post('/api/transaksi', (req, res) => {
  const { user_id, jenis, nama_catatan, nominal, kategori, tanggal, deskripsi } = req.body;

  // Langkah A: Cek apakah user sudah punya catatan_id di tabel catatan_keuangan
  db.query('SELECT catatan_id FROM catatan_keuangan WHERE user_id = ?', [user_id], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });

    const prosesInsertTransaksi = (catatanId) => {
      if (jenis === 'Pemasukan') {
        const sqlInsert = 'INSERT INTO pemasukan (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
        db.query(sqlInsert, [catatanId, nominal, kategori || 'Pemasukan', tanggal, deskripsi, nama_catatan], (err, result) => {
          if (err) return res.status(500).json({ success: false, message: err.message });

          // Update total_pemasukan & saldo di tabel catatan_keuangan
          const sqlUpdate = 'UPDATE catatan_keuangan SET total_pemasukan = total_pemasukan + ?, saldo = saldo + ? WHERE catatan_id = ?';
          db.query(sqlUpdate, [nominal, nominal, catatanId]);

          res.json({ success: true, message: 'Pemasukan berhasil disimpan!', id: result.insertId });
        });
      } else {
        const sqlInsert = 'INSERT INTO pengeluaran (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
        db.query(sqlInsert, [catatanId, nominal, kategori || 'Lainnya', tanggal, deskripsi, nama_catatan], (err, result) => {
          if (err) return res.status(500).json({ success: false, message: err.message });

          // Update total_pengeluaran & saldo di tabel catatan_keuangan
          const sqlUpdate = 'UPDATE catatan_keuangan SET total_pengeluaran = total_pengeluaran + ?, saldo = saldo - ? WHERE catatan_id = ?';
          db.query(sqlUpdate, [nominal, nominal, catatanId]);

          res.json({ success: true, message: 'Pengeluaran berhasil disimpan!', id: result.insertId });
        });
      }
    };

    // Jika user sudah punya catatan_id, langsung pakai; jika belum, buat baru dulu
    if (rows.length > 0) {
      prosesInsertTransaksi(rows[0].catatan_id);
    } else {
      db.query('INSERT INTO catatan_keuangan (user_id, total_pemasukan, total_pengeluaran, saldo) VALUES (?, 0, 0, 0)', [user_id], (err, insertRes) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        prosesInsertTransaksi(insertRes.insertId);
      });
    }
  });
});

// =========================================================================
// 3. ENDPOINT EDIT & HAPUS TRANSAKSI 
// =========================================================================

// Fungsi bantu sinkronisasi ulang total_pemasukan, total_pengeluaran, dan saldo (hitungSaldo)
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

// ALT 1: Edit Transaksi (PUT /api/transaksi/:id)
app.put('/api/transaksi/:id', (req, res) => {
  const { id } = req.params;
  const { user_id, jenis_lama, jenis_baru, nama_catatan, nominal, kategori, tanggal, deskripsi } = req.body;
  const tabelLama = jenis_lama === 'Pemasukan' ? 'pemasukan' : 'pengeluaran';
  const kolomIdLama = jenis_lama === 'Pemasukan' ? 'pemasukan_id' : 'pengeluaran_id';

  // Jika jenis transaksi tidak berubah (misal tetap Pengeluaran atau tetap Pemasukan)
  if (jenis_lama === jenis_baru) {
    const sqlUpdate = `
      UPDATE ${tabelLama} 
      SET nama_catatan = ?, jumlah = ?, kategori = ?, date = ?, deskripsi = ? 
      WHERE ${kolomIdLama} = ?
    `;
    db.query(sqlUpdate, [nama_catatan, nominal, kategori, tanggal, deskripsi || '', id], (err) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      sinkronkanSaldoUser(user_id, () => {
        res.json({ success: true, message: 'Catatan transaksi berhasil diperbarui!' });
      });
    });
  } else {
    // Jika user mengubah jenis (misal dari Pengeluaran menjadi Pemasukan atau sebaliknya)
    db.query('SELECT catatan_id FROM catatan_keuangan WHERE user_id = ?', [user_id], (err, rows) => {
      if (err || rows.length === 0) return res.status(500).json({ success: false, message: 'Catatan user tidak ditemukan' });
      const catatanId = rows[0].catatan_id;

      db.query(`DELETE FROM ${tabelLama} WHERE ${kolomIdLama} = ?`, [id], (errDel) => {
        if (errDel) return res.status(500).json({ success: false, message: errDel.message });

        const tabelBaru = jenis_baru === 'Pemasukan' ? 'pemasukan' : 'pengeluaran';
        const sqlInsert = `INSERT INTO ${tabelBaru} (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)`;
        db.query(sqlInsert, [catatanId, nominal, kategori, tanggal, deskripsi || '', nama_catatan], (errIns) => {
          if (errIns) return res.status(500).json({ success: false, message: errIns.message });
          sinkronkanSaldoUser(user_id, () => {
            res.json({ success: true, message: 'Catatan transaksi berhasil diperbarui!' });
          });
        });
      });
    });
  }
});

// ALT 2: Hapus Transaksi (DELETE /api/transaksi/:jenis/:id)
app.delete('/api/transaksi/:jenis/:id', (req, res) => {
  const { jenis, id } = req.params;
  const { user_id } = req.query;
  const tabel = jenis === 'Pemasukan' ? 'pemasukan' : 'pengeluaran';
  const kolomId = jenis === 'Pemasukan' ? 'pemasukan_id' : 'pengeluaran_id';

  db.query(`DELETE FROM ${tabel} WHERE ${kolomId} = ?`, [id], (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (user_id) {
      sinkronkanSaldoUser(user_id, () => {
        res.json({ success: true, message: 'Catatan transaksi berhasil dihapus!' });
      });
    } else {
      res.json({ success: true, message: 'Catatan transaksi berhasil dihapus!' });
    }
  });
});

// ==========================================
// 3. ENDPOINT KELOLA PRESET (INPUT CEPAT)
// ==========================================

// Ambil daftar preset user (menggunakan alias agar cocok dengan key di Flutter)
app.get('/api/preset/:userId', (req, res) => {
  const { userId } = req.params;
  const sql = 'SELECT * FROM preset WHERE user_id = ? ORDER BY preset_id DESC';
  db.query(sql, [userId], (err, results) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: results });
  });
});

// Tambah preset baru (dari centang "Jadikan preset?")
app.post('/api/preset', (req, res) => {
  const { user_id, jenis, nama_catatan, jumlah, kategori, deskripsi } = req.body;
  const sql = 'INSERT INTO preset (user_id, jenis, jumlah, kategori, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
  db.query(sql, [user_id, jenis || 'Pengeluaran', jumlah, kategori || 'Lainnya', deskripsi || '', nama_catatan], (err, result) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Preset berhasil disimpan!', id: result.insertId });
  });
});

// Sequence Diagram Langkah 4-11: executeQuickInput(preset_id)
app.post('/api/preset/quick-input', (req, res) => {
  const { preset_id } = req.body;

  // Langkah 5-6: getPresetById(preset_id) -> dataPreset
  db.query('SELECT * FROM preset WHERE preset_id = ?', [preset_id], (err, presetRows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (presetRows.length === 0) return res.status(404).json({ success: false, message: 'Preset tidak ditemukan!' });

    const preset = presetRows[0];
    const tanggalHariIni = new Date().toLocaleDateString('en-CA'); // waktu lokal

    // Cari catatan_id milik user
    db.query('SELECT catatan_id FROM catatan_keuangan WHERE user_id = ?', [preset.user_id], (err, catatanRows) => {
      if (err) return res.status(500).json({ success: false, message: err.message });

      const simpanDariPreset = (catatanId) => {
        if (preset.jenis === 'Pemasukan') {
          const sqlInsert = 'INSERT INTO pemasukan (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
          db.query(sqlInsert, [catatanId, preset.jumlah, preset.kategori || 'Pemasukan', tanggalHariIni, preset.deskripsi, preset.nama_catatan], (err, result) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            db.query('UPDATE catatan_keuangan SET total_pemasukan = total_pemasukan + ?, saldo = saldo + ? WHERE catatan_id = ?', [preset.jumlah, preset.jumlah, catatanId]);
            res.json({
              success: true,
              message: `Input cepat "${preset.nama_catatan}" berhasil dicatat!`,
              data: {
                id: result.insertId,
                judul: preset.nama_catatan,
                jenis: 'Pemasukan',
                kategori: preset.kategori || 'Pemasukan',
                nominal: parseFloat(preset.jumlah),
                tanggal: tanggalHariIni,
                deskripsi: preset.deskripsi || ''
              }
            });
          });
        } else {
          const sqlInsert = 'INSERT INTO pengeluaran (catatan_id, jumlah, kategori, date, deskripsi, nama_catatan) VALUES (?, ?, ?, ?, ?, ?)';
          db.query(sqlInsert, [catatanId, preset.jumlah, preset.kategori || 'Lainnya', tanggalHariIni, preset.deskripsi, preset.nama_catatan], (err, result) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            db.query('UPDATE catatan_keuangan SET total_pengeluaran = total_pengeluaran + ?, saldo = saldo - ? WHERE catatan_id = ?', [preset.jumlah, preset.jumlah, catatanId]);
            res.json({
              success: true,
              message: `Input cepat "${preset.nama_catatan}" berhasil dicatat!`,
              data: {
                id: result.insertId,
                judul: preset.nama_catatan,
                jenis: 'Pengeluaran',
                kategori: preset.kategori || 'Lainnya',
                nominal: parseFloat(preset.jumlah),
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
        db.query('INSERT INTO catatan_keuangan (user_id, total_pemasukan, total_pengeluaran, saldo) VALUES (?, 0, 0, 0)', [preset.user_id], (err, ins) => {
          if (err) return res.status(500).json({ success: false, message: err.message });
          simpanDariPreset(ins.insertId);
        });
      }
    });
  });
});

// ==========================================
// 3. ENDPOINT KELOLA PRESET (EDIT & HAPUS)
// ==========================================

// Edit Preset (Wireframe Halaman Edit Preset)
app.put('/api/preset/:presetId', (req, res) => {
  const { presetId } = req.params;
  const { jenis, nama_catatan, jumlah, deskripsi } = req.body;
  const sql = 'UPDATE preset SET jenis = ?, nama_catatan = ?, jumlah = ?, deskripsi = ? WHERE preset_id = ?';
  db.query(sql, [jenis, nama_catatan, jumlah, deskripsi, presetId], (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Preset berhasil diperbarui!' });
  });
});

// Delete Preset (Menu titik tiga -> Delete)
app.delete('/api/preset/:presetId', (req, res) => {
  const { presetId } = req.params;
  db.query('DELETE FROM preset WHERE preset_id = ?', [presetId], (err) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Preset berhasil dihapus!' });
  });
});

app.listen(3000, () => console.log('Server API berjalan di port 3000'));
// app.listen(3000, '0.0.0.0', () => {
//   console.log('Server API berjalan di port 3000');
// });