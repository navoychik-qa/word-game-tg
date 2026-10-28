const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --- БАЗА ДАННЫХ (В ПАМЯТИ) ---
// В будущем замените это на MongoDB/PostgreSQL
const playersDB = {}; 
const queue = []; // Очередь на подбор
const rooms = {}; // Активные комнаты

const WORDS = ['слово', 'крыса', 'лампа', 'сок', 'дом']; // Заглушка (на сервере нужен полный словарь)

// --- ЛОГИКА ИГРЫ ---
io.on('connection', (socket) => {
    console.log('Подключился игрок:', socket.id);

    // 1. Авторизация (получаем данные от Telegram)
    socket.on('auth', (data) => {
        const userId = data.id;
        if (!playersDB[userId]) {
            playersDB[userId] = { id: userId, name: data.name || 'Игрок', rating: 1000 };
        }
        socket.userId = userId;
        socket.emit('auth_success', playersDB[userId]);
    });

    // 2. Поиск игры
    socket.on('find_match', () => {
        if (queue.includes(socket)) return;

        queue.push(socket);
        socket.emit('searching');

        // Если в очереди 2 человека - создаем комнату
        if (queue.length >= 2) {
            const p1 = queue.shift();
            const p2 = queue.shift();
            createRoom(p1, p2);
        }
    });

    // 3. Отмена поиска
    socket.on('cancel_search', () => {
        const index = queue.indexOf(socket);
        if (index > -1) queue.splice(index, 1);
    });

    // 4. Ввод слова в игре
    socket.on('submit_word', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const word = data.word.toLowerCase().trim();

        // Проверка: правильное ли слово (тут должна быть проверка по словарю)
        // Для теста пропускаем любое слово
        if (word.length > 2 && !room.roundWords.includes(word)) {
            room.roundWords.push(word);
            const player = room.players[socket.id];
            player.score++;
            
            io.to(roomId).emit('score_update', {
                p1Score: room.players[room.p1].score,
                p2Score: room.players[room.p2].score
            });
        }
    });

    // 5. Способности
    socket.on('use_ability', (type) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        io.to(socket.roomId).emit('ability_used', { by: socket.id, type });
    });

    // 6. Выход / Отключение
    socket.on('disconnect', () => {
        const index = queue.indexOf(socket);
        if (index > -1) queue.splice(index, 1);

        if (socket.roomId && rooms[socket.roomId]) {
            io.to(socket.roomId).emit('opponent_left');
            delete rooms[socket.roomId];
        }
    });
});

function createRoom(p1, p2) {
    const roomId = `room_${Date.now()}`;
    p1.join(roomId);
    p2.join(roomId);
    p1.roomId = roomId;
    p2.roomId = roomId;

    rooms[roomId] = {
        id: roomId,
        p1: p1.id,
        p2: p2.id,
        players: {
            [p1.id]: { score: 0, lives: 3, abilities: { 1: true, 2: true, 3: true, 4: true } },
            [p2.id]: { score: 0, lives: 3, abilities: { 1: true, 2: true, 3: true, 4: true } }
        },
        round: 1,
        roundWords: [],
        active: true
    };

    io.to(roomId).emit('match_found', {
        roomId,
        p1Data: playersDB[p1.userId],
        p2Data: playersDB[p2.userId]
    });

    startRound(roomId);
}

function startRound(roomId) {
    const room = rooms[roomId];
    room.roundWords = [];
    room.players[room.p1].score = 0;
    room.players[room.p2].score = 0;
    room.timeLeft = 15;

    io.to(roomId).emit('round_start', { letter: 'К', condition: 'Начинается на К', time: 15 });

    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timer_update', room.timeLeft);

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            endRound(roomId);
        }
    }, 1000);
}

function endRound(roomId) {
    const room = rooms[roomId];
    const s1 = room.players[room.p1].score;
    const s2 = room.players[room.p2].score;

    let p1Lost = false, p2Lost = false;

    if (s1 > s2) p2Lost = true;
    else if (s2 > s1) p1Lost = true;
    else { p1Lost = true; p2Lost = true; }

    if (p1Lost) room.players[room.p1].lives--;
    if (p2Lost) room.players[room.p2].lives--;

    io.to(roomId).emit('round_end', {
        p1Lives: room.players[room.p1].lives,
        p2Lives: room.players[room.p2].lives,
        p1Score: s1,
        p2Score: s2
    });

    if (room.players[room.p1].lives <= 0 || room.players[room.p2].lives <= 0) {
        // Конец игры
        const winner = room.players[room.p1].lives > 0 ? room.p1 : room.p2;
        io.to(roomId).emit('game_over', { winnerId: winner });
        delete rooms[roomId];
    } else {
        setTimeout(() => startRound(roomId), 3000);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});