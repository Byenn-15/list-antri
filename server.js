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

const queuePath = path.join(__dirname, 'queue.json');
let queue = [];
if (fs.existsSync(queuePath)) {
  try {
    queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch (e) {}
}

function saveQueue() {
  try {
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  } catch (e) {}
}

const configPath = path.join(__dirname, 'config.json');
let prices = { regular: 1000, vip: 2000, skipAll: 3000 };
if (fs.existsSync(configPath)) {
  try {
    prices = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {}
}

// PERBAIKAN: Ambil elemen pertama (matches[0]) agar berupa string, bukan array
function extractFFID(message) {
  if (!message) return '-';
  const matches = String(message).match(/\b\d{8,12}\b/g);
  return matches && matches.length > 0 ? matches[0] : '-';
}

function calculateTier(totalAmount) {
  if (totalAmount >= prices.skipAll) {
    return { tier: 3, tierName: 'SKIP ALL' };
  } else if (totalAmount >= prices.vip) {
    return { tier: 2, tierName: 'VIP' };
  }
  return { tier: 1, tierName: 'BIASA' };
}

function getSortedQueue() {
  return [...queue].sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier;
    if (a.tier === 3 && b.amount !== a.amount) return b.amount - a.amount;
    return a.timestamp - b.timestamp;
  });
}

function broadcastUpdates() {
  saveQueue();
  const sorted = getSortedQueue();
  io.emit('admin_queue_update', sorted);
  io.emit('queue_update', sorted.filter(item => !item.hidden));
}

app.post('/webhook/sociabuzz', (req, res) => {
  const data = req.body;
  const supporter = (data.supporter || data.name || 'Anonim').trim();
  const email = (data.email || data.supporter_email || '').trim().toLowerCase();
  const amount = parseInt(data.amount_raw || data.amount || 0, 10);
  const message = data.message || '';
  const extractedId = extractFFID(message);

  const existingIndex = queue.findIndex((item) => {
    const sameEmail = email !== '' && !email.includes('*') && item.email === email;
    const sameId = extractedId !== '-' && item.ffId !== '-' && item.ffId === extractedId;
    return sameEmail || sameId;
  });

  if (existingIndex !== -1) {
    const existing = queue[existingIndex];
    const newTotal = existing.amount + amount;
    const newTierInfo = calculateTier(newTotal);

    existing.amount = newTotal;
    existing.tier = newTierInfo.tier;
    existing.tierName = newTierInfo.tierName;
    if (extractedId !== '-') existing.ffId = extractedId;
    if (message) existing.message = `${existing.message} | +${amount}: ${message}`;

    broadcastUpdates();
    return res.status(200).json({ status: 'upgraded', entry: existing });
  }

  if (amount < prices.regular) {
    return res.status(200).json({ status: 'ignored', reason: 'Nominal di bawah minimal antrean' });
  }

  const tierInfo = calculateTier(amount);
  const newEntry = {
    id: Date.now().toString() + Math.random().toString(36).substring(2, 6),
    name: supporter,
    email: email,
    amount: amount,
    message: message,
    ffId: extractedId,
    tier: tierInfo.tier,
    tierName: tierInfo.tierName,
    hidden: false,
    timestamp: Date.now()
  };

  queue.push(newEntry);
  broadcastUpdates();
  res.status(200).json({ status: 'success', entry: newEntry });
});

io.on('connection', (socket) => {
  const sorted = getSortedQueue();
  socket.emit('admin_queue_update', sorted);
  socket.emit('queue_update', sorted.filter(item => !item.hidden));
  socket.emit('prices_update', prices);

  socket.on('update_prices', (newPrices) => {
    prices = {
      regular: parseInt(newPrices.regular, 10) || 1000,
      vip: parseInt(newPrices.vip, 10) || 2000,
      skipAll: parseInt(newPrices.skipAll, 10) || 3000
    };
    fs.writeFileSync(configPath, JSON.stringify(prices));
    io.emit('prices_update', prices);
  });

  socket.on('edit_player', (updated) => {
    const index = queue.findIndex(item => item.id === updated.id);
    if (index !== -1) {
      const newAmount = parseInt(updated.amount, 10) || queue[index].amount;
      const tierInfo = calculateTier(newAmount);
      queue[index].name = updated.name.trim() || queue[index].name;
      queue[index].amount = newAmount;
      queue[index].ffId = updated.ffId.trim() || '-';
      queue[index].tier = tierInfo.tier;
      queue[index].tierName = tierInfo.tierName;
      broadcastUpdates();
    }
  });

  socket.on('toggle_hide', (playerId) => {
    const index = queue.findIndex(item => item.id === playerId);
    if (index !== -1) {
      queue[index].hidden = !queue[index].hidden;
      broadcastUpdates();
    }
  });

  socket.on('remove_player', (playerId) => {
    queue = queue.filter(item => item.id !== playerId);
    broadcastUpdates();
  });

  socket.on('clear_all', () => {
    queue = [];
    broadcastUpdates();
  });
});

const PORT = process.env.SERVER_PORT || process.env.PORT || 3513;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server lokal berjalan di port ${PORT}`);
  try {
    if (!fs.existsSync(bin)) {
      await install(bin);
    }
    // GANTI DENGAN TOKEN CLOUDFLARE PERMANEN KAMU
    const cf = spawn(bin, ['tunnel', 'run', '--token', 'eyJhIjoiNzRiNTZkM2VlZWNlMWU2YjdkOGI4MjFiM2I3NzNhYjEiLCJ0IjoiNjJmZTQ4NmUtYmUwZS00ZjMwLWJhODItMWI5ZDgwODkyMWM3IiwicyI6Ik5USm1abVk0TkRVdFl6VTVPQzAwTm1KbUxXSTBNekF0WmpRMVpqaGxZalEyTmpOaSJ9']);

    cf.stderr.on('data', (data) => {
      const text = data.toString();
      if (text.includes('Registered tunnel connection')) {
        console.log('✅ TUNNEL PERMANEN TERHUBUNG!');
      }
    });
  } catch (err) {
    console.error('Gagal menjalankan Cloudflare Tunnel:', err);
  }
});
