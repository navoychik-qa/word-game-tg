const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// --- БАЗА ДАННЫХ ---
const playersDB = {}; 
const queue = []; 
const rooms = {};
const privateRooms = {}; // Для комнат друзей

// --- ПОДКЛЮЧЕНИЕ К MONGODB ---
const MONGODB_URI = process.env.MONGODB_URI;
let db, playersCollection;

async function connectDB() {
    if (!MONGODB_URI) {
        console.error('❌ КРИТИЧЕСКАЯ ОШИБКА: MONGODB_URI не задана!');
        return;
    }
    console.log('⏳ Попытка подключения к MongoDB...');
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db('wordbattle');
        playersCollection = db.collection('players');
        
        const allPlayers = await playersCollection.find({}).toArray();
        allPlayers.forEach(p => { playersDB[p.id] = p; });
        console.log(`✅ УСПЕХ: Загружено игроков из БД: ${allPlayers.length}`);
    } catch (e) {
        console.error('❌ ОШИБКА ПОДКЛЮЧЕНИЯ К БД:', e.message);
    }
}
connectDB();

async function savePlayer(userId) {
    if (!playersCollection || !playersDB[userId]) return;
    try {
        await playersCollection.updateOne({ id: userId }, { $set: playersDB[userId] }, { upsert: true });
    } catch (e) { console.error('Ошибка сохранения игрока:', e); }
}

// --- ТОКЕН БОТА ---
const BOT_TOKEN = process.env.BOT_TOKEN; 
if (!BOT_TOKEN) console.warn('⚠️ BOT_TOKEN не задан!');

// --- ЗАГРУЗКА СЛОВАРЯ ---
let DICTIONARY = new Set();
try {
    const wordsPath = path.join(__dirname, 'words.txt.gz');
    if (fs.existsSync(wordsPath)) {
        const buffer = fs.readFileSync(wordsPath);
        const data = zlib.gunzipSync(buffer).toString('utf8');
        DICTIONARY = new Set(data.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => w.length > 1));
        console.log(`Словарь загружен. Слов: ${DICTIONARY.size}`);
    } else {
        console.log('words.txt.gz не найден. Тестовый словарь.');
        DICTIONARY = new Set(['крыса', 'лампа', 'сок', 'дом', 'кот', 'собака', 'привет', 'слово']);
    }
} catch (e) { console.error('Ошибка словаря:', e); DICTIONARY = new Set(['крыса', 'кот']); }

// --- ГЕНЕРАТОР ЗАДАНИЙ ---
const letters = 'абвгдежзиклмнопрстуфхцчшщэюя';
const vowels = 'аеиоуыэюя';
const consonants = 'бвгджзклмнпрстфхцчшщ';

function generateTask() {
    const type = Math.floor(Math.random() * 3);
    let text = '', conditionType = '', conditionVal = '';
    if (type === 0) {
        const l = letters[Math.floor(Math.random() * letters.length)];
        conditionType = 'startsWith'; conditionVal = l; text = `Начинается на "${l.toUpperCase()}"`;
    } else if (type === 1) {
        const l = vowels[Math.floor(Math.random() * vowels.length)];
        conditionType = 'endsWith'; conditionVal = l; text = `Заканчивается на "${l.toUpperCase()}"`;
    } else {
        const l = consonants[Math.floor(Math.random() * consonants.length)];
        conditionType = 'contains'; conditionVal = l; text = `Содержит букву "${l.toUpperCase()}"`;
    }
    return { conditionType, conditionVal, text };
}

// ==========================================
// API ДЛЯ ОПЛАТЫ
// ==========================================

app.post('/create-invoice', async (req, res) => {
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Бот не настроен' });
    const { userId, packageId } = req.body;
    let amount = 0, title = '';
    if (packageId === 'small') { amount = 10; title = '50 Монет'; }
    else if (packageId === 'medium') { amount = 25; title = '150 Монет + 10 Алмазов'; }
    else if (packageId === 'large') { amount = 50; title = '400 Монет + 50 Алмазов'; }
    else return res.status(400).json({ error: 'Неверный пакет' });

    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title, description: 'Покупка валюты в игре Word Battle',
                payload: JSON.stringify({ userId, packageId }),
                provider_token: '', currency: 'XTR',
                prices: [{ label: title, amount: amount }]
            })
        });
        const data = await response.json();
        if (data.ok) res.json({ invoiceLink: data.result });
        else res.status(500).json({ error: data.description });
    } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/webhook', (req, res) => {
    const update = req.body;
    if (update.pre_checkout_query) {
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
        }).catch(err => console.error(err));
        return res.sendStatus(200);
    }

    if (update.message && update.message.successful_payment) {
        const payment = update.message.successful_payment;
        const payload = JSON.parse(payment.invoice_payload);
        const userId = payload.userId;
        const packageId = payload.packageId;

        console.log(`💰 ОПЛАТА ПРОШЛА! Игрок: ${userId}, Пакет: ${packageId}`);

        if (playersDB[userId]) {
            if (packageId === 'small') { playersDB[userId].coins += 50; }
            else if (packageId === 'medium') { playersDB[userId].coins += 150; playersDB[userId].diamonds += 10; }
            else if (packageId === 'large') { playersDB[userId].coins += 400; playersDB[userId].diamonds += 50; }
            
            savePlayer(userId);
            io.emit(`payment_success_${userId}`, { coins: playersDB[userId].coins, diamonds: playersDB[userId].diamonds });
        }
    }
    res.sendStatus(200);
});

// --- ИГРОВАЯ ЛОГИКА ---
io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!playersDB[data.id]) {
            if (playersCollection) {
                const existing = await playersCollection.findOne({ id: data.id });
                if (existing) {
                    playersDB[data.id] = existing;
                } else {
                    playersDB[data.id] = { id: data.id, name: data.name || 'Игрок', rating: 1000, coins: 50, diamonds: 0 };
                    savePlayer(data.id);
                }
            } else {
                playersDB[data.id] = { id: data.id, name: data.name || 'Игрок', rating: 1000, coins: 50, diamonds: 0 };
            }
        }
        socket.userId = data.id;
        socket.emit('auth_success', playersDB[data.id]);
    });

    // Поиск случайного игрока
    socket.on('find_match', () => {
        if (queue.includes(socket)) return;
        queue.push(socket);
        socket.emit('searching');
        if (queue.length >= 2) { const p1 = queue.shift(); const p2 = queue.shift(); createPendingRoom(p1, p2, false); }
    });

    socket.on('cancel_search', () => {
        const index = queue.indexOf(socket); if (index > -1) queue.splice(index, 1);
    });

    // Создание комнаты друга
    socket.on('create_private_room', () => {
        const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        privateRooms[roomCode] = { host: socket, guest: null, code: roomCode };
        socket.privateRoomCode = roomCode;
        socket.emit('private_room_created', roomCode);
    });

    // Присоединение к комнате друга
    socket.on('join_private_room', (code) => {
        const room = privateRooms[code.toUpperCase()];
        if (!room) return socket.emit('private_room_error', 'Комната не найдена!');
        if (room.guest) return socket.emit('private_room_error', 'В комнате уже есть игрок!');
        if (room.host === socket) return socket.emit('private_room_error', 'Вы не можете подключиться к своей же комнате!');

        room.guest = socket;
        socket.privateRoomCode = room.code;

        createPendingRoom(room.host, room.guest, true, room.code);
        delete privateRooms[room.code]; // Удаляем из списка ожидания
    });

    // Подтверждение боя
    socket.on('accept_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'pending') return;
        room.accepted[socket.id] = true;
        socket.emit('waiting_for_opponent');
        if (room.accepted[room.p1] && room.accepted[room.p2]) {
            clearTimeout(room.acceptTimer);
            room.state = 'countdown';
            startCountdown(room.id);
        }
    });

    // Отказ от боя
    socket.on('decline_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'pending') return;
        
        if (!room.isPrivate && playersDB[socket.userId]) {
            playersDB[socket.userId].rating -= 15;
            savePlayer(socket.userId);
        }
        
        const opponentId = socket.id === room.p1 ? room.p2 : room.p1;
        const opponentSocket = io.sockets.sockets.get(opponentId);
        if (opponentSocket) { opponentSocket.emit('opponent_declined', 'Соперник отклонил игру.'); opponentSocket.roomId = null; }
        delete rooms[room.id];
    });

    // Ввод слова
    socket.on('submit_word', (data) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'playing' || !room.roundActive) return;
        const word = data.word.toLowerCase().trim();
        if (!DICTIONARY.has(word) || room.roundWords.includes(word)) return socket.emit('word_error', 'Нет слова или повтор!');
        let isValid = false;
        if (room.task.conditionType === 'startsWith') isValid = word.startsWith(room.task.conditionVal);
        else if (room.task.conditionType === 'endsWith') isValid = word.endsWith(room.task.conditionVal);
        else if (room.task.conditionType === 'contains') isValid = word.includes(room.task.conditionVal);
        if (!isValid) return socket.emit('word_error', 'Не подходит!');
        room.roundWords.push(word); room.players[socket.id].score++;
        socket.emit('word_success', word);
        io.to(room.id).emit('score_update', { p1Score: room.players[room.p1].score, p2Score: room.players[room.p2].score });
    });

    // Способности
    socket.on('use_ability', (type) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'playing' || !room.roundActive) return;
        const player = room.players[socket.id];
        if (!player.abilities[type]) return;
        player.abilities[type] = false;
        const opponentId = socket.id === room.p1 ? room.p2 : room.p1;
        const opponent = room.players[opponentId];
        if (type === 1 && room.task.conditionType === 'startsWith') {
            const l = letters[Math.floor(Math.random() * letters.length)];
            room.task.conditionVal = l; room.task.text = `Начинается на "${l.toUpperCase()}"`; room.timeLeft += 10;
            io.to(room.id).emit('task_update', room.task.text);
        } else if (type === 2) {
            room.task = generateTask(); room.timeLeft += 10; io.to(room.id).emit('task_update', room.task.text);
        } else if (type === 3 && opponent.score > 0) { opponent.score--; player.score++; room.timeLeft -= 3; }
        else if (type === 4 && opponent.score > 0) { opponent.score--; room.timeLeft -= 3; }
        io.to(room.id).emit('ability_used', { by: socket.id, type });
        io.to(room.id).emit('score_update', { p1Score: room.players[room.p1].score, p2Score: room.players[room.p2].score });
        io.to(room.id).emit('timer_update', room.timeLeft);
    });

    // Рейтинг
    socket.on('get_leaderboard', async () => {
        if (playersCollection) {
            const players = await playersCollection.find({}).sort({ rating: -1 }).limit(100).toArray();
            socket.emit('leaderboard_data', players);
        } else {
            const players = Object.values(playersDB).sort((a, b) => b.rating - a.rating).slice(0, 100);
            socket.emit('leaderboard_data', players);
        }
    });

    socket.on('disconnect', () => {
        const index = queue.indexOf(socket); if (index > -1) queue.splice(index, 1);
        if (socket.privateRoomCode && privateRooms[socket.privateRoomCode]) delete privateRooms[socket.privateRoomCode];
        if (socket.roomId && rooms[socket.roomId]) { io.to(socket.roomId).emit('opponent_left'); delete rooms[socket.roomId]; }
    });
});

function createPendingRoom(p1, p2, isPrivate = false, roomCode = null) {
    const roomId = `room_${Date.now()}`;
    p1.join(roomId); p2.join(roomId); p1.roomId = roomId; p2.roomId = roomId;
    rooms[roomId] = {
        id: roomId, p1: p1.id, p2: p2.id, isPrivate: isPrivate,
        players: {
            [p1.id]: { score: 0, lives: 3, abilities: { 1: true, 2: true, 3: true, 4: true } },
            [p2.id]: { score: 0, lives: 3, abilities: { 1: true, 2: true, 3: true, 4: true } }
        },
        state: 'pending',
        accepted: { [p1.id]: false, [p2.id]: false },
        round: 0
    };
    
    io.to(roomId).emit('match_found_pending', { 
        roomId, 
        p1Data: playersDB[p1.userId], 
        p2Data: playersDB[p2.userId],
        isPrivate: isPrivate
    });
    
    rooms[roomId].acceptTimer = setTimeout(() => {
        const room = rooms[roomId];
        if (!room || room.state !== 'pending') return;
        const p1Accepted = room.accepted[room.p1];
        const p2Accepted = room.accepted[room.p2];
        const p1Socket = io.sockets.sockets.get(room.p1);
        const p2Socket = io.sockets.sockets.get(room.p2);
        
        if (!isPrivate) {
            if (!p1Accepted && playersDB[p1Socket.userId]) { playersDB[p1Socket.userId].rating -= 15; savePlayer(p1Socket.userId); }
            if (!p2Accepted && playersDB[p2Socket.userId]) { playersDB[p2Socket.userId].rating -= 15; savePlayer(p2Socket.userId); }
        }
        
        io.to(roomId).emit('match_timeout', 'Вы не успели принять игру.');
        delete rooms[roomId];
    }, 10000);
}

function startCountdown(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    let count = 3;
    io.to(roomId).emit('countdown_start', count);
    const countdownInterval = setInterval(() => {
        count--;
        if (count > 0) io.to(roomId).emit('countdown_tick', count);
        else {
            clearInterval(countdownInterval);
            io.to(roomId).emit('countdown_end');
            room.state = 'playing';
            startRound(roomId);
        }
    }, 1000);
}

function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.roundWords = [];
    room.players[room.p1].score = 0; room.players[room.p2].score = 0;
    room.players[room.p1].abilities = { 1: true, 2: true, 3: true, 4: true };
    room.players[room.p2].abilities = { 1: true, 2: true, 3: true, 4: true };
    room.timeLeft = 15;
    room.roundActive = true;
    room.task = generateTask();
    io.to(roomId).emit('round_start', { taskText: room.task.text, time: 15 });
    clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timer_update', room.timeLeft);
        if (room.timeLeft <= 0) { clearInterval(room.timer); endRound(roomId); }
    }, 1000);
}

function endRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.roundActive = false;
    const s1 = room.players[room.p1].score, s2 = room.players[room.p2].score;
    let p1Lost = false, p2Lost = false;
    if (s1 > s2) p2Lost = true;
    else if (s2 > s1) p1Lost = true;
    else { p1Lost = true; p2Lost = true; }
    if (p1Lost) room.players[room.p1].lives--;
    if (p2Lost) room.players[room.p2].lives--;
    io.to(roomId).emit('round_end', { p1Lives: room.players[room.p1].lives, p2Lives: room.players[room.p2].lives, p1Score: s1, p2Score: s2 });

    if (room.players[room.p1].lives <= 0 || room.players[room.p2].lives <= 0) {
        const winner = room.players[room.p1].lives > 0 ? room.p1 : room.p2;
        const loser = room.players[room.p1].lives > 0 ? room.p2 : room.p1;
        
        if (!room.isPrivate) {
            const winnerSocket = io.sockets.sockets.get(winner);
            const loserSocket = io.sockets.sockets.get(loser);
            if (winnerSocket && playersDB[winnerSocket.userId]) { playersDB[winnerSocket.userId].rating += 25; savePlayer(winnerSocket.userId); }
            if (loserSocket && playersDB[loserSocket.userId]) { playersDB[loserSocket.userId].rating -= 15; savePlayer(loserSocket.userId); }
        }
        
        io.to(roomId).emit('game_over', { winnerId: winner, loserId: loser, isPrivate: room.isPrivate });
        delete rooms[roomId];
    } else {
        setTimeout(() => startRound(roomId), 3000);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
