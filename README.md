# MangaBuff Scraper — Установка и запуск на Ubuntu (VPS)

Короткий гайд по развёртыванию и запуску `scraper-v2.js` на Ubuntu VDS.

**Содержание:**
- Подготовка сервера
- Клонирование репозитория
- Установка Node.js и зависимостей
- Установка Playwright и системных библиотек
- Подготовка аккаунтов (`scraper-accounts.json`)
- Запуск (тестовый и в фоне с tmux / pm2)
- Отладка и полезные команды

---

**1. Подготовка системы**

Подключитесь к серверу по SSH:

```bash
ssh root@YOUR_VPS_IP
```
Появляется окно password:
Введите пароль

Обновите систему:

```bash
sudo apt update && sudo apt upgrade -y
```

Установите базовые утилиты:

```bash
sudo apt install -y git curl build-essential ca-certificates
```

---

**2. Клонирование репозитория**

```bash
cd ~
git clone https://github.com/YOUR_USER/REPO.git ubuntaSc
cd ubuntaSc
```

Или если вы используете SSH-ключи:

```bash
git clone git@github.com:YOUR_USER/REPO.git ubuntaSc
```

---

**3. Установка Node.js (рекомендуется через NVM)**

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.bashrc
nvm install --lts
nvm use --lts
node -v && npm -v
```

Если не хотите NVM — установите `node` пакетным менеджером Ubuntu (менее предпочтительно).

---

**4. Установка зависимостей проекта и Playwright**

В каталоге репозитория:

```bash
npm install
# Установить браузер для Playwright
npx playwright install chromium
# (на Ubuntu) установить системные зависимости
npx playwright install-deps chromium
```

---

**5. Подготовка аккаунтов (cookies)**

Файл `scraper-accounts.json` содержит сохранённые cookies/CSRF для аккаунтов. По безопасности он добавлен в `.gitignore` — не пушьте его в репозиторий.

Варианты получения `scraper-accounts.json`:
- Запустить `node scraper-v2.js --setup` локально на вашей машине, выполнить логин в браузере и получить файл, затем скопировать на сервер через `scp`/SFTP.
- Если VPS имеет GUI / X11-forwarding — можно запустить `--setup` напрямую на сервере.

Копирование файла с локальной машины:

```powershell
scp C:\path\to\scraper-accounts.json root@YOUR_VPS_IP:~/ubuntaSc/
```

После копирования на сервер задайте безопасные права:

```bash
chmod 600 ~/ubuntaSc/scraper-accounts.json
```

---

**6. Тестовый прогон**

Запустите небольшой тест, чтобы убедиться, что всё работает:

```bash
cd ~/ubuntaSc
node scraper-v2.js --from=1 --to=5 --headless --no-proxy --reset
```

Проверьте `scraper_progress.json` и папку `debug/` при ошибках.

---

**7. Запуск в фоне: tmux**

Установите `tmux` и запустите сессию, если хотите периодически подключаться к живой консоли:

```bash
sudo apt install -y tmux
tmux new -s scraper
# внутри сессии
cd ~/ubuntaSc
node scraper-v2.js --headless 
# Отсоединиться: Ctrl+B, D
tmux attach -t scraper   # чтобы вернуться
```

`tmux` сохраняет процессы при отключении SSH.

---

**8. Запуск как демон: pm2 (опционально)**

Установите `pm2` и запустите процесс под управлением PM2:

```bash
npm install -g pm2
pm2 start scraper-v2.js --name scraper --node-args="" -- --headless --no-proxy
pm2 save
pm2 startup
pm2 logs scraper
```

Это удобнее для автоматического рестарта и автозапуска при перезагрузке.

---

**9. Полезные команды и отладка**

- Просмотр логов в реальном времени: `pm2 logs scraper` или `tail -f debug/card_1/wanted-page.html` и т.п.
- Просмотр прогресса: `cat scraper_progress.json`
- Остановка PM2: `pm2 stop scraper`, удаление: `pm2 delete scraper`
- Состояние tmux: `tmux ls`, присоединение: `tmux attach -t scraper`

---

**10. Безопасность**

- Не храните `scraper-accounts.json` в публичном доступе