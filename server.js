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

let queue = [];

// Muat pengaturan harga dari file config.json jika ada, atau pakai default
const configPath = path.join(__dirname, 'config.json');
let prices = { regular: 1000, vip: 2000, skipAll: 3000 };
if (fs.existsSync(configPath)) {
  try {
    prices = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {}
}

function extractFFID(message) {
  if (!message) return '-';
  const matches = message.match(/\b\d{8,12}\b/g);
  return matches ? matches : '-';
}

function getSortedQueue() {
  return [...queue].sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier;
    if (a.tier === 3 && b.amount !== a.amount) return b.amount - a.amount;
    return a.timestamp - b.timestamp;
  });
}

app.post('/webhook/sociabuzz', (req, res) => {
  const data = req.body;
  const supporter = data.supporter || data.name || 'Anonim';
  const amount = parseInt(data.amount_raw || data.amount || 0, 10);
  const message = data.message || '';

  // Abaikan jika di bawah harga antrean biasa saat ini
  if (amount < prices.regular) {
    return res.status(200).json({ status: 'ignored', reason: 'Nominal di bawah minimal antrean' });
  }

  let tier = 1;
  let tierName = 'BIASA';
  if (amount >= prices.skipAll) {
    tier = 3;
    tierName = 'SKIP ALL';
  } else if (amount >= prices.vip) {
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

io.on('connection', (socket) => {
  socket.emit('queue_update', getSortedQueue());
  socket.emit('prices_update', prices);

  // Terima pembaruan harga dari halaman admin
  socket.on('update_prices', (newPrices) => {
    prices = {
      regular: parseInt(newPrices.regular, 10) || 1000,
      vip: parseInt(newPrices.vip, 10) || 2000,
      skipAll: parseInt(newPrices.skipAll, 10) || 3000
    };
    fs.writeFileSync(configPath, JSON.stringify(prices));
    io.emit('prices_update', prices);
  });

  socket.on('remove_player', (playerId) => {
    queue = queue.filter(item => item.id !== playerId);
    io.emit('queue_update', getSortedQueue());
  });

  socket.on('clear_all', () => {
    queue = [];
    io.emit('queue_update', getSortedQueue());
  });
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 3513;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server lokal berjalan di port ${PORT}`);
  try {
    if (!fs.existsSync(bin)) {
      await install(bin);
    }
    const cf = spawn(bin, ['tunnel', '--url', `http://localhost:${PORT}`]);
    const handleOutput = (data) => {
      const match = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        console.log('====================================');
        console.log('LINK HTTPS BARU KAMU:', match);
        console.log('====================================');
      }
    };
    cf.stdout.on('data', handleOutput);
    cf.stderr.on('data', handleOutput);
  } catch (err) {
    console.error('Gagal menjalankan Cloudflare Tunnel:', err);
  }
});
