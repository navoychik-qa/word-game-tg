<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>Word Battle</title>
    <!-- Подключаем Telegram SDK -->
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--tg-theme-bg-color, #ffffff);
            color: var(--tg-theme-text-color, #000000);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
            text-align: center;
        }
        .card {
            background-color: var(--tg-theme-secondary-bg-color, #f0f0f0);
            padding: 24px;
            border-radius: 16px;
            width: 100%;
            max-width: 320px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        h1 {
            font-size: 24px;
            margin-bottom: 12px;
        }
        p {
            font-size: 16px;
            margin-bottom: 24px;
        }
        button {
            background-color: var(--tg-theme-button-color, #2481cc);
            color: var(--tg-theme-button-text-color, #ffffff);
            border: none;
            padding: 14px 20px;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            width: 100%;
            cursor: pointer;
        }
        button:active {
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="card">
        <h1 id="greeting">Привет!</h1>
        <p>Это тестовый запуск моей игры в Telegram.</p>
        <button id="mainBtn">Нажми меня</button>
    </div>

    <script>
        // Инициализируем Telegram Web App
        let tg = window.Telegram.WebApp;
        tg.ready();
        tg.expand(); // Разворачиваем на весь экран

        // Получаем имя пользователя из Telegram
        let user = tg.initDataUnsafe?.user;
        if (user) {
            document.getElementById('greeting').innerText = `Привет, ${user.first_name}!`;
        }

        // Обработка нажатия на кнопку
        document.getElementById('mainBtn').addEventListener('click', () => {
            // Включаем вибрацию (если поддерживается телефоном)
            tg.HapticFeedback.impactOccurred('medium');
            // Показываем всплывающее сообщение Telegram
            tg.showAlert('Ура! Кнопка работает. Теперь здесь будет игра!');
        });
    </script>
</body>
</html>
