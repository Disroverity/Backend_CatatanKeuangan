const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcryptjs'); // Import bcryptjs

const app = express();

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
  database: 'catatan_keuangan_db'
});

db.connect(err => {
  if (err) console.error('Gagal terhubung ke MySQL:', err);
  else console.log('Terhubung ke MySQL Database!');
});


// ENDPOINT REGISTER (Dengan Password Hashing)

app.post('/api/register', async (req, res) => {
  const { nama_lengkap, username, password, email } = req.body;

  try {
    // Generate salt dan hash password (10 salt rounds standar aman)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const sql = 'INSERT INTO USER (nama_lengkap, username, email, password) VALUES (?, ?, ?, ?)';
    db.query(sql, [nama_lengkap, username, email || `${username}@mail.com`, hashedPassword], (err, result) => {
      if (err) {
        return res.status(400).json({ success: false, message: 'Username/Email sudah terdaftar!' });
      }
      res.json({ success: true, message: 'Registrasi berhasil!' });
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

app.listen(3000, () => console.log('Server API berjalan di port 3000'));