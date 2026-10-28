const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// --- БАЗА ДАННЫХ ---
const playersDB = {}; 
const queue = []; 
const rooms = {};

// --- ЗАГРУЗКА СЛОВАРЯ ---
let DICTIONARY = new Set();
try {
    const wordsPath = path.join(__dirname, 'words.txt');
    if (fs.existsSync(wordsPath)) {
        const data = fs.readFileSync(wordsPath, 'utf8');
        const words = data.split(/\r?\n/).map(w => w.trim().toLowerCase()).filter(w => w.length > 1);
        DICTIONARY = new Set(words);
        console.log(`Словарь загружен. Слов: ${DICTIONARY.size}`);
    } else {
        console.log('words.txt не найден. Используется тестовый словарь.');
        // Заглушка, если нет файла
        DICTIONARY = new Set(['крыса', 'лампа', 'сок', 'дом', 'кот', 'собака', 'привет', 'слово', 'корова', 'молоко', 'сметана']);
    }
} catch (e) {
    console.error('Ошибка загрузки словаря', e);
}

// --- ГЕНЕРАТОР ЗАДАНИЙ ---
const letters = 'абвгдежзиклмнопрстуфхцчшщэюя';
const vowels = 'аеиоуыэюя';
const consonants = 'бвгджзклмнпрстфхцчшщ';

function generateTask() {
    const type = Math.floor(Math.random() * 3); // 0 - start, 1 - end, 2 - contains
    let text = '';
    let conditionType = '';
    let conditionVal = '';

    if (type === 0) {
        const l = letters[Math.floor(Math.random() * letters.length)];
        conditionType = 'startsWith';
        conditionVal = l;
        text = `Начинается на "${l.toUpperCase()}"`;
    } else if (type === 1) {
        const l = vowels[Math.floor(Math.random() * vowels.length)];
        conditionType = 'endsWith';
        conditionVal = l;
        text = `Заканчивается на "${l.toUpperCase()}"`;
    } else {
        const l = consonants[Math.floor(Math.random() * consonants.length)];
        conditionType = 'contains';
        conditionVal = l;
        text = `Содержит букву "${l.toUpperCase()}"`;
    }
    return { conditionType, conditionVal, text };
}

// --- ЛОГИКА ИГРЫ ---
io.on('connection', (socket) => {
    console.log('Подключился:', socket.id);

    socket.on('auth', (data) => {
        const userId = data.id;
        if (!playersDB[userId]) {
            playersDB[userId] = { id: userId, name: data.name || 'Игрок', rating: 1000 };
        }
        socket.userId = userId;
        socket.emit('auth_success', playersDB[userId]);
    });

    socket.on('find_match', () => {
        if (queue.includes(socket)) return;

        queue.push(socket);
        socket.emit('searching');

        if (queue.length >= 2) {
            const p1 = queue.shift();
            const p2 = queue.shift();
            createRoom(p1, p2);
        }
    });

    socket.on('cancel_search', () => {
        const index = queue.indexOf(socket);
        if (index > -1) queue.splice(index, 1);
    });

    socket.on('submit_word', (data) => {
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId] || !rooms[roomId].roundActive) return;

        const room = rooms[roomId];
        const word = data.word.toLowerCase().trim();
        const player = room.players[socket.id];

        // 1. Проверка по словарю
        if (!DICTIONARY.has(word)) {
            socket.emit('word_error', 'Такого слова нет в словаре!');
            return;
        }

        // 2. Проверка на повтор
        if (room.roundWords.includes(word)) {
            socket.emit('word_error', 'Слово уже введено в этом раунде!');
            return;
        }

        // 3. Проверка условия
        let isValid = false;
        if (room.task.conditionType === 'startsWith') isValid = word.startsWith(room.task.conditionVal);
        else if (room.task.conditionType === 'endsWith') isValid = word.endsWith(room.task.conditionVal);
        else if (room.task.conditionType === 'contains') isValid = word.includes(room.task.conditionVal);

        if (!isValid) {
            socket.emit('word_error', 'Слово не подходит под условие!');
            return;
        }

        // Успех
        room.roundWords.push(word);
        player.score++;
        socket.emit('word_success', word);
        
        io.to(roomId).emit('score_update', {
            p1Score: room.players[room.p1].score,
            p2Score: room.players[room.p2].score
        });
    });

    socket.on('use_ability', (type) => {
        const room = rooms[socket.roomId];
        if (!room || !room.roundActive) return;
        
        const player = room.players[socket.id];
        if (!player.abilities[type]) return; // Уже использовал

        player.abilities[type] = false;
        const opponentId = socket.id === room.p1 ? room.p2 : room.p1;
        const opponent = room.players[opponentId];

        if (type === 1) {
            // Смена буквы (только для startsWith)
            if (room.task.conditionType === 'startsWith') {
                const l = letters[Math.floor(Math.random() * letters.length)];
                room.task.conditionVal = l;
                room.task.text = `Начинается на "${l.toUpperCase()}"`;
            }
            room.timeLeft += 10;
            io.to(room.id).emit('task_update', room.task.text);
        } 
        else if (type === 2) {
            // Смена условия
            const newTask = generateTask();
            room.task = newTask;
            room.timeLeft += 10;
            io.to(room.id).emit('task_update', room.task.text);
        }
        else if (type === 3) {
            // Украсть слово
            if (opponent.score > 0) {
                opponent.score--;
                player.score++;
            }
            room.timeLeft -= 3;
        }
        else if (type === 4) {
            // Стереть слово
            if (opponent.score > 0) {
                opponent.score--;
            }
            room.timeLeft -= 3;
        }

        io.to(room.id).emit('ability_used', { by: socket.id, type: type });
        io.to(room.id).emit('score_update', {
            p1Score: room.players[room.p1].score,
            p2Score: room.players[room.p2].score
        });
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
        roundActive: false,
        timeLeft: 15
    };

    io.to(roomId).emit('match_found', {
        roomId,
        p1Data: playersDB[p1.userId],
        p2Data: playersDB[p2.userId]
    });

    setTimeout(() => startRound(roomId), 1000);
}

function startRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    // Сброс на новый раунд
    room.roundWords = [];
    room.players[room.p1].score = 0;
    room.players[room.p2].score = 0;
    room.players[room.p1].abilities = { 1: true, 2: true, 3: true, 4: true };
    room.players[room.p2].abilities = { 1: true, 2: true, 3: true, 4: true };
    room.timeLeft = 15;
    room.roundActive = true;
    room.task = generateTask();

    io.to(roomId).emit('round_start', {
        taskText: room.task.text,
        time: 15
    });

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
        const winner = room.players[room.p1].lives > 0 ? room.p1 : room.p2;
        const loser = room.players[room.p1].lives > 0 ? room.p2 : room.p1;
        
        // Начисление рейтинга
        playersDB[room.players[winner] ? winner : p1.id]; // Заглушка, чтобы не падало
        io.to(roomId).emit('game_over', { winnerId: winner, loserId: loser });
        delete rooms[roomId];
    } else {
        setTimeout(() => startRound(roomId), 3000);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
