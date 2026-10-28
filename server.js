const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const playersDB = {}; 
const queue = []; 
const rooms = {};

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
} catch (e) {
    console.error('Ошибка словаря:', e);
}

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

io.on('connection', (socket) => {
    socket.on('auth', (data) => {
        if (!playersDB[data.id]) playersDB[data.id] = { id: data.id, name: data.name || 'Игрок', rating: 1000 };
        socket.userId = data.id;
        socket.emit('auth_success', playersDB[data.id]);
    });

    socket.on('find_match', () => {
        if (queue.includes(socket)) return;
        queue.push(socket);
        socket.emit('searching');

        if (queue.length >= 2) {
            const p1 = queue.shift();
            const p2 = queue.shift();
            createPendingRoom(p1, p2);
        }
    });

    socket.on('cancel_search', () => {
        const index = queue.indexOf(socket);
        if (index > -1) queue.splice(index, 1);
    });

    // Принятие игры
    socket.on('accept_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'pending') return;
        room.accepted[socket.id] = true;
        
        socket.emit('waiting_for_opponent');

        // Если оба приняли
        if (room.accepted[room.p1] && room.accepted[room.p2]) {
            clearTimeout(room.acceptTimer);
            room.state = 'countdown';
            startCountdown(room.id);
        }
    });

    // Отклонение игры
    socket.on('decline_game', () => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'pending') return;

        // Штраф тому, кто отклонил
        if (playersDB[socket.userId]) {
            playersDB[socket.userId].rating -= 15;
            socket.emit('rating_updated', playersDB[socket.userId].rating);
        }

        // Уведомляем второго
        const opponentId = socket.id === room.p1 ? room.p2 : room.p1;
        const opponentSocket = io.sockets.sockets.get(opponentId);
        if (opponentSocket) {
            opponentSocket.emit('opponent_declined', 'Соперник отклонил игру. Вам засчитана победа (рейтинг не изменен).');
            opponentSocket.leave(room.id);
            opponentSocket.roomId = null;
        }

        delete rooms[room.id];
    });

    socket.on('submit_word', (data) => {
        const room = rooms[socket.roomId];
        if (!room || room.state !== 'playing' || !room.roundActive) return;

        const word = data.word.toLowerCase().trim();
        const player = room.players[socket.id];

        if (!DICTIONARY.has(word)) return socket.emit('word_error', 'Нет такого слова!');
        if (room.roundWords.includes(word)) return socket.emit('word_error', 'Уже вводили!');

        let isValid = false;
        if (room.task.conditionType === 'startsWith') isValid = word.startsWith(room.task.conditionVal);
        else if (room.task.conditionType === 'endsWith') isValid = word.endsWith(room.task.conditionVal);
        else if (room.task.conditionType === 'contains') isValid = word.includes(room.task.conditionVal);

        if (!isValid) return socket.emit('word_error', 'Не подходит под условие!');

        room.roundWords.push(word);
        player.score++;
        socket.emit('word_success', word);
        io.to(room.id).emit('score_update', { p1Score: room.players[room.p1].score, p2Score: room.players[room.p2].score });
    });

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
            room.task.conditionVal = l; room.task.text = `Начинается на "${l.toUpperCase()}"`;
            room.timeLeft += 10; io.to(room.id).emit('task_update', room.task.text);
        } else if (type === 2) {
            room.task = generateTask(); room.timeLeft += 10;
            io.to(room.id).emit('task_update', room.task.text);
        } else if (type === 3 && opponent.score > 0) {
            opponent.score--; player.score++; room.timeLeft -= 3;
        } else if (type === 4 && opponent.score > 0) {
            opponent.score--; room.timeLeft -= 3;
        }

        io.to(room.id).emit('ability_used', { by: socket.id, type });
        io.to(room.id).emit('score_update', { p1Score: room.players[room.p1].score, p2Score: room.players[room.p2].score });
        io.to(room.id).emit('timer_update', room.timeLeft);
    });

    socket.on('disconnect', () => {
        const index = queue.indexOf(socket);
        if (index > -1) queue.splice(index, 1);
        if (socket.roomId && rooms[socket.roomId]) {
            io.to(socket.roomId).emit('opponent_left');
            delete rooms[socket.roomId];
        }
    });
});

function createPendingRoom(p1, p2) {
    const roomId = `room_${Date.now()}`;
    p1.join(roomId); p2.join(roomId);
    p1.roomId = roomId; p2.roomId = roomId;

    rooms[roomId] = {
        id: roomId, p1: p1.id, p2: p2.id,
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
        p2Data: playersDB[p2.userId]
    });

    // Таймер на принятие (10 секунд). Если не успели - штраф.
    rooms[roomId].acceptTimer = setTimeout(() => {
        const room = rooms[roomId];
        if (!room || room.state !== 'pending') return;

        // Штрафуем тех, кто не принял
        const p1Accepted = room.accepted[room.p1];
        const p2Accepted = room.accepted[room.p2];
        
        const p1Socket = io.sockets.sockets.get(room.p1);
        const p2Socket = io.sockets.sockets.get(room.p2);

        if (!p1Accepted && playersDB[p1Socket.userId]) {
            playersDB[p1Socket.userId].rating -= 15;
            p1Socket.emit('rating_updated', playersDB[p1Socket.userId].rating);
        }
        if (!p2Accepted && playersDB[p2Socket.userId]) {
            playersDB[p2Socket.userId].rating -= 15;
            p2Socket.emit('rating_updated', playersDB[p2Socket.userId].rating);
        }

        io.to(roomId).emit('match_timeout', 'Вы не успели принять игру. -15 рейтинга.');
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
        if (count > 0) {
            io.to(roomId).emit('countdown_tick', count);
        } else {
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
        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            endRound(roomId);
        }
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

    io.to(roomId).emit('round_end', {
        p1Lives: room.players[room.p1].lives, p2Lives: room.players[room.p2].lives,
        p1Score: s1, p2Score: s2
    });

    if (room.players[room.p1].lives <= 0 || room.players[room.p2].lives <= 0) {
        const winner = room.players[room.p1].lives > 0 ? room.p1 : room.p2;
        const loser = room.players[room.p1].lives > 0 ? room.p2 : room.p1;
        
        // Начисление рейтинга в БД
        const winnerSocket = io.sockets.sockets.get(winner);
        const loserSocket = io.sockets.sockets.get(loser);
        if (winnerSocket && playersDB[winnerSocket.userId]) playersDB[winnerSocket.userId].rating += 25;
        if (loserSocket && playersDB[loserSocket.userId]) playersDB[loserSocket.userId].rating -= 15;

        io.to(roomId).emit('game_over', { winnerId: winner, loserId: loser });
        delete rooms[roomId];
    } else {
        setTimeout(() => startRound(roomId), 3000);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
