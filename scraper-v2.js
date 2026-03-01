/**
 * MangaBuff Scraper v2.0  (Playwright edition)
 * Поддержка множества прокси и аккаунтов
 * Запись в Supabase через REST API
 *
 * Установка (Ubuntu 24.04):
 *   npm install playwright jsdom axios dotenv
 *   npx playwright install chromium
 *   npx playwright install-deps chromium   # системные зависимости
 *
 * Использование:
 *   node scraper-v2.js                    # Обычный запуск
 *   node scraper-v2.js --setup            # Настройка аккаунтов (логин)
 *   node scraper-v2.js --workers=3        # Запуск с 3 воркерами
 *   node scraper-v2.js --from=1000        # Начать с карты 1000
 *   node scraper-v2.js --to=5000          # Закончить на карте 5000
 *   node scraper-v2.js --headless         # Headless-режим
 *   node scraper-v2.js --no-proxy         # Запуск без прокси (игнорирует конфиг)
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const axios = require('axios');

// ==================== КОНФИГУРАЦИЯ ====================

const CONFIG_FILE = 'scraper-config.json';
const PROGRESS_FILE = 'scraper_progress.json';
const BLACKLIST_FILE = 'scraper_blacklist.json';
const FAILED_FILE = 'failed_cards.json';
const ACCOUNTS_FILE = 'scraper-accounts.json';

let config = {
  supabase: {
    url: 'https://qwrgjwbitlcdapmpmrhv.supabase.co',
    key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3cmdqd2JpdGxjZGFwbXBtcmh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5NzgzMTYsImV4cCI6MjA4NDU1NDMxNn0.0CCfM5YWoAJBXOnNkat0_rxkatONi4GF2KodYXIBnRk'
  },
  scraping: {
    maxCardId: 346231,
    batchSize: 100,
    delayMin: 50,
    delayMax: 300,
    saveProgressEvery: 10,
    retryAttempts: 3,
    timeout: 60000
  },
  proxies: [],
  workers: {
    count: 1,
    cardsPerWorker: 1000
  }
};

let accounts = [];
let headlessMode = false; // set by --headless or env HEADLESS=true
let noProxy = false;     // set by --no-proxy

// ==================== УТИЛИТЫ ====================

const log = (workerId, msg, ...args) => {
  const prefix = workerId !== null ? `[Worker ${workerId}]` : '[Main]';
  console.log(`${new Date().toISOString()} ${prefix} ${msg}`, ...args);
};

const logError = (workerId, msg, ...args) => {
  const prefix = workerId !== null ? `[Worker ${workerId}]` : '[Main]';
  console.error(`${new Date().toISOString()} ${prefix} ERROR: ${msg}`, ...args);
};

const logWarn = (workerId, msg, ...args) => {
  const prefix = workerId !== null ? `[Worker ${workerId}]` : '[Main]';
  console.warn(`${new Date().toISOString()} ${prefix} WARN: ${msg}`, ...args);
};

/**
 * Ensure Playwright Chromium is available.
 * On first run execute: npx playwright install chromium
 * Returns the executable path if found, or null to let Playwright use its default.
 */
async function ensureChromiumInstalled(workerId) {
  // If user explicitly set a custom browser, use it
  if (process.env.BROWSER_EXECUTABLE || process.env.THORIUM_EXECUTABLE) {
    return process.env.BROWSER_EXECUTABLE || process.env.THORIUM_EXECUTABLE;
  }

  // Check if Playwright Chromium is already installed
  try {
    const ep = chromium.executablePath();
    if (ep && fs.existsSync(ep)) {
      log(workerId, `Using Playwright Chromium at ${ep}`);
      return ep;
    }
  } catch (e) { /* not installed yet */ }

  // Auto-install Playwright Chromium
  const lockPath = path.join(process.cwd(), '.chromium_download.lock');
  let lockAcquired = false;

  try {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.closeSync(fd);
      lockAcquired = true;
      log(workerId, 'Acquired chromium download lock');
    } catch (lockErr) {
      // Another worker is installing — wait
      log(workerId, 'Waiting for existing Playwright Chromium install to finish...');
      const start = Date.now();
      while (fs.existsSync(lockPath)) {
        if (Date.now() - start > 5 * 60 * 1000) throw new Error('Timeout waiting for chromium download lock');
        await new Promise(r => setTimeout(r, 2000));
      }
      return null; // Assume peer worker completed the install
    }

    const { execSync } = require('child_process');
    log(workerId, 'Installing Playwright Chromium via npx playwright install chromium (may take a while)...');
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    log(workerId, 'Playwright Chromium installation completed');
  } catch (err) {
    logError(workerId, `Auto-install failed: ${err.message}`);
    throw new Error(`${err.message}. Run \`npx playwright install chromium\` manually.`);
  } finally {
    if (lockAcquired && fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  }

  return null; // Playwright will locate the freshly installed browser
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const randomDelay = () => {
  const { delayMin, delayMax } = config.scraping;
  return delayMin + Math.random() * (delayMax - delayMin);
};

// Загрузка конфигурации
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    config = { ...config, ...loaded };
    log(null, 'Config loaded from', CONFIG_FILE);
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    log(null, 'Default config created:', CONFIG_FILE);
  }

  // Allow overriding Supabase credentials via environment variables (e.g., .env)
  if (process.env.SUPABASE_URL) config.supabase.url = process.env.SUPABASE_URL;
  if (process.env.SUPABASE_KEY) config.supabase.key = process.env.SUPABASE_KEY;
} 

// Загрузка аккаунтов
function loadAccounts() {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    log(null, `Loaded ${accounts.length} account(s)`);
  }
}

// Сохранение аккаунтов
function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  log(null, 'Accounts saved to', ACCOUNTS_FILE);
}

// ========= Blacklist helpers =========
function loadBlacklist() {
  try {
    if (fs.existsSync(BLACKLIST_FILE)) {
      const raw = fs.readFileSync(BLACKLIST_FILE, 'utf8');
      const arr = JSON.parse(raw || '[]');
      return new Set(arr.map(x => String(x)));
    }
  } catch (e) { /* ignore */ }
  return new Set();
}

function addToBlacklist(id) {
  try {
    const bs = loadBlacklist();
    bs.add(String(id));
    const tmp = BLACKLIST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...bs], null, 2));
    fs.renameSync(tmp, BLACKLIST_FILE);
    log(null, `Added ${id} to blacklist`);
  } catch (e) {
    logError(null, `Failed to add ${id} to blacklist: ${e.message}`);
  }
}

function isBlacklisted(id) {
  const bs = loadBlacklist();
  return bs.has(String(id));
}

// ========= Failed cards helpers (file-based) =========
function loadFailed() {
  try {
    if (fs.existsSync(FAILED_FILE)) {
      const raw = fs.readFileSync(FAILED_FILE, 'utf8');
      const obj = JSON.parse(raw || '{}');
      return obj; // { id: { attempts, lastError, lastTry } }
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveFailed(obj) {
  try {
    const tmp = FAILED_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, FAILED_FILE);
    return true;
  } catch (e) {
    logError(null, `Failed to save failed list: ${e.message}`);
    return false;
  }
}

function addToFailed(id, errMsg) {
  try {
    const f = loadFailed();
    const key = String(id);
    const prev = f[key] || { attempts: 0, lastError: null, lastTry: null };
    prev.attempts = (prev.attempts || 0) + 1;
    prev.lastError = String(errMsg).slice(0, 200);
    prev.lastTry = new Date().toISOString();
    f[key] = prev;
    saveFailed(f);
    log(null, `Added/updated failed card ${id} attempts=${prev.attempts}`);
  } catch (e) {
    logError(null, `Failed to add failed card ${id}: ${e.message}`);
  }
}

function removeFromFailed(id) {
  try {
    const f = loadFailed();
    const key = String(id);
    if (f[key]) {
      delete f[key];
      saveFailed(f);
      log(null, `Removed ${id} from failed list`);
    }
  } catch (e) {
    logError(null, `Failed to remove failed card ${id}: ${e.message}`);
  }
}


// Получение прокси для воркера (round-robin)
function getProxyForWorker(workerId) {
  const enabledProxies = config.proxies.filter(p => p.enabled);
  if (enabledProxies.length === 0) return null;
  return enabledProxies[workerId % enabledProxies.length];
}

// Получение аккаунта для воркера (round-robin)
function getAccountForWorker(workerId) {
  const enabledAccounts = accounts.filter(a => a.enabled && a.cookies);
  if (enabledAccounts.length === 0) return null;
  return enabledAccounts[workerId % enabledAccounts.length];
}

// Нормализация proxy записи из конфигурации
function normalizeProxyEntry(proxyEntry) {
  // proxyEntry может быть строкой или объектом { url, enabled }
  let raw = proxyEntry;
  if (typeof proxyEntry === 'object' && proxyEntry !== null) raw = proxyEntry.url || '';
  raw = String(raw || '').trim();
  if (!raw) return null;

  // Добавим схему по умолчанию http если не указана
  let urlStr = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    urlStr = 'http://' + raw;
  }

  try {
    const u = new URL(urlStr);
    let protocol = u.protocol.replace(':','');
    const pnum = parseInt(u.port || (u.protocol === 'https:' ? '443' : '80'), 10);

    // Если явно указано socks (socks5://...), оставляем
    // Иначе попробуем угадать SOCKS по стандартным портам
    const maybeSocksPorts = [1080, 1081, 4145, 10808, 1090, 2030, 6167];
    if ((protocol === 'http' || protocol === '') && maybeSocksPorts.includes(pnum)) {
      protocol = 'socks5';
    }

    return {
      protocol,
      host: u.hostname,
      port: String(pnum),
      username: u.username || null,
      password: u.password || null,
      rawUrl: raw,
      url: urlStr
    };
  } catch (e) {
    return null;
  }
}

// ==================== ПАРСИНГ ====================

function getLastPageNumber(doc) {
  const paginationButtons = doc.querySelectorAll('ul.pagination li.pagination__button a[href*="page="]');
  let maxPage = 1;
  paginationButtons.forEach(link => {
    const url = link.getAttribute('href');
    const match = url.match(/page=(\d+)/);
    if (match && match[1]) {
      const pageNum = parseInt(match[1], 10);
      if (!isNaN(pageNum) && pageNum > maxPage) {
        maxPage = pageNum;
      }
    }
  });
  return maxPage;
}

function countItemsOnPage(doc, type) {
  const selector = type === 'wishlist' ? '.profile__friends-item' : '.card-show__owner';
  return doc.querySelectorAll(selector).length;
}

// Helper: recreate page when detached frame error occurs
async function recreatePage(context, oldPage, workerId) {
  try {
    await oldPage.close();
  } catch (e) {
    // ignore close errors
  }

  // In Playwright, proxy auth and cookies are bound to the context;
  // a new page automatically inherits them.
  const newPage = await context.newPage();
  log(workerId, '🔄 Page recreated due to detached frame');

  return newPage;
}

async function getCount(context, page, cardId, type, workerId) {
  const baseUrl = type === 'owners' 
    ? `https://mangabuff.ru/cards/${cardId}/users` 
    : `https://mangabuff.ru/cards/${cardId}/offers/want`;
  
  const maxRetries = 3;
  let currentPage = page;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await currentPage.goto(`${baseUrl}?page=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // Логируем финальный URL (для отслеживания редиректов)
      const finalUrl = currentPage.url();
      
      // Извлекаем ID карты из финального URL
      const urlMatch = finalUrl.match(/\/cards\/(\d+)/);
      const finalCardId = urlMatch ? parseInt(urlMatch[1], 10) : null;
      
      // Проверяем редирект на другую карту
      if (finalCardId && finalCardId !== cardId) {
        logWarn(workerId, `🔄 REDIRECT detected: card ${cardId} → ${finalCardId} (${type})`);
        log(workerId, `   Expected: ${baseUrl}?page=1`);
        log(workerId, `   Got:      ${finalUrl}`);
        
        // Помечаем как редирект (не обрабатываем данные с другой карты)
        return { count: 'REDIRECT', redirectTo: finalCardId, page: currentPage };
      }
      
      if (finalUrl !== `${baseUrl}?page=1`) {
        log(workerId, `⚠️ URL changed: expected ${baseUrl}?page=1, got ${finalUrl}`);
      }
      
      // Закрываем модальные окна и попапы (реклама, TT-канал и т.д.)
      try {
        await currentPage.evaluate(() => {
          // Закрыть любые модалки с кнопкой закрытия
          const closeButtons = document.querySelectorAll('[data-dismiss="modal"], .modal .close, button[aria-label="Close"], .popup-close');
          closeButtons.forEach(btn => btn.click());
          
          // Убрать overlay
          const overlays = document.querySelectorAll('.modal-backdrop, .overlay, [class*="modal"][class*="backdrop"]');
          overlays.forEach(el => el.remove());
        });
        await sleep(500); // Подождать закрытия модалки
      } catch (e) {
        // Игнорируем ошибки закрытия модалок
      }
      
      const content = await currentPage.content();
      const doc = new JSDOM(content).window.document;
      
      // Если страница вернула 404 — помечаем карту как отсутствующую
      if (response && response.status() === 404) {
        log(workerId, `🔎 Card ${cardId} page returned 404 — marking as not found`);
        return { count: 'MISSING', page: currentPage };
      }

      // Проверяем rate limit: HTTP статус 429 ИЛИ заголовок на странице ИЛИ страница DDoS-Guard
      const isRateLimited = (response && response.status() === 429) || 
                           doc.querySelector('h1#ddg-l10n-title')?.textContent?.includes('429 Too Many Requests') ||
                           doc.querySelector('title')?.textContent?.includes('DDoS-Guard') ||
                           doc.querySelector('body[data-ddg-origin="true"]') !== null;
      
      if (isRateLimited) {
        log(workerId, `⚠️ Rate limited on card ${cardId} (attempt ${attempt}/${maxRetries}), waiting 30 seconds...`);
        await sleep(30000);
        continue; // Повторить попытку
      }
      
      const countPerPage = countItemsOnPage(doc, type);
      const lastPageNum = getLastPageNumber(doc);
      
      if (lastPageNum <= 1) {
        return { count: countPerPage, page: currentPage };
      }
      
      // Загружаем последнюю страницу
      const lastResponse = await currentPage.goto(`${baseUrl}?page=${lastPageNum}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      
      // Закрываем модальные окна и на последней странице
      try {
        await currentPage.evaluate(() => {
          const closeButtons = document.querySelectorAll('[data-dismiss="modal"], .modal .close, button[aria-label="Close"], .popup-close');
          closeButtons.forEach(btn => btn.click());
          const overlays = document.querySelectorAll('.modal-backdrop, .overlay, [class*="modal"][class*="backdrop"]');
          overlays.forEach(el => el.remove());
        });
        await sleep(500);
      } catch (e) {}
      
      const lastContent = await currentPage.content();
      const lastDoc = new JSDOM(lastContent).window.document;
      
      // Проверяем rate limit на последней странице
      const isLastPageRateLimited = (lastResponse && lastResponse.status() === 429) || 
                                     lastDoc.querySelector('h1#ddg-l10n-title')?.textContent?.includes('429 Too Many Requests') ||
                                     lastDoc.querySelector('title')?.textContent?.includes('DDoS-Guard') ||
                                     lastDoc.querySelector('body[data-ddg-origin="true"]') !== null;
      
      if (isLastPageRateLimited) {
        log(workerId, `⚠️ Rate limited on card ${cardId} last page (attempt ${attempt}/${maxRetries}), waiting 30 seconds...`);
        await sleep(30000);
        continue;
      }
      
      const countOnLastPage = countItemsOnPage(lastDoc, type);
      
      return { count: (countPerPage * (lastPageNum - 1)) + countOnLastPage, page: currentPage };
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      
      // Special handling for detached/closed page — recreate page (Playwright error patterns)
      if (
        msg.includes('Target closed') ||
        msg.includes('Target page, context or browser has been closed') ||
        msg.includes('page has been closed') ||
        msg.includes('Frame was detached') ||
        msg.includes('detached Frame') ||
        msg.includes('Execution context was destroyed')
      ) {
        log(workerId, `⚠️ Detached frame detected for ${type} card ${cardId}, recreating page...`);
        try {
          currentPage = await recreatePage(context, currentPage, workerId);
          await sleep(2000);
          continue;
        } catch (recreateErr) {
          logError(workerId, `Failed to recreate page: ${recreateErr.message}`);
        }
      }
      
      if (attempt < maxRetries) {
        log(workerId, `Retry ${attempt}/${maxRetries} for ${type} card ${cardId}: ${msg}`);
        await sleep(3000 * attempt);
        continue;
      }
      // Permanent failure after retries — log, save diagnostic dump, and mark as FAILED
      logError(workerId, `Failed to fetch ${type} for card ${cardId} after ${maxRetries} attempts: ${msg}`);
      try {
        const dumpDir = path.join(__dirname, 'debug', `card_${cardId}`);
        fs.mkdirSync(dumpDir, { recursive: true });
        try { await currentPage.screenshot({ path: path.join(dumpDir, `${type}-error.png`) }); } catch (e) {}
        try { 
          const htmlContent = await currentPage.content();
          const currentUrl = currentPage.url();
          fs.writeFileSync(path.join(dumpDir, `${type}-page.html`), htmlContent); 
          fs.writeFileSync(path.join(dumpDir, `${type}-info.txt`), `URL: ${currentUrl}\nError: ${msg}\nTimestamp: ${new Date().toISOString()}`);
        } catch (e) {}
        log(workerId, `Diagnostic dump saved for card ${cardId} in ${dumpDir}`);
      } catch (e) {
        logError(workerId, `Failed to write diagnostic dump for card ${cardId}: ${e.message}`);
      }
      return { count: 'FAILED', page: currentPage };
    }
  }
  
  return { count: 0, page: currentPage };
}

// ==================== ЗАПИСЬ В SUPABASE (REST API) ====================

async function testSupabaseConnection() {
  try {
    const response = await axios.get(
      `${config.supabase.url}/rest/v1/cache_entries?select=key&limit=1`,
      {
        headers: {
          'apikey': config.supabase.key,
          'Authorization': `Bearer ${config.supabase.key}`
        },
        timeout: 10000
      }
    );
    log(null, `✔ Supabase connected`);
    return true;
  } catch (error) {
    logError(null, 'Supabase connection failed:', error.message);
    return false;
  }
}

async function pushToDatabase(entries, workerId) {
  try {
    log(workerId, `Saving ${entries.length} entries to Supabase...`);
    
    // Upsert через REST API
    const response = await axios.post(
      `${config.supabase.url}/rest/v1/cache_entries`,
      entries.map(e => ({
        key: e.key,
        count: e.count,
        timestamp: e.timestamp
      })),
      {
        headers: {
          'apikey': config.supabase.key,
          'Authorization': `Bearer ${config.supabase.key}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal, resolution=merge-duplicates'  // Upsert, minimize response body
        },
        timeout: 30000
      }
    );
    
    log(workerId, `✔ Saved ${entries.length} entries`);
    return true;
  } catch (error) {
    logError(workerId, 'Error saving to Supabase:', error.response?.data || error.message);
    return false;
  }
}

// ==================== ВОРКЕР ====================

async function runWorker(workerId, startId, endId) {
  log(workerId, `Starting: cards ${startId} to ${endId}`);
  
  const account = getAccountForWorker(workerId);
  if (!account) {
    logError(workerId, 'No account available! Run with --setup first.');
    return;
  }

  // Proxy priority:
  //   1. --no-proxy flag → no proxy for any worker
  //   2. account.proxy is explicitly set (string) → use account proxy
  //   3. account.proxy === null (explicitly disabled) → no proxy
  //   4. account.proxy === undefined (not set) → fall back to global proxy list
  let proxy = null;
  if (noProxy) {
    log(workerId, 'Proxy disabled via --no-proxy flag');
  } else if (account.proxy !== undefined) {
    // Account has explicit proxy setting (null = no proxy, string = use proxy)
    if (account.proxy) {
      proxy = { url: account.proxy };
      log(workerId, `Using account-level proxy for ${account.name}`);
    } else {
      log(workerId, `Account ${account.name} has no proxy configured — running without proxy`);
    }
  } else {
    // Fallback to global proxy list (round-robin)
    proxy = getProxyForWorker(workerId);
    if (proxy) log(workerId, `Using global proxy for ${account.name}`);
  }
  
  // Настройки браузера
  const launchOptions = {
    headless: !!headlessMode,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  // Allow overriding browser executable via env var BROWSER_EXECUTABLE or THORIUM_EXECUTABLE
  if (process.env.BROWSER_EXECUTABLE || process.env.THORIUM_EXECUTABLE) {
    launchOptions.executablePath = process.env.BROWSER_EXECUTABLE || process.env.THORIUM_EXECUTABLE;
    log(workerId, `Using browser executable from env: ${launchOptions.executablePath}`);
  }

  // In Playwright, proxy credentials are configured at context level (supports auth for all proxy types)
  const contextOptions = {};
  if (proxy) {
    const p = normalizeProxyEntry(proxy);
    if (!p) {
      logError(workerId, `Invalid proxy entry: ${JSON.stringify(proxy)}`);
    } else {
      let proxyServer;
      if (p.protocol && p.protocol.startsWith('socks')) {
        proxyServer = `socks5://${p.host}:${p.port}`;
        log(workerId, `Using SOCKS5 proxy: ${p.host}:${p.port}`);
      } else {
        proxyServer = `http://${p.host}:${p.port}`;
        log(workerId, `Using HTTP/HTTPS proxy: ${p.host}:${p.port} (auth: ${p.username ? '***' : 'none'})`);
      }
      contextOptions.proxy = { server: proxyServer };
      if (p.username && p.password) {
        contextOptions.proxy.username = p.username;
        contextOptions.proxy.password = p.password;
      }
    }
  }
  
  // Прогресс воркера — читаем заранее, чтобы можно было пропустить запуск браузера если работа уже сделана
  const progressKey = `worker_${workerId}`;

  // helper: атомарно сохранить прогресс для воркера (слияние с возможными изменениями других воркеров)
  function saveProgressForWorker(k, lastId, processedCount, errorCount) {
    try {
      let cur = {};
      if (fs.existsSync(PROGRESS_FILE)) {
        try { cur = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8') || '{}'); } catch (e) { cur = {}; }
      }
      const prev = cur[k] || {};
      const merged = {
        lastId: Math.max(prev.lastId || 0, lastId || 0),
        processedCount: (typeof processedCount === 'number') ? processedCount : (prev.processedCount || 0),
        errorCount: (typeof errorCount === 'number') ? errorCount : (prev.errorCount || 0)
      };
      cur[k] = merged;

      // atomic write: write temp file then rename
      const tmp = PROGRESS_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(cur, null, 2));
      fs.renameSync(tmp, PROGRESS_FILE);
      log(workerId, `Progress saved (lastId=${merged.lastId})`);
    } catch (e) {
      logError(workerId, `Failed to save progress: ${e.message}`);
    }
  }

  // Загрузка текущего прогресса
  let persistedProgress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    try { persistedProgress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (e) { persistedProgress = {}; }
  }

  // Учитываем сохранённый прогресс только для дефолтного запуска (startId == 1)
  let currentId = startId;
  if (startId === 1 && persistedProgress[progressKey]?.lastId) {
    currentId = Math.max(persistedProgress[progressKey].lastId, startId);
  }

  // Если уже прошли дальше, пропускаем этот воркер без запуска браузера
  if (currentId > endId) {
    log(workerId, `Skipping: worker already past assigned range (progress lastId=${persistedProgress[progressKey]?.lastId} > end=${endId})`);
    return;
  }

  // track last processed id in this worker run
  let lastProcessedId = persistedProgress[progressKey]?.lastId || (startId - 1);

  // Ensure Playwright Chromium is installed
  if (!launchOptions.executablePath) {
    try {
      const exePath = await ensureChromiumInstalled(workerId);
      if (exePath) launchOptions.executablePath = exePath;
    } catch (err) {
      logError(workerId, `Cannot proceed without Chromium: ${err.message}`);
      throw err;
    }
  }

  if (launchOptions.executablePath) {
    log(workerId, `🚀 Launching browser: ${launchOptions.executablePath}`);
  }

  const browser = await chromium.launch(launchOptions);
  // Playwright: proxy auth and cookies live on the context, not on individual pages
  const context = await browser.newContext(contextOptions);
  await context.addCookies(account.cookies);
  let page = await context.newPage();

  // Проверяем IP адрес перед началом работы
  try {
    const ipCheckPage = await context.newPage();
    await ipCheckPage.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle', timeout: 15000 });
    const ipData = await ipCheckPage.evaluate(() => document.body.textContent);
    const ip = JSON.parse(ipData).ip;
    log(workerId, `🌐 Current IP: ${ip}`);
    await ipCheckPage.close();
  } catch (error) {
    logError(workerId, `Failed to check IP: ${error.message}`);
  }

  log(workerId, `Using account: ${account.name}`);
  
  let batchBuffer = [];
  let processedCount = 0;
  let errorCount = 0;
  
  for (let id = currentId; id <= endId; id++) {
    try {
      // skip if blacklisted
      if (isBlacklisted(id)) {
        log(workerId, `Skipping card ${id} — blacklisted`);
        lastProcessedId = id;
        processedCount++;
        continue;
      }

      const ownersResult = await getCount(context, page, id, 'owners', workerId);
      const wishlistResult = await getCount(context, ownersResult.page, id, 'wishlist', workerId);
      
      // Update page reference if it was recreated
      page = wishlistResult.page;
      
      const owners = ownersResult.count;
      const wishlist = wishlistResult.count;
      const timestamp = Date.now();

      // If card redirects to another card, add to blacklist and log redirect
      if (owners === 'REDIRECT' || wishlist === 'REDIRECT') {
        const redirectTo = ownersResult.redirectTo || wishlistResult.redirectTo;
        addToBlacklist(id);
        log(workerId, `Card ${id} → REDIRECT to ${redirectTo} — added to blacklist`);
        lastProcessedId = id;
        processedCount++;
        continue;
      }

      // If either page is missing (404), add to blacklist and skip
      if (owners === 'MISSING' || wishlist === 'MISSING') {
        addToBlacklist(id);
        log(workerId, `Card ${id} added to blacklist (missing page)`);
        lastProcessedId = id;
        processedCount++;
        continue;
      }

      // If fetch permanently failed (network/proxy), add to failed list and skip for now
      if (owners === 'FAILED' || wishlist === 'FAILED') {
        addToFailed(id, 'FETCH_FAILED');
        log(workerId, `Card ${id} added to failed list (fetch error)`);
        lastProcessedId = id;
        processedCount++;
        continue;
      }

      if (owners >= 0 && wishlist >= 0) {
        batchBuffer.push(
          { key: `owners_${id}`, count: owners, timestamp },
          { key: `wishlist_${id}`, count: wishlist, timestamp }
        );
        processedCount++;
        log(workerId, `Card ${id}: owners=${owners}, wishlist=${wishlist}`);
      }
    } catch (error) {
      logError(workerId, `Error for card ${id}:`, error.message);
      errorCount++;
    }

    // Отправляем батч
    if (batchBuffer.length >= config.scraping.batchSize) {
      await pushToDatabase(batchBuffer, workerId);
      batchBuffer = [];
    }

    // Сохраняем прогресс (периодически, атомарно)
    if (id % config.scraping.saveProgressEvery === 0) {
      lastProcessedId = id; // обновляем последний обработанный id
      saveProgressForWorker(progressKey, lastProcessedId, processedCount, errorCount);
    }

    await sleep(randomDelay());
  }

  // Отправляем остаток
  if (batchBuffer.length > 0) {
    await pushToDatabase(batchBuffer, workerId);
  }

  // Сохраняем финальный прогресс — помечаем до какого id дошёл воркер
  if (lastProcessedId < endId) {
    // Если мы не обработали до конца (например, были ошибки), ставим последний обработанный id
    saveProgressForWorker(progressKey, lastProcessedId, processedCount, errorCount);
  } else {
    // Если завершили весь диапазон — отмечаем конец
    saveProgressForWorker(progressKey, endId, processedCount, errorCount);
  }

  log(workerId, `Completed: processed=${processedCount}, errors=${errorCount}, lastId=${lastProcessedId}`);
  await browser.close();
}

// ==================== НАСТРОЙКА АККАУНТОВ ====================

async function setupAccounts() {
  log(null, '=== Account Setup Mode ===');
  
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  const question = (q) => new Promise(resolve => rl.question(q, resolve));
  
  const accountName = await question('Enter account name (e.g., account1): ');
  const useProxy = await question('Use proxy? (y/n): ');
  
  let proxyUrl = null;
  let proxyEntry = null;
  if (useProxy.toLowerCase() === 'y') {
    proxyUrl = await question('Enter proxy URL (http://user:pass@host:port or socks5://host:port): ');
    proxyEntry = normalizeProxyEntry(proxyUrl);
    if (!proxyEntry) {
      log(null, '⚠️ Warning: could not parse proxy URL, continuing without proxy');
      proxyUrl = null;
    }
  }
  
  const launchOptions = {
    headless: false,
    args: ['--no-sandbox']
  };

  // Allow overriding browser executable via env var BROWSER_EXECUTABLE or THORIUM_EXECUTABLE
  if (process.env.BROWSER_EXECUTABLE || process.env.THORIUM_EXECUTABLE) {
    launchOptions.executablePath = process.env.BROWSER_EXECUTABLE || process.env.THORIUM_EXECUTABLE;
    log(null, `Using browser executable from env: ${launchOptions.executablePath}`);
  }

  // In Playwright, proxy is configured at context level (supports auth natively)
  const setupContextOptions = {};
  if (proxyEntry) {
    let proxyServer;
    if (proxyEntry.protocol && proxyEntry.protocol.startsWith('socks')) {
      proxyServer = `socks5://${proxyEntry.host}:${proxyEntry.port}`;
    } else {
      proxyServer = `http://${proxyEntry.host}:${proxyEntry.port}`;
    }
    setupContextOptions.proxy = { server: proxyServer };
    if (proxyEntry.username && proxyEntry.password) {
      setupContextOptions.proxy.username = proxyEntry.username;
      setupContextOptions.proxy.password = proxyEntry.password;
    }
  }

  log(null, 'Launching browser for login...');
  // Ensure Playwright Chromium is installed
  if (!launchOptions.executablePath) {
    try {
      const exe = await ensureChromiumInstalled(null);
      if (exe) launchOptions.executablePath = exe;
    } catch (err) {
      logError(null, `Cannot launch browser for login: ${err.message}`);
      throw err;
    }
  }

  if (launchOptions.executablePath) {
    log(null, `🚀 Launching browser: ${launchOptions.executablePath}`);
  }

  const browser = await chromium.launch(launchOptions);
  const setupContext = await browser.newContext(setupContextOptions);
  const page = await setupContext.newPage();

  // Quick proxy check: fetch public IP using the browser to see if proxy works
  if (proxyEntry) {
    try {
      const ipCheckPage = await setupContext.newPage();
      await ipCheckPage.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle', timeout: 15000 });
      const ipData = await ipCheckPage.evaluate(() => document.body.textContent);
      const ip = JSON.parse(ipData).ip;
      log(null, `Proxy test OK — public IP from browser: ${ip}`);
      await ipCheckPage.close();
    } catch (e) {
      log(null, `⚠️ Proxy test failed: ${e.message}. You can still try to login manually, but proxy may be misconfigured.`);
    }
  }

  await page.goto('https://mangabuff.ru/login');
  
  log(null, '');
  log(null, '===========================================');
  log(null, 'Please login manually in the browser.');
  log(null, 'After login, press Enter in this terminal.');
  log(null, '===========================================');
  log(null, '');
  
  await question('Press Enter after login...');
  
  // Сохраняем cookies и CSRF
  const cookies = await setupContext.cookies();
  let csrf = null;
  try {
    csrf = await page.$eval('meta[name="csrf-token"]', el => el.content);
  } catch (e) {
    log(null, 'Could not get CSRF token (not critical)');
  }
  
  const newAccount = {
    name: accountName,
    cookies: cookies,
    csrf: csrf,
    proxy: proxyUrl,
    enabled: true,
    createdAt: new Date().toISOString()
  };
  
  // Добавляем или обновляем аккаунт
  const existingIndex = accounts.findIndex(a => a.name === accountName);
  if (existingIndex >= 0) {
    accounts[existingIndex] = newAccount;
    log(null, `Account "${accountName}" updated.`);
  } else {
    accounts.push(newAccount);
    log(null, `Account "${accountName}" added.`);
  }
  
  saveAccounts();
  
  await browser.close();
  rl.close();
  
  log(null, 'Setup complete! You can now run the scraper.');
}

// ==================== ГЛАВНАЯ ФУНКЦИЯ ====================

async function main() {
  const args = process.argv.slice(2);
  
  loadConfig();
  loadAccounts();
  
  // Режим настройки (не требует БД)
  if (args.includes('--setup')) {
    await setupAccounts();
    return;
  }
  
  // Показать статус (не требует БД)
  if (args.includes('--status')) {
    log(null, '=== Scraper Status ===');
    log(null, `Accounts: ${accounts.filter(a => a.enabled && a.cookies).length} active`);
    log(null, `Proxies: ${config.proxies.filter(p => p.enabled).length} active`);
    
    if (fs.existsSync(PROGRESS_FILE)) {
      const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      log(null, 'Progress:', progress);
    }
    return;
  }
  
  // Парсим аргументы
  let workerCount = config.workers.count;
  let fromId = 1;
  let toId = config.scraping.maxCardId;
  let resetProgress = false;
  
  for (const arg of args) {
    if (arg.startsWith('--workers=')) {
      workerCount = parseInt(arg.split('=')[1], 10);
    }
    if (arg.startsWith('--from=')) {
      fromId = parseInt(arg.split('=')[1], 10);
    }
    if (arg.startsWith('--to=')) {
      toId = parseInt(arg.split('=')[1], 10);
    }
    // Accept either --reset-progress or shorthand --reset to clear progress file
    if (arg === '--reset-progress' || arg === '--reset') {
      resetProgress = true;
    }
    if (arg === '--headless') {
      headlessMode = true;
    }
    if (arg === '--no-proxy') {
      noProxy = true;
    }
  }

  // Also allow HEADLESS env var
  headlessMode = headlessMode || (process.env.HEADLESS && process.env.HEADLESS.toLowerCase() === 'true');
  
  // Очищаем прогресс если запрошено
  if (resetProgress && fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
    log(null, 'Progress file deleted');
  }
  
  const enabledAccounts = accounts.filter(a => a.enabled && a.cookies);
  if (enabledAccounts.length === 0) {
    logError(null, 'No accounts configured! Run: node scraper-v2.js --setup');
    return;
  }
  
  // Проверяем подключение к Supabase
  const connected = await testSupabaseConnection();
  if (!connected) {
    logError(null, 'Cannot start without Supabase connection');
    return;
  }
  
  // Ограничиваем воркеры количеством аккаунтов
  const requestedWorkerCount = workerCount;
  workerCount = Math.min(workerCount, enabledAccounts.length);
  if (workerCount < requestedWorkerCount) {
    log(null, `⚠️ Requested ${requestedWorkerCount} workers but only ${enabledAccounts.length} account(s) active — using ${workerCount} worker(s)`);
  }
  
  log(null, '=== Starting Scraper ===');
  log(null, `Cards: ${fromId} to ${toId}`);
  log(null, `Database: Supabase REST API`);  
  log(null, `Workers: ${workerCount}`);
  log(null, `Accounts: ${enabledAccounts.length}`);
  log(null, `Proxies: ${config.proxies.filter(p => p.enabled).length}`);
  log(null, `Headless mode: ${headlessMode}`);
  log(null, '');
  
  // Распределяем карты по воркерам
  const totalCards = toId - fromId + 1;
  const cardsPerWorker = Math.ceil(totalCards / workerCount);
  
  // Загружаем прогресс, чтобы можно было пропустить уже выполненные диапазоны
  let globalProgress = {};
  if (fs.existsSync(PROGRESS_FILE)) {
    try { globalProgress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch (e) { globalProgress = {}; }
  }

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    const start = fromId + (i * cardsPerWorker);
    const end = Math.min(start + cardsPerWorker - 1, toId);
    
    if (start <= toId) {
      // Если это дефолтный запуск (fromId == 1) и прогресс для воркера уже больше end, пропускаем запуск
      const progressKey = `worker_${i}`;
      if (fromId === 1 && globalProgress[progressKey]?.lastId && globalProgress[progressKey].lastId >= end) {
        log(null, `Skipping worker ${i}: already completed up to ${globalProgress[progressKey].lastId} (end=${end})`);
        continue;
      }

      workers.push(runWorker(i, start, end));
    }
  }

  log(null, `Active workers: ${workers.length}`);

  await Promise.all(workers);
  
  log(null, '=== All workers completed ===');
}

main().catch(err => {
  logError(null, 'Fatal error:', err);
  process.exit(1);
});
