'use strict';

const API = 'https://back-nortec.datpro2.dk';
const NTFY = 'https://ntfy.sh';
const CALENDAR_ID = 2;
const RETURN_OK = 100;
const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const E_VASKERI_APP = 'intent://#Intent;package=dk.nortec.elaundry;end';
const WASH_PAUSE_DAYS = 10;

const $ = (id) => document.getElementById(id);
const saved = JSON.parse(localStorage.getItem('vaskeri') || '{}');
const save = () => localStorage.setItem('vaskeri', JSON.stringify(saved));

let view = { days: [], remaining: 0, place: '' };
let daysShown = 31;
let loading = false;

class LoginRejected extends Error {}

async function api(path, params) {
  const query = new URLSearchParams({ App: 'TUK', ...params, tick: Date.now(), native: 'false' });
  let response;
  try {
    // Skal slutte på ".json" uden "=", ellers svarer serveren med en HTML-side.
    response = await fetch(`${API}/${path}/?${query}&.json`, { cache: 'no-store' });
    return await response.json();
  } catch {
    throw new Error('Ingen forbindelse til e-vaskeri');
  }
}

async function login() {
  const data = await api('User/Login4', {
    session: '', username: saved.user, password: saved.password,
    language: 'da', guid: '', domain: 'https://e-vaskeri.dk',
  });
  if (data.Return !== RETURN_OK || !data.Session) throw new LoginRejected('Forkert login');
  saved.session = data.Session;
  save();
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
const localDate = (iso) => new Date(`${iso}T00:00:00`);
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shortDate = (iso) => { const d = localDate(iso); return `${d.getDate()}/${d.getMonth() + 1}`; };
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

function isoWeek(date) {
  const d = new Date(date);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
}

function slotKind(turn) {
  if (turn.Type === 7 || (turn.Occupied || []).includes(7)) return 'mine';
  if (turn.Type === 0) return 'free';
  if (turn.Type === 5) return 'max';
  if (turn.Type === 3) return 'past';
  return 'taken';
}

function parseCalendar(data) {
  const section = data.Sections[0];
  const raw = section.Rows[0].Calendar;
  const days = raw.Days.map((day) => {
    let minutes = raw.Start;
    const slots = day.Turns.map((turn, index) => {
      const crop = Math.min(turn.Crop, 0);
      const start = minutes + crop;
      minutes += turn.Duration + crop;
      return {
        index, start: clock(start), end: clock(start + turn.Duration),
        kind: slotKind(turn), token: turn.Session || null,
      };
    });
    return { date: day.Date.slice(0, 10), slots };
  });
  return { days, remaining: raw.Remaning, place: section.Title || 'Vasketider', session: data.Session };
}

async function fetchCalendar(retry = true) {
  const data = await api('Location/Calendar5', {
    session: saved.session || '', date: '', days: daysShown, calendarid: CALENDAR_ID,
  });
  if (data.Return !== RETURN_OK) {
    if (!retry) throw new Error('Kalenderen kunne ikke hentes');
    await login();
    return fetchCalendar(false);
  }
  const calendar = parseCalendar(data);
  // Kun sessionen fra toppen af svaret. Tokens på de enkelte tider booker, hvis de sendes.
  saved.session = calendar.session;
  save();
  view = calendar;
  return calendar;
}

async function refresh() {
  if (loading) return;
  loading = true;
  $('refresh').disabled = true;
  try {
    await fetchCalendar();
    render();
    syncPause();
  } catch (error) {
    if (error instanceof LoginRejected) return showLogin('Login blev afvist. Tjek dit password.');
    toast(error.message);
  } finally {
    loading = false;
    $('refresh').disabled = false;
  }
}

function render() {
  const calendar = $('calendar');
  calendar.replaceChildren();
  $('place').textContent = view.place;
  $('status').textContent = `Bookinger tilbage: ${view.remaining}`;
  renderPause();
  if (!view.days.length) return;

  const head = el('div', 'row head');
  head.append(el('span'));
  view.days[0].slots.forEach((slot) => head.append(el('span', '', slot.start)));
  calendar.append(head);

  const today = isoDate(new Date());
  const pausedUntil = activePause();
  let week = null;
  for (const day of view.days) {
    const date = localDate(day.date);
    const dayWeek = isoWeek(date);
    if (dayWeek !== week) {
      week = dayWeek;
      calendar.append(el('div', 'week', `Uge ${week}`));
    }
    const row = el('div', 'row');
    row.id = `d${day.date}`;
    if (day.date === today) row.classList.add('today');
    if (pausedUntil && day.date < pausedUntil) row.classList.add('dimmed');
    const label = el('div', 'day');
    label.append(el('strong', '', day.date === today ? 'i dag' : WEEKDAYS[date.getDay()]), el('span', '', shortDate(day.date)));
    row.append(label);
    day.slots.forEach((slot) => row.append(cell(day, slot)));
    calendar.append(row);
  }
  flashHash();
}

function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const CELL_TEXT = { free: 'Fri', mine: 'Min tur', max: 'Maks', taken: '–', past: '' };

function cell(day, slot) {
  const interactive = slot.kind === 'free' || slot.kind === 'mine' || slot.kind === 'max';
  const node = el(interactive ? 'button' : 'div', `cell ${slot.kind}`, CELL_TEXT[slot.kind]);
  if (interactive) {
    node.setAttribute('aria-label', `${describe(day, slot)}, ${CELL_TEXT[slot.kind]}`);
    node.addEventListener('click', () => openSlot(day, slot));
  }
  return node;
}

function describe(day, slot) {
  return `${WEEKDAYS[localDate(day.date).getDay()]} ${shortDate(day.date)} ${slot.start}–${slot.end}`;
}

function flashHash() {
  const date = location.hash.slice(1);
  const row = /^\d{4}-\d{2}-\d{2}$/.test(date) && $(`d${date}`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  history.replaceState(null, '', location.pathname);
}

function sheet(...nodes) {
  $('sheetBody').replaceChildren(...nodes);
  $('sheet').showModal();
}

function action(text, className, onClick) {
  const button = el('button', className, text);
  button.addEventListener('click', onClick);
  return button;
}

const closeButton = (text = 'Luk') => action(text, 'secondary', () => $('sheet').close());

function appLink() {
  const link = el('a', 'button', 'Åbn e-vaskeri-appen');
  link.href = E_VASKERI_APP;
  return link;
}

function openSlot(day, slot) {
  const title = el('h2', '', describe(day, slot));
  if (slot.kind === 'mine') {
    return sheet(title, el('p', 'muted', 'Det er din tid. Afbestil den i e-vaskeri-appen.'), appLink(), closeButton());
  }
  if (slot.kind === 'max') {
    return sheet(title, el('p', 'muted', 'Tiden er ledig, men du har brugt alle dine bookinger.'), closeButton());
  }
  const confirm = action('Book denne tid', 'primary', () => book(day.date, slot.index, confirm));
  sheet(title, el('p', 'muted', `Du har ${view.remaining} booking(er) tilbage.`), confirm, closeButton('Annuller'));
}

async function book(date, index, button) {
  button.disabled = true;
  button.textContent = 'Booker...';
  try {
    // Hent friske data: tiden kan være taget, og et gammelt token virker måske ikke.
    await fetchCalendar();
    const slot = view.days.find((d) => d.date === date)?.slots[index];
    if (slot?.kind !== 'free' || !slot.token) {
      render();
      $('sheet').close();
      return toast('Tiden er desværre taget');
    }
    const data = await api('Location/Calendar5', {
      session: slot.token, date: `#${date}`, days: 8, calendarid: CALENDAR_ID,
    });
    let confirmed = false;
    if (data.Return === RETURN_OK) {
      const result = parseCalendar(data);
      saved.session = result.session;
      save();
      confirmed = result.days.find((d) => d.date === date)?.slots[index]?.kind === 'mine';
    }
    $('sheet').close();
    toast(confirmed ? 'Booket!' : 'Kunne ikke bekræfte. Tjek kalenderen.');
  } catch (error) {
    $('sheet').close();
    toast(`${error.message}. Tjek kalenderen.`);
  }
  await refresh();
}

// Pause styres via det samme ntfy-emne som knappen i notifikationerne.
function activePause() {
  return saved.pauseUntil && saved.pauseUntil > isoDate(new Date()) ? saved.pauseUntil : null;
}

function renderPause() {
  const until = activePause();
  const chip = $('pauseChip');
  chip.textContent = until ? `Pause: ingen besked før ${shortDate(until)}` : 'Har du lige vasket?';
  chip.classList.toggle('on', Boolean(until));
}

const controlUrl = () => `${NTFY}/${encodeURIComponent(saved.topic)}-styring`;

async function sendCommand(command, until) {
  $('sheet').close();
  try {
    const response = await fetch(controlUrl(), { method: 'POST', body: command });
    if (!response.ok) throw new Error();
  } catch {
    return toast('Kunne ikke sende til ntfy');
  }
  saved.pauseUntil = until;
  save();
  render();
  toast(until ? `Ingen besked før ${shortDate(until)}` : 'Pause slået fra');
}

function pauseDays(days) {
  sendCommand(`pause ${days}`, isoDate(addDays(new Date(), days)));
}

function openPause() {
  if (!saved.topic) {
    return sheet(el('h2', '', 'Pause'), el('p', 'muted', 'Indtast dit ntfy-emne under ☰ først.'), closeButton());
  }
  const nodes = [
    el('h2', '', 'Pause for afbud'),
    el('p', 'muted', 'Skjuler tider i den valgte periode. Senere afbud giver stadig besked.'),
    action(`Har vasket (${WASH_PAUSE_DAYS} dage)`, 'primary', () => pauseDays(WASH_PAUSE_DAYS)),
    action('3 dage', 'secondary', () => pauseDays(3)),
    action('7 dage', 'secondary', () => pauseDays(7)),
    action('14 dage', 'secondary', () => pauseDays(14)),
  ];
  if (activePause()) nodes.push(action('Slå pause fra', 'secondary', () => sendCommand('resume', null)));
  nodes.push(closeButton());
  sheet(...nodes);
}

// En pause sat fra notifikationen kendes kun af ntfy, så den hentes herfra.
async function syncPause() {
  if (!saved.topic) return;
  try {
    const response = await fetch(`${controlUrl()}/json?poll=1&since=12h`);
    const messages = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    for (const message of messages) {
      if (message.event !== 'message') continue;
      const sent = new Date(message.time * 1000);
      const [word, days] = (message.message || '').trim().toLowerCase().split(/\s+/);
      if (word === 'washed') saved.pauseUntil = isoDate(addDays(sent, WASH_PAUSE_DAYS));
      else if (word === 'pause' && /^\d+$/.test(days || '')) saved.pauseUntil = isoDate(addDays(sent, Number(days)));
      else if (word === 'resume') saved.pauseUntil = null;
    }
    save();
    render();
  } catch {
    // Pausevisningen er ikke vigtig nok til at forstyrre.
  }
}

function openMenu() {
  const topic = el('input');
  topic.value = saved.topic || '';
  topic.autocapitalize = 'off';
  topic.spellcheck = false;
  const label = el('label', '', 'ntfy-emne');
  label.append(topic);
  sheet(
    el('h2', '', 'Indstillinger'),
    label,
    action('Gem', 'primary', () => {
      saved.topic = topic.value.trim();
      save();
      $('sheet').close();
      syncPause();
    }),
    appLink(),
    action('Log ud', 'secondary', () => {
      localStorage.removeItem('vaskeri');
      location.reload();
    }),
    closeButton(),
  );
}

let toastTimer;
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

function showLogin(message) {
  $('app').hidden = true;
  $('login').hidden = false;
  $('user').value = saved.user || '';
  $('topicLogin').value = saved.topic || '';
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
}

async function submitLogin(event) {
  event.preventDefault();
  saved.user = $('user').value.trim();
  saved.password = $('password').value;
  saved.topic = $('topicLogin').value.trim();
  $('loginButton').disabled = true;
  try {
    await login();
    $('password').value = '';
    showApp();
  } catch (error) {
    saved.password = '';
    saved.session = '';
    save();
    showLogin(error instanceof LoginRejected ? 'Forkert mobilnr. eller password.' : error.message);
  } finally {
    $('loginButton').disabled = false;
  }
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  refresh();
}

$('loginForm').addEventListener('submit', submitLogin);
$('refresh').addEventListener('click', refresh);
$('menu').addEventListener('click', openMenu);
$('pauseChip').addEventListener('click', openPause);
$('more').addEventListener('click', () => { daysShown += 30; refresh(); });
$('sheet').addEventListener('click', (event) => { if (event.target === $('sheet')) $('sheet').close(); });
window.addEventListener('hashchange', flashHash);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('app').hidden) refresh();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (saved.user && saved.password) showApp();
else showLogin();
