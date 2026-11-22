// Сервер мини-приложения «Регламенты». Без внешних зависимостей, нужен только Node.js 18+.
// Переменные окружения:
//   BOT_TOKEN  — токен бота из @BotFather (обязательно)
//   OWNER_IDS  — Telegram ID владельцев через запятую, например 123456789,987654321
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN — бесплатная база Upstash (рекомендуется)
//   APP_URL    — адрес приложения (на Render подставляется сам, задавать не нужно)
//   Напоминания (время по Ташкенту, формат ЧЧ:ММ, «off» — отключить):
//   OPEN_REMIND_AT  (по умолчанию 10:00) — напомнить сотрудникам об открытии
//   OPEN_ALERT_AT   (по умолчанию 10:30) — сообщить владельцу, если открытие не завершено
//   CLOSE_REMIND_AT (по умолчанию 23:00) — напомнить сотрудникам о закрытии
//   CLOSE_ALERT_AT  (по умолчанию 00:30) — сообщить владельцу, если закрытие не завершено
//   NOTIFY_EXPENSES — «off», чтобы не присылать владельцу каждый расход
//   PORT, DATA_FILE — необязательно

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const TG_API = process.env.TG_API || 'https://api.telegram.org';
const NOTIFY_EXPENSES = (process.env.NOTIFY_EXPENSES || 'on').trim().toLowerCase() !== 'off';
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

// ---------- Хранилище ----------
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UP_KEY = 'checklist_db';
const useUpstash = !!(UP_URL && UP_TOKEN);

let db = { shifts: {}, expenses: {}, users: {}, sent: {}, schedule: { staff: [], offs: {} } };
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
  db.shifts = db.shifts || {};
  db.expenses = db.expenses || {};
  db.users = db.users || {};
  db.sent = db.sent || {};
  db.schedule = db.schedule || {};
  db.schedule.staff = db.schedule.staff || [];
  db.schedule.offs = db.schedule.offs || {};
}
let saveChain = Promise.resolve();
function save() {
  // удаляем записи старше 120 дней, чтобы база не росла бесконечно
  const limit = shiftDate(dayOf(Date.now()), -120);
  for (const k of Object.keys(db.shifts)) if (k.slice(0, 10) < limit) delete db.shifts[k];
  for (const k of Object.keys(db.expenses)) if (k < limit) delete db.expenses[k];
  for (const k of Object.keys(db.sent)) if (k.slice(0, 10) < limit) delete db.sent[k];
  for (const k of Object.keys(db.schedule.offs)) if (k < limit) delete db.schedule.offs[k];
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

// ---------- Вспомогательное ----------
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
const hm = ts => new Date(ts).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const money = n => Number(n).toLocaleString('ru-RU').replace(/[  ]/g, ' ') + ' сум';
const escH = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const expList = date => db.expenses[date] || [];
const expTotal = date => expList(date).reduce((a, e) => a + e.amount, 0);
const TYPE_NAME = { open: 'Открытие заведения', close: 'Закрытие заведения' };

// ---------- График выходных ----------
const SCHED_ANCHOR = '2026-01-05'; // любой понедельник: от него считаем чётность недель
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const mondayOf = date => shiftDate(date, -((new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7));
const mod = (n, m) => ((n % m) + m) % m;

// Выходные одной недели w (номер недели от якоря). Смещения от понедельника: 4 = пт, 5 = сб, 6 = вс.
// Правила: выходные только пт/сб/вс (пн–чт все на смене); у каждого один выходной в неделю,
// у отмеченных «раз в 2 недели» — один в две недели; те, у кого включено «чередовать воскресенье»,
// по очереди берут воскресенье, остальные дни стараемся распределить поровну.
function genWeek(w, staff) {
  const res = {};
  const counts = { 4: 0, 5: 0, 6: 0 };
  const add = (off, id) => { (res[off] = res[off] || []).push(id); counts[off]++; };
  const bi = staff.filter(s => s.biweekly);
  const need = staff.filter(s => !s.biweekly || mod(w + bi.indexOf(s), 2) === 0);
  const church = need.filter(s => s.church);
  const designated = church.length ? church[mod(w, church.length)] : null;
  if (designated) add(6, designated.id);
  const rest = need.filter(s => s !== designated);
  const rot = list => { const r = list.length ? mod(w, list.length) : 0; return list.slice(r).concat(list.slice(0, r)); };
  const ordered = rot(rest.filter(s => s.church)).concat(rot(rest.filter(s => !s.church)));
  ordered.forEach((s, i) => {
    const allowed = s.church ? [4, 5] : [4, 5, 6];
    const min = Math.min(...allowed.map(d => counts[d]));
    const c = allowed.filter(d => counts[d] === min);
    add(c[mod(w + i, c.length)], s.id);
  });
  return res;
}
function generateSchedule(fromDate, weeks) {
  const sch = db.schedule, from = mondayOf(fromDate);
  for (let i = 0; i < weeks * 7; i++) delete sch.offs[shiftDate(from, i)];
  for (let k = 0; k < weeks; k++) {
    const monday = shiftDate(from, 7 * k);
    const w = Math.floor(daysBetween(SCHED_ANCHOR, monday) / 7);
    const res = genWeek(w, sch.staff);
    for (const off of Object.keys(res)) sch.offs[shiftDate(monday, Number(off))] = res[off];
  }
}

// ---------- Telegram: отправка сообщений ----------
async function tgSend(chatId, text) {
  if (!BOT_TOKEN) return { ok: false, error: 'нет BOT_TOKEN' };
  const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (APP_URL.startsWith('https://')) {
    body.reply_markup = { inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: APP_URL } }]] };
  }
  try {
    const r = await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) {
      const t = await r.text();
      console.error('Telegram не принял сообщение', chatId, r.status, t);
      return { ok: false, error: t };
    }
    return { ok: true };
  } catch (e) {
    console.error('Ошибка отправки в Telegram', e.message);
    return { ok: false, error: e.message };
  }
}
const toOwners = text => Promise.all(OWNER_IDS.map(id => tgSend(id, text)));
const toUser = (id, text) => tgSend(id, text);
const employees = () => Object.entries(db.users).filter(([id, u]) => u.role !== 'owner' && u.remind !== false).map(([id]) => id);

// ---------- Напоминания по времени ----------
const parseMin = s => {
  s = (s || '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  return (Number(m[1]) * 60 + Number(m[2]) - DAY_CUTOFF_HOURS * 60 + 1440) % 1440; // минуты от начала рабочего дня (05:00)
};
const RULES = [
  { id: 'open_remind', type: 'open', to: 'staff', at: process.env.OPEN_REMIND_AT || '10:00' },
  { id: 'open_alert', type: 'open', to: 'owner', at: process.env.OPEN_ALERT_AT || '10:30' },
  { id: 'close_remind', type: 'close', to: 'staff', at: process.env.CLOSE_REMIND_AT || '23:00' },
  { id: 'close_alert', type: 'close', to: 'owner', at: process.env.CLOSE_ALERT_AT || '00:30' }
].map(r => ({ ...r, min: parseMin(r.at) }));

function bizMinutes(ts) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(ts);
  const h = Number(parts.find(p => p.type === 'hour').value), m = Number(parts.find(p => p.type === 'minute').value);
  return (h * 60 + m - DAY_CUTOFF_HOURS * 60 + 1440) % 1440;
}

async function tick(now = Date.now()) {
  const date = dayOf(now), bm = bizMinutes(now);
  for (const r of RULES) {
    if (r.min == null) continue; // отключено
    const key = `${date}|${r.id}`;
    if (db.sent[key]) continue;
    if (bm < r.min || bm - r.min > 120) continue; // не раньше срока и не позже чем через 2 часа
    db.sent[key] = 1;
    save();
    const sh = db.shifts[`${date}|${r.type}`];
    const p = pct(sh, r.type);
    if (p >= 100) continue;
    const name = TYPE_NAME[r.type];
    const who = sh && sh.startedBy ? sh.startedBy.name : null;
    if (r.to === 'staff') {
      const text = who
        ? `⏰ <b>${name}</b>: выполнено ${p}%. Осталось ${totals[r.type] - Object.keys(sh.items).length} пунктов.`
        : `⏰ <b>${name}</b>: пора начинать. Откройте чек-лист и отметьте пункты.`;
      if (who) await toUser(sh.startedBy.id, text);
      else await Promise.all(employees().map(id => toUser(id, text)));
    } else {
      await toOwners(who
        ? `⚠️ <b>${name}</b> не завершено: ${p}%. Смену ведёт ${escH(who)}.`
        : `⚠️ <b>${name}</b>: никто ещё не начал (0%).`);
    }
  }
}

// ---------- Проверка подписи Telegram ----------
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

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/ping') return send(res, 200, 'ok', 'text/plain'); // для сервиса «не давать засыпать»

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
  }

  if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });

  const me = verifyInitData(req.headers['x-init-data']);
  if (!me) return send(res, 401, { error: 'unauthorized' });

  // запоминаем сотрудника, чтобы слать ему напоминания
  const known = db.users[me.id];
  if (!known || known.name !== me.name || known.role !== me.role) {
    db.users[me.id] = { name: me.name, role: me.role, remind: known ? known.remind !== false : true };
    save();
  }
  me.remind = db.users[me.id].remind !== false;

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const today = dayOf(Date.now());
    let date = url.searchParams.get('date') || today;
    if (me.role !== 'owner' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today; // сотрудник видит только сегодня
    const out = {
      me, today, date, checklists,
      shifts: { open: db.shifts[`${date}|open`] || null, close: db.shifts[`${date}|close`] || null },
      expenses: expList(date), expTotal: expTotal(date)
    };
    {
      const sch = db.schedule, mine = sch.staff.find(s => s.tg === me.id);
      out.schedule = {
        // признаки «раз в 2 недели» и «чередовать воскресенье» видит только владелец
        staff: sch.staff.map(s => me.role === 'owner' ? s : { id: s.id, name: s.name }),
        offs: sch.offs, myId: mine ? mine.id : null
      };
      if (me.role === 'owner') {
        const linked = new Set(sch.staff.map(s => s.tg).filter(Boolean));
        out.schedule.users = Object.entries(db.users)
          .filter(([id, u]) => u.role !== 'owner' && !linked.has(id)).map(([id, u]) => ({ id, name: u.name }));
      }
    }
    if (me.role === 'owner') {
      out.history = [];
      for (let i = 0; i < 7; i++) {
        const d = shiftDate(today, -i);
        const o = db.shifts[`${d}|open`], c = db.shifts[`${d}|close`];
        out.history.push({
          date: d, exp: expTotal(d),
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
    const before = pct(shift, type);
    const wasStarted = !!shift.startedBy;
    if (checked) {
      if (!shift.items[itemId]) shift.items[itemId] = { by: { id: me.id, name: me.name }, at: Date.now() };
      if (!shift.startedBy) { shift.startedBy = { id: me.id, name: me.name }; shift.startedAt = Date.now(); }
    } else {
      const ex = shift.items[itemId];
      if (ex && ex.by.id === me.id) delete shift.items[itemId];
    }
    save();
    send(res, 200, { shift });
    // уведомления владельцу
    const after = pct(shift, type);
    if (!wasStarted && shift.startedBy) {
      toOwners(`${type === 'open' ? '🌅' : '🌙'} <b>${escH(me.name)}</b> начал(а): ${TYPE_NAME[type].toLowerCase()}`);
    }
    if (before < 100 && after === 100) {
      let t = `✅ <b>${TYPE_NAME[type]}</b>: выполнено 100%\nСмену вёл(а): ${escH(shift.startedBy.name)}\nЗавершено в ${hm(Date.now())}`;
      if (type === 'close') t += `\n💸 Расходы за день: ${money(expTotal(date))}`;
      toOwners(t);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/expense') {
    const { title, amount } = await readBody(req);
    const t = typeof title === 'string' ? title.trim().slice(0, 60) : '';
    const a = Math.round(Number(amount));
    if (!t || !Number.isFinite(a) || a < 1 || a > 1e10) return send(res, 400, { error: 'bad expense' });
    const date = dayOf(Date.now());
    const list = db.expenses[date] || (db.expenses[date] = []);
    if (list.length >= 300) return send(res, 400, { error: 'too many' });
    list.push({ id: crypto.randomBytes(6).toString('hex'), title: t, amount: a, by: { id: me.id, name: me.name }, at: Date.now() });
    save();
    send(res, 200, { ok: true });
    if (NOTIFY_EXPENSES) toOwners(`💸 <b>Расход:</b> ${escH(t)} — ${money(a)}\nЗаписал(а): ${escH(me.name)}\nВсего за день: <b>${money(expTotal(date))}</b>`);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/expense/delete') {
    const { id } = await readBody(req);
    const date = dayOf(Date.now());
    const list = db.expenses[date] || [];
    const i = list.findIndex(e => e.id === id);
    if (i < 0) return send(res, 404, { error: 'not found' });
    if (me.role !== 'owner' && list[i].by.id !== me.id) return send(res, 403, { error: 'not yours' });
    const [removed] = list.splice(i, 1);
    save();
    send(res, 200, { ok: true });
    if (NOTIFY_EXPENSES && me.role !== 'owner') toOwners(`🗑 <b>Расход удалён:</b> ${escH(removed.title)} — ${money(removed.amount)}\nУдалил(а): ${escH(me.name)}\nВсего за день: <b>${money(expTotal(date))}</b>`);
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/sched/')) {
    if (me.role !== 'owner') return send(res, 403, { error: 'owner only' });
    const sch = db.schedule, b = await readBody(req), op = url.pathname.slice('/api/sched/'.length);
    if (op === 'staff') {
      if (b.op === 'add') {
        const name = typeof b.name === 'string' ? b.name.trim().slice(0, 30) : '';
        if (!name || sch.staff.length >= 20) return send(res, 400, { error: 'bad name' });
        const tg = b.tg && db.users[b.tg] && !sch.staff.some(s => s.tg === b.tg) ? String(b.tg) : null;
        sch.staff.push({ id: crypto.randomBytes(4).toString('hex'), name, tg, biweekly: !!b.biweekly, church: !!b.church });
      } else {
        const s = sch.staff.find(x => x.id === b.id);
        if (!s) return send(res, 404, { error: 'not found' });
        if (b.op === 'update') {
          if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim().slice(0, 30);
          if ('biweekly' in b) s.biweekly = !!b.biweekly;
          if ('church' in b) s.church = !!b.church;
        } else if (b.op === 'delete') {
          sch.staff = sch.staff.filter(x => x.id !== b.id);
          for (const d of Object.keys(sch.offs)) {
            sch.offs[d] = sch.offs[d].filter(id => id !== b.id);
            if (!sch.offs[d].length) delete sch.offs[d];
          }
        } else return send(res, 400, { error: 'bad op' });
      }
      save();
      return send(res, 200, { ok: true });
    }
    if (op === 'toggle') {
      if (!isDate(b.date) || !sch.staff.some(s => s.id === b.staffId)) return send(res, 400, { error: 'bad data' });
      let list = (sch.offs[b.date] || []).filter(id => id !== b.staffId);
      if (b.off) list.push(b.staffId);
      if (list.length) sch.offs[b.date] = list; else delete sch.offs[b.date];
      save();
      return send(res, 200, { ok: true });
    }
    if (op === 'generate') {
      if (!sch.staff.length) return send(res, 400, { error: 'no staff' });
      const weeks = Math.min(26, Math.max(1, Math.round(Number(b.weeks)) || 8));
      generateSchedule(dayOf(Date.now()), weeks);
      save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (req.method === 'POST' && url.pathname === '/api/remind') {
    const { on } = await readBody(req);
    db.users[me.id].remind = !!on;
    save();
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/test-notify') {
    if (me.role !== 'owner') return send(res, 403, { error: 'owner only' });
    const r = await tgSend(me.id, '🔔 Проверка уведомлений: всё работает!');
    return send(res, 200, r);
  }

  send(res, 404, { error: 'not found' });
});

loadDb().then(() => {
  server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}. Хранилище: ${useUpstash ? 'Upstash' : 'файл'}. Владельцев: ${OWNER_IDS.length}`));
  setInterval(() => tick().catch(e => console.error('tick', e)), 60 * 1000);
  setTimeout(() => tick().catch(e => console.error('tick', e)), 5000);
});

module.exports = { tick, RULES }; // для проверки
