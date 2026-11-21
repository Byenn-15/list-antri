const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { install, bin } = require('cloudflared');

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
  const matches = message.match(/\b\d{8,12}\b/g);
  return matches ? matches : '-';
}

// Fungsi mengurutkan antrean sesuai aturan Skip All, VIP, Biasa
function getSortedQueue() {
  return [...queue].sort((a, b) => {
    if (b.tier !== a.tier) {
      return b.tier - a.tier;
    }
    if (a.tier === 3 && b.amount !== a.amount) {
      return b.amount - a.amount;
    }
    return a.timestamp - b.timestamp;
  });
}

// Endpoint Webhook untuk menerima data dari SociaBuzz
app.post('/webhook/sociabuzz', (req, res) => {
  const data = req.body;
  console.log('Data SociaBuzz masuk:', data);

  const supporter = data.supporter || data.name || 'Anonim';
  const amount = parseInt(data.amount_raw || data.amount || 0, 10);
  const message = data.message || '';

  if (amount < 1000) {
    return res.status(200).json({ status: 'ignored', reason: 'Nominal di bawah 1000' });
  }

  let tier = 1;
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
  io.emit('queue_update', getSortedQueue());
  
  res.status(200).json({ status: 'success', entry: newEntry });
});

// Koneksi Socket.io untuk komunikasi real-time
io.on('connection', (socket) => {
  socket.emit('queue_update', getSortedQueue());

  socket.on('remove_player', (playerId) => {
    queue = queue.filter(item => item.id !== playerId);
    io.emit('queue_update', getSortedQueue());
  });

  socket.on('clear_all', () => {
    queue = [];
    io.emit('queue_update', getSortedQueue());
  });
});

// Menjalankan server & menangkap link HTTPS Cloudflare langsung dari log proses
const PORT = process.env.SERVER_PORT || process.env.PORT || 3513;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server lokal berjalan di port ${PORT}`);
  
  try {
    if (!fs.existsSync(bin)) {
      console.log('Mengunduh komponen Cloudflare Tunnel, tunggu sebentar...');
      await install(bin);
    }

    const cf = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`]);
    
    const handleOutput = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        console.log('====================================');
        console.log('LINK HTTPS BARU KAMU:', match[0]);
        console.log('====================================');
      }
    };

    cf.stdout.on('data', handleOutput);
    cf.stderr.on('data', handleOutput);
  } catch (err) {
    console.error('Gagal menjalankan Cloudflare Tunnel:', err);
  }
});
