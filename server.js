// Сервер мини-приложения «Регламенты». Без внешних зависимостей, нужен только Node.js 18+.
// Переменные окружения:
//   BOT_TOKEN  — токен бота из @BotFather (обязательно)
//   OWNER_IDS  — Telegram ID владельцев через запятую, например 123456789,987654321
//   PORT       — порт (по умолчанию 3000)
//   DATA_FILE  — путь к файлу данных (по умолчанию ./data.json)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const TZ = 'Asia/Tashkent';
const DAY_CUTOFF_HOURS = 5; // закрытие после полуночи относится к прошлому дню

const checklists = JSON.parse(fs.readFileSync(path.join(__dirname, 'checklists.json'), 'utf8'));
const totals = {};
const validIds = {};
for (const type of Object.keys(checklists)) {
  validIds[type] = new Set();
  checklists[type].sections.forEach((s, si) => s.items.forEach((_, ii) => validIds[type].add(`${type}.${si}.${ii}`)));
  totals[type] = validIds[type].size;
}

// Хранилище: если заданы UPSTASH_REDIS_REST_URL и UPSTASH_REDIS_REST_TOKEN — данные лежат
// в бесплатной базе Upstash (переживают перезапуски). Иначе — в локальном файле DATA_FILE.
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UP_KEY = 'checklist_db';
const useUpstash = !!(UP_URL && UP_TOKEN);

let db = { shifts: {} };
async function loadDb() {
  try {
    if (useUpstash) {
      const r = await fetch(`${UP_URL}/get/${UP_KEY}`, { headers: { Authorization: `Bearer ${UP_TOKEN}` } });
      const j = await r.json();
      if (j.result) db = JSON.parse(j.result);
    } else {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { /* первый запуск */ }
  if (!db.shifts) db.shifts = {};
}
let saveChain = Promise.resolve();
function save() {
  // удаляем смены старше 120 дней, чтобы база не росла бесконечно
  const limit = shiftDate(dayOf(Date.now()), -120);
  for (const k of Object.keys(db.shifts)) if (k.slice(0, 10) < limit) delete db.shifts[k];
  const body = JSON.stringify(db);
  if (useUpstash) {
    saveChain = saveChain.then(() => fetch(`${UP_URL}/set/${UP_KEY}`, {
      method: 'POST', headers: { Authorization: `Bearer ${UP_TOKEN}` }, body
    })).catch(e => console.error('Не удалось сохранить в Upstash', e.message));
  } else {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, DATA_FILE);
  }
}

function dayOf(ts) {
  return new Date(ts - DAY_CUTOFF_HOURS * 3600e3).toLocaleDateString('en-CA', { timeZone: TZ });
}
function shiftDate(date, delta) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function pct(shift, type) {
  if (!shift) return 0;
  const done = Object.keys(shift.items).filter(id => validIds[type].has(id)).length;
  return Math.round((done / totals[type]) * 100);
}

// Проверка подписи Telegram initData
function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const str = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (age > 86400 * 2) return null;
  try {
    const u = JSON.parse(params.get('user'));
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || String(u.id);
    return { id: String(u.id), name, role: OWNER_IDS.includes(String(u.id)) ? 'owner' : 'employee' };
  } catch (e) { return null; }
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  const me = verifyInitData(req.headers['x-init-data']);
  if (!me) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const today = dayOf(Date.now());
    let date = url.searchParams.get('date') || today;
    if (me.role !== 'owner' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today; // сотрудник видит только сегодня
    const out = {
      me, today, date, checklists,
      shifts: { open: db.shifts[`${date}|open`] || null, close: db.shifts[`${date}|close`] || null }
    };
    if (me.role === 'owner') {
      out.history = [];
      for (let i = 0; i < 7; i++) {
        const d = shiftDate(today, -i);
        const o = db.shifts[`${d}|open`], c = db.shifts[`${d}|close`];
        out.history.push({
          date: d,
          open: pct(o, 'open'), close: pct(c, 'close'),
          openBy: o && o.startedBy ? o.startedBy.name : null,
          closeBy: c && c.startedBy ? c.startedBy.name : null
        });
      }
    }
    return send(res, 200, out);
  }

  if (req.method === 'POST' && url.pathname === '/api/toggle') {
    if (me.role === 'owner') return send(res, 403, { error: 'owner is read-only' });
    const { type, itemId, checked } = await readBody(req);
    if (!validIds[type] || !validIds[type].has(itemId)) return send(res, 400, { error: 'bad item' });
    const date = dayOf(Date.now());
    const key = `${date}|${type}`;
    const shift = db.shifts[key] || (db.shifts[key] = { date, type, startedBy: null, startedAt: null, items: {} });
    if (checked) {
      if (!shift.items[itemId]) shift.items[itemId] = { by: { id: me.id, name: me.name }, at: Date.now() };
      if (!shift.startedBy) { shift.startedBy = { id: me.id, name: me.name }; shift.startedAt = Date.now(); }
    } else {
      const ex = shift.items[itemId];
      if (ex && ex.by.id === me.id) delete shift.items[itemId];
    }
    save();
    return send(res, 200, { shift });
  }

  send(res, 404, { error: 'not found' });
});

loadDb().then(() => server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}. Хранилище: ${useUpstash ? 'Upstash' : 'файл'}`)));
