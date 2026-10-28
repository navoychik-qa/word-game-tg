<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Word Battle</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        :root {
            --bg: var(--tg-theme-bg-color, #ffffff);
            --text: var(--tg-theme-text-color, #000000);
            --hint: var(--tg-theme-hint-color, #999999);
            --btn: var(--tg-theme-button-color, #2481cc);
            --btn-text: var(--tg-theme-button-text-color, #ffffff);
            --secondary-bg: var(--tg-theme-secondary-bg-color, #f1f1f1);
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            margin: 0;
            padding: 20px;
            display: flex;
            flex-direction: column;
            align-items: center;
            height: 100vh;
            box-sizing: border-box;
        }
        .screen { display: none; width: 100%; max-width: 400px; flex-direction: column; height: 100%; }
        .screen.active { display: flex; }
        
        /* Меню */
        .menu-title { font-size: 32px; font-weight: bold; text-align: center; margin-top: 40px; margin-bottom: 40px; }
        .btn {
            background-color: var(--btn); color: var(--btn-text);
            border: none; padding: 16px; border-radius: 12px;
            font-size: 18px; font-weight: 600; margin-bottom: 16px; cursor: pointer;
            transition: opacity 0.2s;
        }
        .btn:active { opacity: 0.8; }
        .btn:disabled { opacity: 0.5; background-color: var(--hint); }

        /* Игра */
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .back-btn { background: none; border: none; font-size: 24px; cursor: pointer; color: var(--text); }
        .level-info { font-size: 18px; font-weight: bold; }
        
        .task-card {
            background-color: var(--secondary-bg); padding: 20px; border-radius: 16px;
            text-align: center; margin-bottom: 20px;
        }
        .task-title { font-size: 16px; color: var(--hint); margin-bottom: 8px; }
        .task-word { font-size: 24px; font-weight: bold; color: var(--btn); }
        
        .input-group { display: flex; gap: 10px; margin-bottom: 20px; }
        input {
            flex: 1; padding: 16px; border-radius: 12px; border: 1px solid var(--hint);
            background-color: var(--bg); color: var(--text); font-size: 16px; outline: none;
        }
        .submit-btn {
            background-color: var(--btn); color: var(--btn-text); border: none;
            padding: 0 20px; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer;
        }

        .words-list { flex: 1; overflow-y: auto; }
        .word-item {
            background-color: var(--secondary-bg); padding: 12px 16px; border-radius: 8px;
            margin-bottom: 8px; font-size: 16px; display: flex; justify-content: space-between;
        }
        .word-item span:last-child { color: #4CAF50; font-weight: bold; }
        
        .progress { font-size: 14px; color: var(--hint); text-align: center; margin-top: 10px; }
    </style>
</head>
<body>

    <!-- ЭКРАН 1: Главное меню -->
    <div id="screen-menu" class="screen active">
        <div class="menu-title">Word Battle</div>
        <button class="btn" onclick="startSingleGame()">Одиночный режим</button>
        <button class="btn" onclick="tg.showAlert('Режим 1 на 1 скоро появится!')">Один на один</button>
    </div>

    <!-- ЭКРАН 2: Одиночная игра -->
    <div id="screen-game" class="screen">
        <div class="header">
            <button class="back-btn" onclick="goToMenu()">←</button>
            <div class="level-info" id="level-display">Уровень 1</div>
            <div style="width: 24px;"></div> <!-- Заглушка для центрирования -->
        </div>

        <div class="task-card">
            <div class="task-title">Твоё задание:</div>
            <div class="task-word" id="current-task">Начинается на "К"</div>
        </div>

        <div class="input-group">
            <input type="text" id="word-input" placeholder="Введи слово..." autocomplete="off">
            <button class="submit-btn" onclick="checkWord()">→</button>
        </div>

        <div class="words-list" id="words-container">
            <!-- Сюда будут добавляться введенные слова -->
        </div>
        
        <div class="progress" id="progress-text">Введено: 0 / 3</div>
    </div>

    <script>
        const tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand();

        // --- ЛОГИКА ИГРЫ ---
        let currentLevel = 1;
        let targetWordsCount = 3;
        let enteredWords = [];
        let currentTask = { type: 'startsWith', letter: 'к', text: 'Начинается на "К"' };

        function switchScreen(screenId) {
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById(screenId).classList.add('active');
        }

        function goToMenu() {
            tg.HapticFeedback.impactOccurred('light');
            switchScreen('screen-menu');
            resetLevel();
        }

        function startSingleGame() {
            tg.HapticFeedback.impactOccurred('medium');
            switchScreen('screen-game');
            resetLevel();
        }

        function resetLevel() {
            enteredWords = [];
            currentLevel = 1;
            targetWordsCount = 3;
            currentTask = { type: 'startsWith', letter: 'к', text: 'Начинается на "К"' };
            document.getElementById('words-container').innerHTML = '';
            document.getElementById('word-input').value = '';
            updateUI();
        }

        function updateUI() {
            document.getElementById('level-display').innerText = `Уровень ${currentLevel}`;
            document.getElementById('current-task').innerText = currentTask.text;
            document.getElementById('progress-text').innerText = `Введено: ${enteredWords.length} / ${targetWordsCount}`;
        }

        function checkWord() {
            const input = document.getElementById('word-input');
            const word = input.value.trim().toLowerCase();
            
            if (!word) return;

            // Простая проверка (пока только на клиенте)
            let isValid = false;
            if (currentTask.type === 'startsWith') {
                isValid = word.startsWith(currentTask.letter);
            }

            if (!isValid) {
                tg.HapticFeedback.notificationOccurred('error');
                tg.showAlert('Слово не подходит под условие!');
                return;
            }

            if (enteredWords.includes(word)) {
                tg.HapticFeedback.notificationOccurred('warning');
                tg.showAlert('Ты уже вводил это слово!');
                return;
            }

            // Слово подошло
            tg.HapticFeedback.notificationOccurred('success');
            enteredWords.push(word);
            input.value = ''; // Очищаем поле
            
            // Добавляем слово в список на экране
            const wordItem = document.createElement('div');
            wordItem.className = 'word-item';
            wordItem.innerHTML = `<span>${word}</span> <span>+1</span>`;
            document.getElementById('words-container').prepend(wordItem);

            updateUI();

            // Проверка на победу
            if (enteredWords.length >= targetWordsCount) {
                setTimeout(() => {
                    tg.showAlert('Уровень пройден!');
                    // Здесь потом сделаем переход на следующий уровень
                }, 300);
            }
        }

        // Обработка нажатия Enter на клавиатуре
        document.getElementById('word-input').addEventListener('keypress', function (e) {
            if (e.key === 'Enter') {
                checkWord();
            }
        });
    </script>
</body>
</html>
