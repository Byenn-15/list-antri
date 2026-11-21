const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Penyimpanan antrean sementara di memori
let queue = [];

// Fungsi filter ID Free Fire (8-12 digit angka terpisah spasi)
function extractFFID(message) {
  if (!message) return '-';
  // Mencari deretan angka murni panjang 8-12 digit yang berdiri sendiri
  const matches = message.match(/\b\d{8,12}\b/g);
  return matches ? matches[0] : '-';
}

// Fungsi mengurutkan antrean sesuai aturan Skip All, VIP, Biasa
function getSortedQueue() {
  return [...queue].sort((a, b) => {
    // 1. Urutkan berdasarkan kasta (3: Skip All, 2: VIP, 1: Biasa)
    if (b.tier !== a.tier) {
      return b.tier - a.tier;
    }
    // 2. Jika sama-sama Skip All (tier 3), nominal tertinggi paling atas
    if (a.tier === 3 && b.amount !== a.amount) {
      return b.amount - a.amount;
    }
    // 3. Jika nominal sama atau berada di VIP/Biasa, yang masuk duluan di atas
    return a.timestamp - b.timestamp;
  });
}

// Endpoint Webhook untuk menerima data dari SociaBuzz
app.post('/webhook/sociabuzz', (req, res) => {
  const data = req.body;
  console.log('Data masuk:', data);

  // Menyesuaikan format payload SociaBuzz Tribe
  const supporter = data.supporter || data.name || 'Anonim';
  const amount = parseInt(data.amount_raw || data.amount || 0, 10);
  const message = data.message || '';

  // Abaikan jika donasi di bawah Rp1.000
  if (amount < 1000) {
    return res.status(200).json({ status: 'ignored', reason: 'Nominal di bawah 1000' });
  }

  // Tentukan kasta antrean
  let tier = 1; // Antrean Biasa (1.000 - 1.999)
  let tierName = 'BIASA';
  if (amount >= 3000) {
    tier = 3;
    tierName = 'SKIP ALL';
  } else if (amount >= 2000) {
    tier = 2;
    tierName = 'VIP';
  }

  const newEntry = {
    id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
    name: supporter,
    amount: amount,
    message: message,
    ffId: extractFFID(message),
    tier: tier,
    tierName: tierName,
    timestamp: Date.now()
  };

  queue.push(newEntry);
  
  // Kirim pembaruan real-time ke Overlay OBS dan Panel Admin
  io.emit('queue_update', getSortedQueue());
  
  res.status(200).json({ status: 'success', entry: newEntry });
});

// Koneksi Socket.io untuk komunikasi real-time
io.on('connection', (socket) => {
  // Kirim data antrean terbaru saat halaman baru dibuka
  socket.emit('queue_update', getSortedQueue());

  // Hapus pemain dari antrean (jika sudah selesai main)
  socket.on('remove_player', (playerId) => {
    queue = queue.filter(item => item.id !== playerId);
    io.emit('queue_update', getSortedQueue());
  });

  // Reset semua antrean
  socket.on('clear_all', () => {
    queue = [];
    io.emit('queue_update', getSortedQueue());
  });
});

// Jalankan server di port dinamis (wajib untuk hosting gratis) atau 3000 di lokal
const { tunnel } = require('cloudflared');

const PORT = process.env.SERVER_PORT || process.env.PORT || 3513;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server lokal berjalan di port ${PORT}`);
  
  // Membuat link HTTPS gratis otomatis via Cloudflare Tunnel
  const { url } = await tunnel({ '--url': `http://localhost:${PORT}` });
  console.log('====================================');
  console.log('LINK HTTPS BARU KAMU:', url);
  console.log('====================================');
});
