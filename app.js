// Hide Email — одноразовая почта в браузере.
// Своего сервера нет: ящик создаётся у публичного сервиса временной почты,
// сайт хранит доступ к нему в localStorage и раз в 5 секунд спрашивает, не пришло ли письмо.
// Сервисов несколько: если один недоступен из твоей сети, пробуется следующий.

const POLL_MS = 5000;
const TIMEOUT_MS = 10000;
const STORE = 'hidemail-v1';

const $ = id => document.getElementById(id);

// ---------- состояние ----------
// accounts: [{ kind, api, address, token, ...поля сервиса, createdAt }] — всегда не больше одного
// known: { [address]: [id письма, ...] } — чтобы понять, какие письма новые
// seen:  { [address]: [id, ...] } — прочитанные, для сервисов, которые сами этого не помнят
let state = load();
let messages = [];          // письма текущего ящика
let openedId = null;        // открытое письмо
let pollTimer = null;
let polling = false;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.accounts)) return { known: {}, seen: {}, ...s };
  } catch {}
  return { accounts: [], current: null, known: {}, seen: {} };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {}
}
const currentAcc = () => state.accounts.find(a => a.address === state.current) || null;

// ---------- письма на устройстве ----------
// Письма сохраняются в браузере: после перезагрузки они на месте, даже если сервис
// их уже не отдаёт (tempmail.lol и Guerrilla Mail хранят письма около часа).
// Хранятся отдельно от адресов: если место кончится, пострадают только старые письма.
// box: { [address]: { list: [сводки], full: { [id]: письмо целиком }, deleted: [id] } }
const MAIL_STORE = 'hidemail-mail';
const MAX_PER_BOX = 50;
let box = loadBox();

function loadBox() {
  try { return JSON.parse(localStorage.getItem(MAIL_STORE)) || {}; } catch { return {}; }
}
function saveBox() {
  for (let i = 0; i < 50; i++) {
    try { localStorage.setItem(MAIL_STORE, JSON.stringify(box)); return; }
    catch { if (!dropOldestBody()) return; }   // места мало — выкидываем текст самого старого письма
  }
}
function dropOldestBody() {
  let oldest = null;
  for (const [address, b] of Object.entries(box)) {
    for (const [id, m] of Object.entries(b.full)) {
      if (!oldest || String(m.createdAt) < oldest.at) oldest = { address, id, at: String(m.createdAt) };
    }
  }
  if (!oldest) return false;
  delete box[oldest.address].full[oldest.id];
  return true;
}
const boxOf = address => (box[address] ||= { list: [], full: {}, deleted: [] });
const storedList = acc => acc ? boxOf(acc.address).list.map(m => ({ ...m, seen: isSeen(acc, m) })) : [];

// ---------- сеть ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// fetch с таймаутом: заблокированный сервер иногда не отвечает вовсе, а не отказывает сразу
async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, body, signal: ctrl.signal });
    if (!res.ok) {
      let msg = 'ошибка ' + res.status;
      try { const j = await res.json(); msg = j.detail || j['hydra:description'] || j.message || j.error || msg; } catch {}
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return res.status === 204 ? null : res.json();
  } finally { clearTimeout(timer); }
}

// «Load failed» (Safari) и «Failed to fetch» (Chrome) — браузер вообще не получил ответа:
// сервер недоступен из этой сети или запрос заблокирован
const netError = e => e.name === 'AbortError' ? 'сервер не ответил за 10 секунд'
  : e instanceof TypeError ? 'нет связи с сервером' : e.message;

// Читаемое случайное имя: слог + слог + цифры, например "lomira482"
function randomLogin() {
  const c = 'bdfgklmnprstvz', v = 'aeiou';
  const pick = s => s[Math.floor(Math.random() * s.length)];
  let name = '';
  for (let i = 0; i < 3; i++) name += pick(c) + pick(v);
  return name + Math.floor(100 + Math.random() * 900);
}
function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 20);
}

// ---------- сервисы ----------
// У каждого сервиса одинаковый набор методов. Письма приводятся к одному виду:
// список — { id, from: { name, address }, subject, intro, seen, createdAt }
// письмо — { from, createdAt, html, text }

// mail.tm и mail.gw: один и тот же API, ящик с паролем, письма хранятся на сервере
function mailTm(base, name) {
  async function call(acc, path, { method = 'GET', body, retry = 2 } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
    if (acc?.token) headers.Authorization = 'Bearer ' + acc.token;
    try {
      return await request(base + path, { method, headers, body: body && JSON.stringify(body) });
    } catch (e) {
      if (e.status === 401 && acc && retry > 0) { await login(acc); return call(acc, path, { method, body, retry: retry - 1 }); }
      if (e.status === 429 && retry > 0) { await sleep(1500); return call(acc, path, { method, body, retry: retry - 1 }); }
      throw e;
    }
  }
  async function login(acc) {
    const j = await call(null, '/token', { method: 'POST', body: { address: acc.address, password: acc.password } });
    acc.token = j.token; acc.id = j.id || acc.id;
    save();
  }
  // Ответы бывают обычным массивом или в формате Hydra { "hydra:member": [...] }
  const list = j => Array.isArray(j) ? j : (j?.['hydra:member'] || []);

  return {
    kind: base, name, checkUrl: base + '/domains',
    async create() {
      const domains = list(await call(null, '/domains')).filter(d => d.isActive !== false && !d.isPrivate);
      if (!domains.length) throw new Error('нет доступных доменов');
      const domain = domains[Math.floor(Math.random() * domains.length)].domain;
      const acc = { kind: base, api: base, address: `${randomLogin()}@${domain}`, password: randomPassword() };
      acc.id = (await call(null, '/accounts', { method: 'POST', body: { address: acc.address, password: acc.password } })).id;
      await login(acc);
      return acc;
    },
    async list(acc) { return list(await call(acc, '/messages?page=1', { acc })); },
    async get(acc, id) {
      const m = await call(acc, '/messages/' + id);
      return { from: m.from, createdAt: m.createdAt, html: Array.isArray(m.html) ? m.html.join('') : (m.html || ''), text: m.text || '' };
    },
    markSeen: (acc, id) => call(acc, '/messages/' + id, { method: 'PATCH', body: { seen: true } }),
    remove: (acc, id) => call(acc, '/messages/' + id, { method: 'DELETE' }),
    destroy: acc => call(acc, '/accounts/' + acc.id, { method: 'DELETE' }),
  };
}

// Разбирает "Имя <addr@host>" на части
function parseFrom(s = '') {
  const m = String(s).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: String(s).trim() };
}
// Дата в ISO из чего угодно: число (сек или мс), строка. Непонятную дату заменяем на «сейчас»,
// чтобы одно странное письмо не ломало весь список
function isoDate(v) {
  if (typeof v === 'string' && /^\d+$/.test(v)) v = Number(v);
  if (typeof v === 'number' && v < 1e12) v *= 1000;      // секунды → миллисекунды
  const d = new Date(v ?? Date.now());
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}
const stripHtml = h => new DOMParser().parseFromString(h || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();

// tempmail.lol: ящик живёт около часа, письма отдаются списком целиком.
// id у писем нет — составляем из даты, отправителя и темы. Полученные письма держим в памяти.
const lolCache = new Map();   // address → Map(id → письмо)
const tempmailLol = {
  kind: 'tempmail.lol', name: 'tempmail.lol', checkUrl: 'https://api.tempmail.lol/v2/inbox?token=check',
  async create() {
    const j = await request('https://api.tempmail.lol/v2/inbox/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    if (!j?.address || !j?.token) throw new Error('сервис вернул пустой ответ');
    return { kind: this.kind, address: j.address, token: j.token };
  },
  async list(acc) {
    const j = await request('https://api.tempmail.lol/v2/inbox?token=' + encodeURIComponent(acc.token));
    if (j.expired) { const e = new Error('ящик истёк'); e.status = 410; throw e; }
    const cache = lolCache.get(acc.address) || new Map();
    lolCache.set(acc.address, cache);
    for (const m of j.emails || []) {
      const id = String(m.id ?? m._id ?? [m.date ?? m.createdAt, m.from, m.subject].join('|'));
      cache.set(id, m);
    }
    return [...cache].map(([id, m]) => ({
      id, from: parseFrom(m.from), subject: m.subject, intro: (m.body || stripHtml(m.html)).slice(0, 160),
      createdAt: isoDate(m.date ?? m.createdAt),
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async get(acc, id) {
    const m = lolCache.get(acc.address)?.get(id);
    if (!m) throw new Error('письмо больше недоступно');
    return { from: parseFrom(m.from), createdAt: isoDate(m.date ?? m.createdAt), html: m.html || '', text: m.body || m.text || '' };
  },
  async remove(acc, id) { lolCache.get(acc.address)?.delete(id); },
};

// Guerrilla Mail: сессия по sid_token, после ~18 минут без запросов её можно восстановить по имени ящика
const GM = 'https://api.guerrillamail.com/ajax.php';
const gm = (params, acc) => request(GM + '?' + new URLSearchParams({ ...params, ...(acc ? { sid_token: acc.token } : {}) }));
const guerrilla = {
  kind: 'guerrilla', name: 'guerrillamail.com', checkUrl: GM + '?f=get_email_address',
  async create() {
    const j = await gm({ f: 'get_email_address', lang: 'en' });
    if (!j?.email_addr) throw new Error('сервис вернул пустой ответ');
    return { kind: this.kind, address: j.email_addr, token: j.sid_token, user: j.email_addr.split('@')[0], touched: Date.now() };
  },
  async list(acc) {
    if (Date.now() - (acc.touched || 0) > 10 * 60 * 1000) {       // сессия могла истечь — восстанавливаем ящик
      const j = await gm({ f: 'set_email_user', email_user: acc.user, lang: 'en' }, acc);
      if (j.sid_token) acc.token = j.sid_token;
    }
    const j = await gm({ f: 'get_email_list', offset: 0 }, acc);
    if (j.sid_token) acc.token = j.sid_token;
    acc.touched = Date.now();
    save();
    return (j.list || [])
      .filter(m => !/guerrillamail\.com$/i.test(m.mail_from || ''))     // приветственное письмо самого сервиса
      .map(m => ({
        id: String(m.mail_id), from: parseFrom(m.mail_from), subject: m.mail_subject, intro: stripHtml(m.mail_excerpt),
        createdAt: isoDate(m.mail_timestamp),
      }));
  },
  async get(acc, id) {
    const m = await gm({ f: 'fetch_email', email_id: id }, acc);
    return { from: parseFrom(m.mail_from), createdAt: isoDate(m.mail_timestamp), html: m.mail_body || '', text: '' };
  },
  remove: (acc, id) => gm({ f: 'del_email', 'email_ids[]': id }, acc),
};

const PROVIDERS = [
  mailTm('https://api.mail.tm', 'mail.tm'),
  mailTm('https://api.mail.gw', 'mail.gw'),
  tempmailLol,
  guerrilla,
];
// старые адреса сохранены без kind — это mail.tm/mail.gw, у них kind = адрес API
const providerOf = acc => PROVIDERS.find(p => p.kind === (acc.kind || acc.api));

// Прочитанность: mail.tm помнит её сам, для остальных храним локально
// Прочитанность помним локально; mail.tm дополнительно хранит её у себя
const isSeen = (acc, m) => !!m.seen || (state.seen[acc.address] || []).includes(m.id);
function markSeen(acc, id) {
  providerOf(acc).markSeen?.(acc, id).catch(() => {});
  (state.seen[acc.address] ||= []).push(id);
  save();
}

async function createAccount() {
  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const acc = await p.create();
      acc.createdAt = Date.now();
      return acc;
    } catch (e) { errors.push({ name: p.name, url: p.checkUrl, msg: netError(e) }); }
  }
  const err = new Error('все сервисы недоступны');
  err.details = errors;
  throw err;
}

// ---------- действия ----------
// Адрес всегда один: новый заменяет старый, а старый удаляется вместе с письмами.
// Старый удаляем только после того, как новый точно создан, — иначе можно остаться ни с чем.
async function onCreate(btn) {
  const old = currentAcc();
  if (old && !confirm(`Создать новый адрес?\n${old.address} и его письма удалятся.`)) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Создаю…';
  $('create-error').hidden = true;
  try {
    const acc = await createAccount();
    const previous = state.accounts;
    state.accounts = [acc];
    state.current = acc.address;
    state.known = { [acc.address]: [] };
    state.seen = {};
    box = {};
    save();
    saveBox();
    for (const a of previous) providerOf(a)?.destroy?.(a).catch(() => {});   // ящик мог уже исчезнуть у сервиса
    messages = storedList(acc);
    render();
    startPolling();
    const copied = await copy(acc.address);
    toast(copied ? 'Почта создана и скопирована' : 'Почта создана');
  } catch (e) {
    showCreateError(e.details || [{ msg: netError(e) }]);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

// Ошибку показываем карточкой, а не тостом: по ней нужно понять, что делать дальше
function showCreateError(details) {
  const box = $('create-error');
  const ul = $('create-error-list');
  ul.innerHTML = '';
  for (const d of details) {
    const li = el('li');
    if (d.url) {
      const a = el('a', '', d.name);
      a.href = d.url; a.target = '_blank'; a.rel = 'noopener';
      li.append(a, ': ');
    }
    li.append(d.msg);
    ul.append(li);
  }
  box.hidden = false;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // запасной путь для старых Safari
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {}
    ta.remove(); return ok;
  }
}

async function poll() {
  const acc = currentAcc();
  if (!acc || polling || document.hidden) return;
  polling = true;
  setStatus('busy', 'Проверяю…');
  try {
    const fresh = await providerOf(acc).list(acc);
    if (acc !== currentAcc()) return;      // пока ждали ответ, переключили адрес
    // объединяем с сохранёнными: письмо остаётся, даже если сервис его уже не отдаёт
    const b = boxOf(acc.address);
    const deleted = new Set(b.deleted);
    const byId = new Map(b.list.map(m => [m.id, m]));
    for (const m of fresh) if (!deleted.has(m.id)) byId.set(m.id, { ...m, seen: undefined });
    b.list = [...byId.values()]
      .sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)))
      .slice(0, MAX_PER_BOX);
    const ids = new Set(b.list.map(m => m.id));
    for (const id of Object.keys(b.full)) if (!ids.has(id)) delete b.full[id];
    for (const m of fresh) if (m.seen && !isSeen(acc, { id: m.id })) (state.seen[acc.address] ||= []).push(m.id);

    const known = new Set(state.known[acc.address] || []);
    const arrived = b.list.filter(m => !known.has(m.id));
    state.known[acc.address] = [...ids];
    save();
    saveBox();
    messages = storedList(acc);
    if (arrived.length) prefetch(acc, arrived.map(m => m.id));
    renderInbox(new Set(arrived.map(m => m.id)));
    if (arrived.length) {
      toast(arrived.length === 1 ? 'Новое письмо: ' + (arrived[0].subject || 'без темы') : `Новых писем: ${arrived.length}`);
    }
    updateBadge();
    setStatus('ok', 'Обновлено ' + timeShort(new Date()));
  } catch (e) {
    setStatus('off', e.status === 401 || e.status === 410 ? 'Ящик удалён сервисом' : 'Ошибка: ' + netError(e) + ', повторю');
  } finally {
    polling = false;
  }
}

// Сразу скачиваем новые письма целиком: код откроется мгновенно и останется после перезагрузки
async function prefetch(acc, ids) {
  const b = boxOf(acc.address);
  for (const id of ids) {
    if (b.full[id]) continue;
    try { b.full[id] = await providerOf(acc).get(acc, id); saveBox(); } catch {}
  }
}

function startPolling() {
  clearInterval(pollTimer);
  if (!currentAcc()) return;
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

// Значок с числом непрочитанных на иконке (iOS 16.4+ для приложения на экране «Домой»)
function updateBadge() {
  const unread = messages.filter(m => !m.seen).length;
  try { unread ? navigator.setAppBadge?.(unread) : navigator.clearAppBadge?.(); } catch {}
}

async function openMessage(id) {
  const acc = currentAcc();
  openedId = id;
  const sheet = $('sheet');
  const preview = messages.find(m => m.id === id);
  $('msg-subject').textContent = preview?.subject || '(без темы)';
  $('msg-meta').textContent = preview ? fromText(preview.from) : '';
  $('msg-actions').innerHTML = '';
  $('msg-content').innerHTML = '<pre>Загружаю письмо…</pre>';
  openSheet(sheet);

  try {
    const b = boxOf(acc.address);
    const m = b.full[id] || await providerOf(acc).get(acc, id);
    if (!b.full[id]) { b.full[id] = m; saveBox(); }
    if (openedId !== id) return;
    $('msg-meta').textContent = `${fromText(m.from)} · ${new Date(m.createdAt).toLocaleString('ru-RU')}`;
    renderActions(m.html, m.text);
    renderBody(m.html, m.text);
    if (preview && !preview.seen) {
      markSeen(acc, id);
      preview.seen = true;
      renderInbox(); updateBadge();
    }
  } catch (e) {
    $('msg-content').innerHTML = '';
    const pre = document.createElement('pre');
    pre.textContent = 'Не удалось загрузить письмо: ' + e.message;
    $('msg-content').appendChild(pre);
  }
}

async function deleteMessage() {
  const acc = currentAcc();
  if (!openedId || !confirm('Удалить это письмо?')) return;
  const id = openedId;
  try { await providerOf(acc).remove(acc, id); } catch {}   // не вышло на сервере — всё равно прячем у себя
  const b = boxOf(acc.address);
  b.deleted.push(id);
  b.list = b.list.filter(m => m.id !== id);
  delete b.full[id];
  saveBox();
  messages = messages.filter(m => m.id !== id);
  closeSheet($('sheet'));
  renderInbox(); updateBadge();
}


// ---------- разбор письма: ссылки подтверждения и коды ----------
const CONFIRM_RE = /verif|confirm|activat|valid|magic|sign.?in|log.?in|register|complete|continue|token|подтвер|актив|войти|вход|продолж|завершить/i;
const JUNK_RE = /unsubscribe|отпис|privacy|policy|terms|help|support|facebook|twitter|instagram|linkedin|youtube|t\.me|vk\.com|preferences|view.*browser/i;

function extractLinks(html, text) {
  const found = new Map();   // href → текст ссылки
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const a of doc.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href').trim();
      if (!/^https?:\/\//i.test(href) || found.has(href)) continue;
      found.set(href, (a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim());
    }
  }
  for (const href of text.match(/https?:\/\/[^\s<>"')\]]+/g) || []) {
    if (!found.has(href)) found.set(href, '');
  }
  const links = [...found].map(([href, label]) => ({ href, label }))
    .filter(l => !JUNK_RE.test(l.href + ' ' + l.label));
  // сначала то, что похоже на подтверждение
  const score = l => (CONFIRM_RE.test(l.label) ? 2 : 0) + (CONFIRM_RE.test(l.href) ? 1 : 0);
  return links.sort((a, b) => score(b) - score(a)).map(l => ({ ...l, main: score(l) > 0 }));
}

function extractCodes(html, text) {
  const plain = (text || new DOMParser().parseFromString(html, 'text/html').body.textContent || '').replace(/\s+/g, ' ');
  const codes = new Set();
  // 1) число или код из букв и цифр рядом со словом «код» / «code»
  const near = /(?:code|код|pin|otp|пароль|password)[^0-9A-Za-zА-я]{0,40}?([A-Z0-9]{4,8}|\d{3}[ -]\d{3})(?![A-Za-z0-9])/gi;
  for (const m of plain.matchAll(near)) if (/\d/.test(m[1])) codes.add(m[1].replace(/[ -]/g, ''));
  // 2) иначе — отдельные числа из 4–8 цифр, кроме похожих на год
  if (!codes.size) {
    for (const m of plain.matchAll(/(?<![\d.,:/-])\d{4,8}(?![\d.,:/-])/g)) {
      if (!/^(19|20)\d\d$/.test(m[0])) codes.add(m[0]);
    }
  }
  return [...codes].slice(0, 3);
}

function renderActions(html, text) {
  const box = $('msg-actions');
  box.innerHTML = '';
  const codes = extractCodes(html, text);
  const links = extractLinks(html, text);
  const main = links.filter(l => l.main).slice(0, 3);
  const shown = main.length ? main : links.slice(0, 2);

  if (codes.length) box.append(el('p', 'action-title', 'Код из письма'));
  for (const c of codes) {
    const b = el('button', 'code');
    b.type = 'button';
    b.append(el('b', '', c), el('small', '', 'Копировать'));
    b.onclick = async () => toast(await copy(c) ? 'Код скопирован' : 'Не удалось скопировать');
    box.append(b);
  }
  if (shown.length) box.append(el('p', 'action-title', main.length ? 'Ссылка подтверждения' : 'Ссылки из письма'));
  shown.forEach((l, i) => {
    const a = el('a', 'action-link' + (main.length && i === 0 ? '' : ' secondary'));
    a.href = l.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    let host = ''; try { host = new URL(l.href).hostname.replace(/^www\./, ''); } catch {}
    a.append(el('span', '', l.label || 'Открыть ссылку'), el('small', '', host + ' ↗'));
    box.append(a);
  });
}

function renderBody(html, text) {
  const box = $('msg-content');
  box.innerHTML = '';
  if (!html) {
    box.append(el('pre', '', text || '(пустое письмо)'));
    return;
  }
  // Письмо показываем в песочнице: скрипты запрещены, ссылки открываются в Safari.
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <base target="_blank">
    <style>body{margin:12px;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#111;overflow-wrap:anywhere}
    img{max-width:100%;height:auto}table{max-width:100%!important}</style>
    </head><body>${html}</body></html>`;
  const fit = () => {
    try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 'px'; } catch {}
  };
  frame.onload = () => { fit(); setTimeout(fit, 400); setTimeout(fit, 1500); };   // картинки догружаются позже
  box.append(frame);
}

// ---------- отрисовка ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
const fromText = f => f ? (f.name ? `${f.name} <${f.address}>` : f.address) : '';

function timeShort(d) {
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function timeAgo(iso) {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин';
  if (s < 86400) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function setStatus(kind, text) {
  $('status').className = 'status ' + kind;
  $('status-text').textContent = text;
}

function render() {
  const acc = currentAcc();
  $('empty').hidden = !!acc;
  $('current').hidden = !acc;
  $('inbox-wrap').hidden = !acc;
  if (acc) {
    $('address').textContent = acc.address;
    $('provider').textContent = providerOf(acc)?.name || '';
  }
  renderInbox();
}

function renderInbox(newIds = new Set()) {
  const ul = $('inbox');
  ul.innerHTML = '';
  $('inbox-empty').hidden = messages.length > 0;
  for (const m of messages) {
    const li = document.createElement('li');
    const b = el('button', 'mail' + (m.seen ? '' : ' unread') + (newIds.has(m.id) ? ' new' : ''));
    b.type = 'button';
    const top = el('div', 'mail-top');
    top.append(el('span', 'mail-from', m.from?.name || m.from?.address || 'Неизвестно'), el('span', 'mail-time', timeAgo(m.createdAt)));
    b.append(top, el('div', 'mail-subject', m.subject || '(без темы)'), el('div', 'mail-intro', m.intro || ''));
    b.onclick = () => openMessage(m.id);
    li.append(b);
    ul.append(li);
  }
}


function openSheet(s) { s.hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheet(s) {
  s.hidden = true;
  document.body.style.overflow = '';
  if (s.id === 'sheet') openedId = null;
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- события ----------
$('btn-create-first').onclick = e => onCreate(e.currentTarget);
$('btn-create').onclick = e => onCreate(e.currentTarget);
$('btn-copy').onclick = async () => toast(await copy(currentAcc().address) ? 'Адрес скопирован' : 'Не удалось скопировать');
$('address').onclick = () => $('btn-copy').click();
$('btn-back').onclick = () => closeSheet($('sheet'));
$('btn-delete-msg').onclick = deleteMessage;

// вернулись в приложение — сразу проверяем почту
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('online', poll);

messages = storedList(currentAcc());
render();
startPolling();

// просим браузер не стирать данные сайта при нехватке места
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
