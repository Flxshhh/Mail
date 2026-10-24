// Hide Email — одноразовая почта в браузере.
// Почту принимает публичный сервис mail.tm (запасной — mail.gw с тем же API):
// сайт создаёт на нём ящик, хранит пароль в localStorage и раз в 5 секунд
// спрашивает, не пришло ли письмо. Своего сервера нет.

const PROVIDERS = ['https://api.mail.tm', 'https://api.mail.gw'];
const POLL_MS = 5000;
const STORE = 'hidemail-v1';

const $ = id => document.getElementById(id);

// ---------- состояние ----------
// accounts: [{ api, id, address, password, token, createdAt }]
// known: { [address]: [id письма, ...] } — чтобы понять, какие письма новые
let state = load();
let messages = [];          // письма текущего ящика
let openedId = null;        // открытое письмо
let pollTimer = null;
let polling = false;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && Array.isArray(s.accounts)) return { known: {}, ...s };
  } catch {}
  return { accounts: [], current: null, known: {} };
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {}
}
const currentAcc = () => state.accounts.find(a => a.address === state.current) || null;

// ---------- API ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Запрос к API. Сам обновляет токен на 401 и ждёт на 429 (лимит ~8 запросов/сек).
async function api(base, path, { method = 'GET', body, acc, retry = 2 } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
  if (acc?.token) headers.Authorization = 'Bearer ' + acc.token;

  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });

  if (res.status === 401 && acc && retry > 0) {
    await login(acc);
    return api(base, path, { method, body, acc, retry: retry - 1 });
  }
  if (res.status === 429 && retry > 0) {
    await sleep(1500);
    return api(base, path, { method, body, acc, retry: retry - 1 });
  }
  if (!res.ok) {
    let msg = res.status + '';
    try { const j = await res.json(); msg = j.detail || j['hydra:description'] || j.message || msg; } catch {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.status === 204 ? null : res.json();
}

// Ответы бывают в двух форматах: обычный массив или Hydra { "hydra:member": [...] }
const list = j => Array.isArray(j) ? j : (j?.['hydra:member'] || []);

async function login(acc) {
  const j = await api(acc.api, '/token', { method: 'POST', body: { address: acc.address, password: acc.password } });
  acc.token = j.token;
  acc.id = j.id || acc.id;
  save();
}

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

async function createAccount() {
  let lastErr;
  for (const base of PROVIDERS) {
    try {
      const domains = list(await api(base, '/domains')).filter(d => d.isActive !== false && !d.isPrivate);
      if (!domains.length) throw new Error('нет доступных доменов');
      const domain = domains[Math.floor(Math.random() * domains.length)].domain;
      const acc = { api: base, address: `${randomLogin()}@${domain}`, password: randomPassword(), createdAt: Date.now() };
      const created = await api(base, '/accounts', { method: 'POST', body: { address: acc.address, password: acc.password } });
      acc.id = created.id;
      await login(acc);
      return acc;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('сервис недоступен');
}

// ---------- действия ----------
async function onCreate(btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Создаю…';
  try {
    const acc = await createAccount();
    state.accounts.unshift(acc);
    state.current = acc.address;
    state.known[acc.address] = [];
    save();
    messages = [];
    closeSheet($('accounts'));
    render();
    startPolling();
    const copied = await copy(acc.address);
    toast(copied ? 'Почта создана и скопирована' : 'Почта создана');
  } catch (e) {
    toast('Не получилось создать почту: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
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
    const fresh = list(await api(acc.api, '/messages?page=1', { acc }));
    if (acc !== currentAcc()) return;      // пока ждали ответ, переключили адрес
    const known = new Set(state.known[acc.address] || []);
    const arrived = fresh.filter(m => !known.has(m.id));
    messages = fresh;
    state.known[acc.address] = fresh.map(m => m.id);
    save();
    renderInbox(new Set(arrived.map(m => m.id)));
    if (arrived.length) {
      toast(arrived.length === 1 ? 'Новое письмо: ' + (arrived[0].subject || 'без темы') : `Новых писем: ${arrived.length}`);
    }
    updateBadge();
    setStatus('ok', 'Обновлено ' + timeShort(new Date()));
  } catch (e) {
    setStatus('off', e.status === 401 ? 'Ящик удалён сервисом' : 'Нет связи, повторю');
  } finally {
    polling = false;
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
    const m = await api(acc.api, '/messages/' + id, { acc });
    if (openedId !== id) return;
    $('msg-meta').textContent = `${fromText(m.from)} · ${new Date(m.createdAt).toLocaleString('ru-RU')}`;
    const html = Array.isArray(m.html) ? m.html.join('') : (m.html || '');
    renderActions(html, m.text || '');
    renderBody(html, m.text || '');
    if (!m.seen) {
      api(acc.api, '/messages/' + id, { method: 'PATCH', body: { seen: true }, acc }).catch(() => {});
      if (preview) preview.seen = true;
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
  try {
    await api(acc.api, '/messages/' + openedId, { method: 'DELETE', acc });
    messages = messages.filter(m => m.id !== openedId);
    closeSheet($('sheet'));
    renderInbox(); updateBadge();
  } catch (e) { toast('Не удалось удалить: ' + e.message); }
}

async function deleteAccount(address) {
  const acc = state.accounts.find(a => a.address === address);
  if (!acc || !confirm(`Удалить ${address}?\nПисьма на этот адрес больше не придут.`)) return;
  try { await api(acc.api, '/accounts/' + acc.id, { method: 'DELETE', acc }); } catch {}  // ящик мог уже исчезнуть у сервиса
  state.accounts = state.accounts.filter(a => a !== acc);
  delete state.known[address];
  if (state.current === address) { state.current = state.accounts[0]?.address || null; messages = []; }
  save();
  render(); renderAccounts(); startPolling();
}

function switchAccount(address) {
  state.current = address;
  messages = [];
  save();
  closeSheet($('accounts'));
  render(); startPolling();
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
  $('acc-count').textContent = state.accounts.length;
  $('empty').hidden = !!acc;
  $('current').hidden = !acc;
  $('inbox-wrap').hidden = !acc;
  if (acc) $('address').textContent = acc.address;
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

function renderAccounts() {
  const ul = $('acc-list');
  ul.innerHTML = '';
  if (!state.accounts.length) ul.append(el('li', 'muted', 'Адресов пока нет.'));
  for (const a of state.accounts) {
    const li = el('li', 'acc' + (a.address === state.current ? ' active' : ''));
    const main = el('button', 'acc-main');
    main.type = 'button';
    main.append(el('div', 'acc-addr', a.address),
      el('div', 'acc-date', (a.address === state.current ? 'Открыт · ' : '') + 'создан ' + new Date(a.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
    main.onclick = () => switchAccount(a.address);
    const del = el('button', 'btn ghost danger', 'Удалить');
    del.type = 'button';
    del.onclick = () => deleteAccount(a.address);
    li.append(main, del);
    ul.append(li);
  }
}

function openSheet(s) { s.hidden = false; document.body.style.overflow = 'hidden'; }
function closeSheet(s) {
  s.hidden = true;
  if ($('sheet').hidden && $('accounts').hidden) document.body.style.overflow = '';
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
$('btn-acc-new').onclick = e => onCreate(e.currentTarget);
$('btn-copy').onclick = async () => toast(await copy(currentAcc().address) ? 'Адрес скопирован' : 'Не удалось скопировать');
$('address').onclick = () => $('btn-copy').click();
$('btn-back').onclick = () => closeSheet($('sheet'));
$('btn-delete-msg').onclick = deleteMessage;
$('btn-accounts').onclick = () => { renderAccounts(); openSheet($('accounts')); };
$('btn-acc-close').onclick = () => closeSheet($('accounts'));

// вернулись в приложение — сразу проверяем почту
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('online', poll);

render();
startPolling();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
