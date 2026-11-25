'use strict';

const API = 'https://back-nortec.datpro2.dk';
const NTFY = 'https://ntfy.sh';
// Vaskeriet appen åbner på, og som notifikationerne handler om.
const HOME_CALENDAR_ID = 4;
const ALL_CALENDARS = 0;
const RETURN_OK = 100;
const WEEKDAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
// Appen erklærer linktypen evaskeri://. Kun pakkenavnet åbner Google Play i stedet.
const E_VASKERI_APP = 'intent://open#Intent;scheme=evaskeri;package=dk.nortec.elaundry;end';
// Serveren opdaterer selv kun hvert par minutter, så oftere giver ingen nye tal.
const LIVE_MIN_GAP_MS = 2 * 60 * 1000;
const LIVE_TICK_MS = 1000;
// Telefonen tæller selv sekunderne ned, så maskinen behøver kun at rette uret en gang imellem.
const LIVE_SYNC_MS = 30 * 1000;
// Maskinens værdi for "ingen resttid", fx når programmet ikke er startet.
const NO_REMAINING_TIME = 2147483647;
const MACHINE_KIND = { Fri: 'free', Optaget: 'busy', Reserveret: 'reserved', Færdig: 'done' };
// En reserveret maskine kan startes, når din egen tid starter inden for så mange minutter.
const RESERVED_FOR_YOU_MINUTES = 60;
// Maskinens egen tekst er afkortet til displayet her ("Centri-").
const PHASE_TEXT = { Washer_Process_Spin: 'Centrifugering' };
const MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli',
  'august', 'september', 'oktober', 'november', 'december',
];
const SETTING_WEEKDAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const ALL_WEEKDAYS = SETTING_WEEKDAYS.join(',');
const SLOT_STARTS = ['07:30', '10:00', '12:30', '15:00', '17:30'];
// Samme navne og standardværdier som tjekkets .env, så de kan sendes direkte.
const DEFAULT_SETTINGS = {
  NOTIFY_ENABLED: 'true',
  NOTIFY_MAX_DAYS_AHEAD: '21',
  NOTIFY_URGENT_DAYS: '3',
  NOTIFY_MIN_LEAD_MINUTES: '30',
  NOTIFY_WEEKDAYS: ALL_WEEKDAYS,
  NOTIFY_EARLIEST_START: '',
  NOTIFY_LATEST_START: '',
  QUIET_START: '22:00',
  QUIET_END: '07:00',
  NOTIFY_NIGHT_DAYS: '2',
  WASH_PAUSE_DAYS: '10',
  NOTIFY_MACHINE_DONE: 'false',
  NOTIFY_MACHINE_ALMOST_DONE_MINUTES: '0',
  NOTIFY_BOOKING_REMINDER_MINUTES: '0',
  AUTOBOOK_ENABLED: 'false',
  AUTOBOOK_MAX_DAYS_AHEAD: '7',
  AUTOBOOK_WEEKDAYS: ALL_WEEKDAYS,
  AUTOBOOK_EARLIEST_START: '',
  AUTOBOOK_LATEST_START: '',
  AUTOBOOK_KEEP_FREE: '1',
  PREBOOK_RULE_ENABLED: 'false',
  PREBOOK_RULE_MAX_DAYS_AHEAD: '14',
  PREBOOK_RULE_WEEKDAYS: ALL_WEEKDAYS,
  PREBOOK_RULE_EARLIEST_START: '',
  PREBOOK_RULE_LATEST_START: '',
};

const $ = (id) => document.getElementById(id);
const saved = JSON.parse(localStorage.getItem('vaskeri') || '{}');
const save = () => localStorage.setItem('vaskeri', JSON.stringify(saved));

let view = { days: [], remaining: 0, place: '' };
let daysShown = 31;
let calendarId = saved.startLaundry || HOME_CALENDAR_ID;
let loading = false;
let refreshAgain = false;
let balance = null;
let bookings = [];
let running = new Set();
let live = null;
let liveFetched = 0;
let liveSynced = 0;

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
  const requested = calendarId;
  const data = await api('Location/Calendar5', {
    session: saved.session || '', date: '', days: daysShown, calendarid: calendarId,
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
  if (requested === calendarId) view = calendar;
  return calendar;
}

async function loadLaundries() {
  if (saved.laundries?.length) return;
  const data = await api('Location/Calendar5', {
    session: saved.session, date: '', days: 1, calendarid: ALL_CALENDARS,
  });
  if (data.Return !== RETURN_OK) return;
  saved.session = data.Session;
  saved.laundries = data.Sections.map((section) => ({
    id: section.Rows[0].Calendar.CalendarId, title: section.Title,
  }));
  save();
}

// Svaret har dag og måned, men intet år. En dato der er passeret, må høre til næste år.
function bookingDate(day, month) {
  const now = new Date();
  const index = MONTHS.indexOf(String(month).toLowerCase());
  if (index < 0) return null;
  const date = new Date(now.getFullYear(), index, day);
  if (isoDate(date) < isoDate(now)) date.setFullYear(now.getFullYear() + 1);
  return isoDate(date);
}

const shortMachine = (text) => text.replace('Vaskemaskine', 'Vask').replace('Tørretumbler', 'Tørre');

function machineList(names) {
  if (names.length === 1) return shortMachine(names[0]);
  const prefix = /^\D*/.exec(shortMachine(names[0]))[0];
  return prefix + names.map((name) => name.replace(/^\D*/, '')).join(', ');
}

// Book.Session sletter tiden, hvis det sendes, så det læses aldrig. En tid i gang står
// her med én række pr. maskine, så de samles til én booking.
function parseBookings(sections) {
  const merged = new Map();
  for (const section of sections) {
    for (const { Book: book } of section.Rows || []) {
      const infos = book?.Infos || [];
      const time = /(\d\d:\d\d) - (\d\d:\d\d)/.exec(infos.join(' '));
      const date = book && bookingDate(book.Day, book.Month);
      if (!time || !date) continue;
      const place = section.Description?.[0] || '';
      const key = `${place}|${date}|${time[1]}`;
      if (!merged.has(key)) merged.set(key, { place, date, start: time[1], end: time[2], names: [] });
      merged.get(key).names.push(...infos.filter((info) => !info.startsWith('kl.')));
    }
  }
  return [...merged.values()]
    .map(({ names, ...booking }) => ({ ...booking, machines: machineList(names) }))
    .sort((a, b) => `${a.date}${a.start}`.localeCompare(`${b.date}${b.start}`));
}

function parseRunning(sections) {
  return new Set(sections.filter((section) => section.Name === 'Live4').flatMap((section) => (
    section.Rows.flatMap((row) => row.Units || []).map((unit) => `${section.Description?.[0]}|${unit.Text}`)
  )));
}

// Forsiden er rar at have, men må aldrig forhindre kalenderen i at blive vist.
async function loadHome() {
  try {
    const data = await api('User/Home3', { session: saved.session, locationid: '' });
    if (data.Return !== RETURN_OK) return;
    saved.session = data.Session;
    save();
    const section = data.Sections.find((s) => s.Name === 'Saldo');
    balance = section?.Rows[0]?.Columns2?.Cells[1] || null;
    bookings = parseBookings(data.Sections);
    running = parseRunning(data.Sections);
  } catch {
    balance = null;
  }
}

function isActive(booking) {
  const now = new Date();
  const time = clock(now.getHours() * 60 + now.getMinutes());
  return booking.date === isoDate(now) && booking.start <= time && time < booking.end;
}

const bookingAt = (date, start) => bookings.find((booking) => (
  booking.place === view.place && booking.date === date && booking.start === start
));

function bookingRow(booking) {
  const active = isActive(booking);
  const row = el('button', active ? 'booking active' : 'booking');
  const when = dayText(booking.date);
  const where = booking.place === view.place ? booking.machines : `${booking.place} · ${booking.machines}`;
  row.append(el('strong', '', when), el('span', '', `${booking.start}–${booking.end}`), el('span', 'where', where));
  if (active) row.append(el('span', 'badge', 'I gang'));
  else if (isAutobooked(booking.place, booking.date, booking.start)) row.append(el('span', 'badge auto', 'Auto'));
  row.addEventListener('click', () => openBooking(booking));
  return row;
}

function prebookRow(key) {
  const date = key.slice(0, 10);
  const start = key.slice(11);
  const end = view.place && calendarId === HOME_CALENDAR_ID
    ? view.days.find((d) => d.date === date)?.slots.find((s) => s.start === start)?.end : null;
  const row = el('button', 'booking pre');
  row.append(
    el('strong', '', dayText(date)),
    el('span', '', end ? `${start}–${end}` : start), el('span', 'where'),
    el('span', 'badge', 'Venter'),
  );
  row.addEventListener('click', () => openPrebook(key));
  return row;
}

function untilText(minutes) {
  if (minutes < 60) return `om ${minutes} min`;
  if (minutes < 24 * 60) return `om ${Math.floor(minutes / 60)} t ${minutes % 60} min`;
  const days = Math.round(minutes / (24 * 60));
  return `om ${days} ${days === 1 ? 'dag' : 'dage'}`;
}

function dayText(date) {
  const today = new Date();
  if (date === isoDate(today)) return 'i dag';
  if (date === isoDate(addDays(today, 1))) return 'i morgen';
  return `${WEEKDAYS[localDate(date).getDay()]} ${shortDate(date)}`;
}

// Forsidens bookinger dækker alle vaskerier, så den næste tid vises uanset det valgte vaskeri.
function nextBooking() {
  const now = new Date();
  return bookings.find((b) => `${b.date} ${b.end}` > `${isoDate(now)} ${clock(now.getHours() * 60 + now.getMinutes())}`);
}

function renderNext() {
  const box = $('nextBooking');
  if (!box) return;
  const next = nextBooking();
  box.hidden = !next;
  if (!next) return;
  const startsAt = new Date(`${next.date}T${next.start}:00`);
  const minutes = Math.ceil((startsAt - new Date()) / 60000);
  const where = next.place === view.place ? next.machines : `${next.place} · ${next.machines}`;
  const when = minutes <= 0 ? `I gang, slutter ${next.end}` : `${dayText(next.date)} ${next.start}–${next.end}`;
  const auto = isAutobooked(next.place, next.date, next.start) ? ' · autobooket' : '';
  box.classList.toggle('active', minutes <= 0);
  box.replaceChildren(
    el('span', 'label', minutes <= 0 ? 'Din tid er i gang' : `Din næste tid · ${untilText(minutes)}`),
    el('strong', '', when), el('span', 'where', `${where}${auto}`),
  );
  box.onclick = () => openBooking(next);
}

function renderBookings() {
  const box = $('bookings');
  // En gemt index.html fra før bookinglisten kan møde en nyere app.js.
  if (!box) return;
  // Den næste tid står allerede i kortet øverst.
  const next = $('nextBooking') ? nextBooking() : null;
  const rest = bookings.filter((booking) => booking !== next);
  const waiting = prebooks();
  box.hidden = !rest.length && !waiting.length;
  box.querySelector('h2').textContent = next ? 'Senere' : 'Mine bookinger';
  // Bookinger og forhåndsbookinger i én liste efter tid.
  const rows = [
    ...rest.map((booking) => [`${booking.date} ${booking.start}`, bookingRow(booking)]),
    ...waiting.map((key) => [key, prebookRow(key)]),
  ].sort(([a], [b]) => a.localeCompare(b));
  $('bookingList').replaceChildren(...rows.map(([, row]) => row));
}

function openBooking(booking) {
  const day = view.days.find((d) => d.date === booking.date);
  const slot = booking.place === view.place ? day?.slots.find((s) => s.start === booking.start) : null;
  // Kun kalenderens eget token må slette, og kun mens tiden stadig står som din der.
  if (slot?.kind === 'mine') return openSlot(day, slot);
  const active = isActive(booking);
  sheet(
    el('h2', '', `${booking.date === isoDate(new Date()) ? 'I dag' : shortDate(booking.date)} ${booking.start}–${booking.end}`),
    el('p', '', booking.place),
    el('p', '', booking.machines),
    el('p', 'muted', active ? `Tiden er i gang og slutter ${booking.end}.` : 'Tiden kan slettes fra kalenderen for dette vaskeri.'),
    closeButton(),
  );
}

function remainingMinutes(process) {
  const hours = /(\d+)\s*tim/i.exec(process || '');
  const minutes = /(\d+)\s*min/i.exec(process || '');
  if (!hours && !minutes) return null;
  return Number(hours?.[1] || 0) * 60 + Number(minutes?.[1] || 0);
}

// Book.Session på en maskine reserverer den, hvis det sendes, så det gemmes aldrig.
function parseLive(data) {
  const now = Date.now();
  return data.Sections.map((section) => ({
    name: section.Name,
    title: section.Title,
    updated: section.Rows.find((row) => row.Columns2)?.Columns2.Cells[0] || '',
    units: section.Rows.flatMap((row) => row.Units || []).map((unit) => {
      const minutes = remainingMinutes(unit.Process);
      return {
        text: unit.Text, status: unit.Status || '', ref: unit.SVG || null,
        endsAt: minutes === null ? null : now + minutes * 60000, exact: false,
      };
    }),
  }));
}

const unescapeJs = (text) => text
  .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  .replace(/\\(.)/g, '$1');

function displayText(script, id) {
  const match = new RegExp(`getElementById\\('${id}\\w+'\\)\\.childNodes\\[0\\]\\.nodeValue='((?:[^'\\\\]|\\\\.)*)'`).exec(script);
  return match ? unescapeJs(match[1]).replace(/"/g, '').trim() : '';
}

// Svaret er JavaScript beregnet til at blive kørt i maskinens SVG. Her læses det kun som tekst.
function parseMachineState(script) {
  const seconds = Number(/\bB\w+=(-?\d+);/.exec(script)?.[1] ?? NaN);
  if (Number.isNaN(seconds)) return null;
  const process = /\bI\w+='(\w*)'/.exec(script)?.[1];
  return {
    seconds: seconds > 0 && seconds < NO_REMAINING_TIME ? seconds : null,
    done: process === 'Washer_Process_Done',
    program: displayText(script, 'P'),
    phase: PHASE_TEXT[process] || displayText(script, 'C'),
    percent: /p>(\d+)/.exec(script)?.[1] ?? null,
  };
}

async function syncMachine(unit) {
  try {
    const [folder, token] = unit.ref.split('/');
    const response = await fetch(`${API}/download/${folder}/Ajax.ashx?${token}`, { cache: 'no-store' });
    const state = parseMachineState(await response.text());
    if (!state) return;
    const { seconds, done, ...details } = state;
    Object.assign(unit, details);
    // Maskinen ved det med det samme. Den almindelige status følger først et par minutter efter.
    if (done) Object.assign(unit, { status: 'Færdig', endsAt: null, exact: false });
    if (seconds !== null) Object.assign(unit, { endsAt: Date.now() + seconds * 1000, exact: true });
  } catch {
    // Så viser maskinen bare hele minutter fra den almindelige status.
  }
}

async function syncMachines(sections = live) {
  liveSynced = Date.now();
  const units = liveSection(sections)?.units || [];
  await Promise.all(units.filter((unit) => unit.ref && MACHINE_KIND[unit.status] === 'busy').map(syncMachine));
}

// Ét kald dækker alle vaskerier, så skift af vaskeri koster ingen ekstra kald.
async function loadLive() {
  if (Date.now() - liveFetched < LIVE_MIN_GAP_MS) return;
  liveFetched = Date.now();
  try {
    const data = await api('Location/Live5', { session: saved.session });
    if (data.Return !== RETURN_OK) return;
    if (data.Session) {
      saved.session = data.Session;
      save();
    }
    const sections = parseLive(data);
    await syncMachines(sections);
    live = sections;
    renderLive();
  } catch {
    // Maskinstatus er rar at have, men må aldrig forstyrre kalenderen.
  }
}

const liveSection = (sections = live) => sections?.find((section) => section.title === view.place)
  || sections?.find((section) => section.name === `LiveL${calendarId}`);

const secondsLeft = (unit) => (unit.endsAt === null ? null : Math.max(0, Math.ceil((unit.endsAt - Date.now()) / 1000)));
const isMine = (section, unit) => running.has(`${section.title}|${unit.text}`);

// Din næste tid her, hvis den starter inden for RESERVED_FOR_YOU_MINUTES eller er i gang.
function turnSoon(place) {
  const now = new Date();
  const time = clock(now.getHours() * 60 + now.getMinutes());
  const limit = new Date(now.getTime() + RESERVED_FOR_YOU_MINUTES * 60000);
  const latest = clock(limit.getHours() * 60 + limit.getMinutes());
  return bookings.find((booking) => booking.place === place && booking.date === isoDate(now)
    && time < booking.end && (booking.start <= latest || limit.getDate() !== now.getDate()));
}

const isDryer = (unit) => /tørre/i.test(unit.text);
const machineKey = (section, unit) => `${section.title}|${unit.text}`;

// Reglerne i vaskeriet: den med tiden har 15 minutter til at starte, når tiden begynder, og til at
// starte igen, når en maskine er færdig. Derefter er maskinen fri for alle. Den sidste time før en
// tid er vaskemaskinerne låst til den, der har tiden. Tørretumblere kan ikke bookes.
const GRACE_MS = 15 * 60000;
const LOCK_BEFORE_MS = 60 * 60000;

// Hvornår maskinerne forventes færdige, og hvornår de blev det. Gemmes, så de 15 minutter
// overlever en genindlæsning. exact: vi så den køre, så tidspunktet er kendt.
function trackMachines(section) {
  const now = Date.now();
  const old = saved.machineTimes || {};
  const times = Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith(`${section.title}|`)));
  for (const unit of section.units) {
    const key = machineKey(section, unit);
    const kind = MACHINE_KIND[unit.status];
    const prev = old[key] || {};
    if (kind === 'busy' && unit.endsAt) times[key] = { endsAt: unit.endsAt };
    else if (kind === 'done' && prev.doneAt) times[key] = prev;
    else if (kind === 'done') {
      const seen = prev.endsAt && prev.endsAt <= now + 60000 && now - prev.endsAt < GRACE_MS;
      times[key] = { doneAt: seen ? Math.min(prev.endsAt, now) : now, exact: Boolean(seen) };
    }
  }
  if (JSON.stringify(times) === JSON.stringify(old)) return;
  saved.machineTimes = times;
  save();
}

// Tiderne i kalenderen for det viste vaskeri, som Date, med hvem der har dem.
function slotsAround(now) {
  const dates = [isoDate(now), isoDate(addDays(now, 1))];
  return view.days.filter((day) => dates.includes(day.date)).flatMap((day) => day.slots.map((slot) => ({
    start: new Date(`${day.date}T${slot.start}:00`),
    end: new Date(`${day.date}T${slot.end}:00`),
    owner: slot.kind === 'mine' ? 'mine' : slot.kind === 'taken' ? 'other' : 'none',
  })));
}

const timeOf = (date) => clock(date.getHours() * 60 + date.getMinutes());

// Hvad en maskine betyder for dig lige nu: { kind, until, exact, next }.
function machineState(section, unit) {
  const kind = MACHINE_KIND[unit.status] || 'other';
  if (kind === 'reserved' && turnSoon(section.title)) return { kind: 'yours' };
  if (isDryer(unit)) return { kind: kind === 'done' && !isMine(section, unit) ? 'free' : kind };
  if (isMine(section, unit) || !['done', 'reserved', 'free'].includes(kind)) return { kind };

  const now = new Date();
  const slots = slotsAround(now);
  let freeAt = null;
  let exact = true;
  if (kind === 'done') {
    const times = saved.machineTimes?.[machineKey(section, unit)];
    freeAt = times?.doneAt ? new Date(times.doneAt + GRACE_MS) : null;
    exact = Boolean(times?.exact);
  } else if (kind === 'reserved') {
    // De første 15 minutter af en tid venter maskinen på den, der har tiden.
    const current = slots.find((slot) => slot.start <= now && now < slot.end);
    if (current && now - current.start < GRACE_MS) freeAt = new Date(current.start.getTime() + GRACE_MS);
  }

  const next = slots.find((slot) => slot.start > now);
  const opensAt = freeAt && freeAt > now ? freeAt : now;
  if (next && next.owner !== 'none' && opensAt >= next.start - LOCK_BEFORE_MS) {
    if (next.owner === 'other') return { kind: 'locked', next };
    return freeAt && freeAt > now ? { kind: 'wait', until: freeAt, exact, next, toMine: true } : { kind: 'yours' };
  }
  if (freeAt && freeAt > now) return { kind: 'wait', until: freeAt, exact, next };
  // De 15 minutter er gået. e-vaskeri skifter først status et par minutter senere.
  return { kind: kind === 'done' ? 'free' : kind };
}

const minutesUntil = (date) => Math.max(1, Math.ceil((date - Date.now()) / 60000));
const DOOR_TEXT = { free: 'Fri', done: 'Klar', yours: 'Din', locked: 'Låst' };

function door(unit, state) {
  const node = el('span', 'door');
  const seconds = secondsLeft(unit);
  if (state.kind === 'wait') node.textContent = `${state.exact ? '' : '≤'}${minutesUntil(state.until)}`;
  else if (seconds === null) node.textContent = DOOR_TEXT[state.kind] || unit.status.slice(0, 3);
  else if (!unit.exact) node.textContent = String(Math.ceil(seconds / 60));
  else node.append(el('span', '', String(Math.floor(seconds / 60))), el('small', '', `:${pad(seconds % 60)}`));
  return node;
}

function stateText(unit, state) {
  if (state.kind === 'wait') {
    const who = state.toMine ? 'din' : 'fri for alle';
    return `${who} om ${state.exact ? '' : 'højst '}${minutesUntil(state.until)} min (kl. ${timeOf(state.until)})`;
  }
  if (state.kind === 'locked') return `låst til næste tid kl. ${timeOf(state.next.start)}`;
  if (state.kind === 'yours') return 'kan startes til din tid';
  return unit.status;
}

function machine(section, unit) {
  const seconds = secondsLeft(unit);
  const type = isDryer(unit) ? 'dryer' : 'washer';
  const owner = isMine(section, unit) ? ' mine' : '';
  const state = machineState(section, unit);
  const node = el('div', `machine ${type} ${state.kind}${state.toMine ? ' to-mine' : ''}${owner}`);
  const left = seconds === null ? '' : `, ${Math.ceil(seconds / 60)} minutter tilbage`;
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', `${unit.text}${owner ? ' (din)' : ''}: ${stateText(unit, state)}${left}`);
  node.append(door(unit, state), el('span', 'name', shortMachine(unit.text)));
  return node;
}

function machineDetail(unit) {
  const end = new Date(unit.endsAt);
  const parts = [
    unit.program, unit.phase, unit.percent && `${unit.percent} %`,
    unit.endsAt !== null && `færdig ${clock(end.getHours() * 60 + end.getMinutes())}`,
  ];
  return el('p', 'detail', `${shortMachine(unit.text)}: ${parts.filter(Boolean).join(' · ')}`);
}

function renderLive() {
  const box = $('live');
  // En gemt index.html fra før maskinstatus kan møde en nyere app.js.
  if (!box) return;
  const section = liveSection();
  box.hidden = !section?.units.length;
  if (box.hidden) return;
  trackMachines(section);
  $('liveUnits').replaceChildren(...section.units.map((unit) => machine(section, unit)));
  const details = section.units
    .filter((unit) => isMine(section, unit) && MACHINE_KIND[unit.status] === 'busy')
    .map(machineDetail);
  const states = section.units.map((unit) => [unit, machineState(section, unit)]);
  const soon = turnSoon(section.title);
  if (soon && states.some(([, state]) => state.kind === 'yours')) {
    details.push(el('p', 'detail', `Din tid ${soon.start}: de reserverede maskiner kan startes nu.`));
  }
  for (const [unit, state] of states.filter(([, s]) => s.kind === 'wait')) {
    details.push(el('p', 'detail', `${shortMachine(unit.text)}: ${stateText(unit, state)}`));
  }
  // Låste maskiner samles på én linje, de er låst til samme tid.
  const locked = states.filter(([, state]) => state.kind === 'locked');
  if (locked.length) {
    details.push(el('p', 'detail muted', `${machineList(locked.map(([unit]) => unit.text))}: ${stateText(...locked[0])}`));
  }
  $('liveDetails')?.replaceChildren(...details);
  $('liveUpdated').textContent = section.updated;
}

// Tæller ned på telefonen. Der hentes kun nyt, når en maskine burde være færdig.
function tickLive() {
  if (document.hidden || $('app').hidden || !live) return;
  renderLive();
  const finished = liveSection()?.units.some((unit) => unit.endsAt !== null && unit.endsAt <= Date.now());
  if (finished && !loading && !$('sheet').open) loadLive();
  if (Date.now() - liveSynced >= LIVE_SYNC_MS) syncMachines().then(renderLive);
}

function renderLaundries() {
  const laundries = saved.laundries?.length ? saved.laundries : [{ id: calendarId, title: view.place }];
  $('laundry').replaceChildren(...laundries.map(({ id, title }) => {
    const option = el('option', '', title);
    option.value = id;
    option.selected = id === calendarId;
    return option;
  }));
}

function switchLaundry(id) {
  calendarId = id;
  view = { days: [], remaining: 0, place: '' };
  $('calendar').replaceChildren();
  $('status').textContent = '';
  liveSynced = 0;
  renderLive();
  refresh();
}

async function refresh() {
  if (loading) {
    refreshAgain = true;
    return;
  }
  loading = true;
  $('refresh').disabled = true;
  $('refresh').classList.add('spin');
  if (!view.days.length) renderSkeleton();
  try {
    await fetchCalendar();
    render();
    await loadLaundries();
    renderLaundries();
    syncPause();
    syncPrebooks();
    // En tid i gang kendes kun fra forsiden, så kalenderen må tegnes igen for at vise den.
    loadHome().then(render).then(loadLive);
  } catch (error) {
    if (error instanceof LoginRejected) return showLogin('Login blev afvist. Tjek dit password.');
    toast(error.message);
  } finally {
    loading = false;
    $('refresh').disabled = false;
    $('refresh').classList.remove('spin');
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  }
}

function renderSkeleton() {
  const rows = [el('div', 'row head skeleton-head')];
  for (let i = 0; i < 8; i++) {
    const row = el('div', 'row skeleton');
    row.append(el('div', 'day'), ...Array.from({ length: 5 }, () => el('div', 'cell')));
    rows.push(row);
  }
  $('calendar').replaceChildren(...rows);
}

function renderStatus() {
  if (!view.days.length) return;
  $('status').textContent = `Bookinger tilbage: ${view.remaining}${balance ? ` · Saldo: ${balance}` : ''}`;
}

function render() {
  const calendar = $('calendar');
  calendar.replaceChildren();
  renderLaundries();
  renderPause();
  renderNext();
  renderBookings();
  renderHealth();
  renderLive();
  if (!view.days.length) return;
  renderStatus();

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
    if (calendarId === HOME_CALENDAR_ID && pausedUntil && day.date < pausedUntil) row.classList.add('dimmed');
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

const CELL_TEXT = { free: 'Fri', mine: 'Min tur', max: 'Maks', taken: '–', past: '', active: 'I gang', pre: 'Venter', auto: 'Auto' };

function cell(day, slot) {
  // Kalenderen viser en tid i gang som passeret. Kun forsiden ved, at den er din.
  // Listen fra forsiden kan være forældet lige efter en sletning, så tiden skal også være nu.
  const booking = slot.kind === 'mine' ? null : bookingAt(day.date, slot.start);
  const active = Boolean(booking) && isActive(booking);
  const waiting = slot.kind !== 'mine' && slot.kind !== 'past' && isPrebooked(day, slot);
  const kind = active ? 'active' : waiting ? 'pre' : slot.kind;
  const auto = kind === 'mine' && isAutobooked(view.place, day.date, slot.start);
  const interactive = ['free', 'mine', 'max', 'active', 'pre'].includes(kind)
    || (kind === 'taken' && calendarId === HOME_CALENDAR_ID);
  const node = el(interactive ? 'button' : 'div', `cell ${kind}${auto ? ' auto' : ''}`, CELL_TEXT[auto ? 'auto' : kind]);
  if (interactive) {
    node.setAttribute('aria-label', `${describe(day, slot)}, ${auto ? 'Min tur, booket automatisk' : CELL_TEXT[kind]}`);
    node.addEventListener('click', () => (active ? openBooking(booking) : openSlot(day, slot)));
  }
  return node;
}

function describe(day, slot) {
  return `${WEEKDAYS[localDate(day.date).getDay()]} ${shortDate(day.date)} ${slot.start}–${slot.end}`;
}

function flashHash() {
  const date = location.hash.slice(1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  // Notifikationer handler altid om hjemmevaskeriet.
  if (calendarId !== HOME_CALENDAR_ID) return switchLaundry(HOME_CALENDAR_ID);
  const row = $(`d${date}`);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flash');
  history.replaceState(null, '', location.pathname);
}

function sheet(...nodes) {
  $('sheetBody').replaceChildren(...nodes);
  if (!$('sheet').open) $('sheet').showModal();
  $('sheet').scrollTop = 0;
}

function action(text, className, onClick) {
  const button = el('button', className, text);
  button.addEventListener('click', onClick);
  return button;
}

const closeButton = (text = 'Luk') => action(text, 'secondary', () => $('sheet').close());

function openSlot(day, slot) {
  const title = el('h2', '', describe(day, slot));
  if (slot.kind === 'mine') {
    const auto = isAutobooked(view.place, day.date, slot.start)
      ? [el('p', 'muted', 'Booket automatisk. Er det din senest autobookede tid, slettes den, når en forhåndsbooking skal bruge pladsen.')] : [];
    return sheet(
      title, el('p', '', view.place), ...auto,
      action('Slet booking', 'danger', () => confirmCancel(day, slot)), closeButton(),
    );
  }
  if (isPrebooked(day, slot)) return openPrebook(slotKey(day, slot));
  if (slot.kind === 'taken') {
    return sheet(
      title, el('p', 'muted', 'Optaget af en anden.'),
      el('p', 'muted', 'Forhåndsbook, og tjekket booker tiden, hvis den bliver ledig. Har du ingen booking ledig, slettes din senest autobookede tid for at give plads.'),
      action('Forhåndsbook denne tid', 'primary', () => setPrebook(slotKey(day, slot), true)),
      closeButton(),
    );
  }
  if (slot.kind === 'max') {
    const nodes = [title, el('p', 'muted', 'Tiden er ledig, men du har brugt alle dine bookinger.')];
    if (calendarId === HOME_CALENDAR_ID) {
      nodes.push(
        el('p', 'muted', 'Forhåndsbook, og tjekket booker tiden, så snart du har en booking ledig. Har du en autobooking, slettes den senest autobookede for at give plads. Dine egne bookinger røres ikke.'),
        action('Forhåndsbook denne tid', 'primary', () => setPrebook(slotKey(day, slot), true)),
      );
    }
    return sheet(...nodes, closeButton());
  }
  const confirm = action('Book denne tid', 'primary', () => book(day.date, slot.index, confirm));
  sheet(
    title, el('p', '', view.place), el('p', 'muted', `Du har ${view.remaining} booking(er) tilbage her.`),
    confirm, closeButton('Annuller'),
  );
}

function confirmCancel(day, slot) {
  const confirm = action('Ja, slet bookingen', 'danger', () => cancelBooking(day.date, slot.index, confirm));
  sheet(
    el('h2', '', `Slet ${describe(day, slot)}?`), el('p', '', view.place),
    el('p', 'muted', 'Tiden bliver ledig for alle andre med det samme.'),
    closeButton('Behold bookingen'), confirm,
  );
}

// Svaret på selve kaldet viser ikke ændringen, så vi læser kalenderen bagefter.
async function slotBecomes(date, index, isDone) {
  for (const delay of [0, 1500]) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    await fetchCalendar();
    if (isDone(view.days.find((d) => d.date === date)?.slots[index]?.kind)) return true;
  }
  return false;
}

async function cancelBooking(date, index, button) {
  button.disabled = true;
  button.textContent = 'Sletter...';
  try {
    await fetchCalendar();
    const slot = view.days.find((d) => d.date === date)?.slots[index];
    // Samme token booker en ledig tid, så det må kun sendes for en tid der stadig er din.
    if (slot?.kind !== 'mine' || typeof slot.token !== 'string') {
      $('sheet').close();
      toast(slot?.kind === 'mine' ? 'Tiden kan ikke slettes her' : 'Bookingen findes ikke længere');
      return refresh();
    }
    await api('Location/Calendar5', {
      session: slot.token, date: `#${date}`, days: 8, calendarid: calendarId,
    });
    const cancelled = await slotBecomes(date, index, (kind) => kind !== 'mine');
    $('sheet').close();
    toast(cancelled ? 'Booking slettet' : 'Kunne ikke slette. Tjek kalenderen.');
  } catch (error) {
    $('sheet').close();
    toast(`${error.message}. Tjek kalenderen.`);
  }
  await refresh();
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
    await api('Location/Calendar5', {
      session: slot.token, date: `#${date}`, days: 8, calendarid: calendarId,
    });
    const confirmed = await slotBecomes(date, index, (kind) => kind === 'mine');
    $('sheet').close();
    toast(confirmed ? 'Booket!' : 'Kunne ikke bekræfte. Tjek kalenderen.');
  } catch (error) {
    $('sheet').close();
    toast(`${error.message}. Tjek kalenderen.`);
  }
  await refresh();
}

// Forhåndsbookinger holdes af tjekket, som kun ser hjemmevaskeriet. Appen kender dem fra
// sine egne beskeder og fra tjekkets status.
const slotKey = (day, slot) => `${day.date} ${slot.start}`;
const nowKey = () => { const d = new Date(); return `${isoDate(d)} ${clock(d.getHours() * 60 + d.getMinutes())}`; };
// En tid du har booket selv, venter ikke længere, også før tjekket har nået at melde det.
const bookedHere = (key) => calendarId === HOME_CALENDAR_ID && view.days
  .find((d) => d.date === key.slice(0, 10))?.slots.find((s) => s.start === key.slice(11))?.kind === 'mine';
const prebooks = () => (saved.prebooks || []).filter((key) => key > nowKey() && !bookedHere(key)).sort();
const isPrebooked = (day, slot) => calendarId === HOME_CALENDAR_ID && prebooks().includes(slotKey(day, slot));
// Tjekket booker kun i hjemmevaskeriet.
const homePlace = () => saved.laundries?.find((l) => l.id === HOME_CALENDAR_ID)?.title
  || (calendarId === HOME_CALENDAR_ID ? view.place : null);
const isAutobooked = (place, date, start) => Boolean(place) && place === homePlace()
  && (saved.autobooked || []).includes(`${date} ${start}`);
const keyLabel = (key) => `${WEEKDAYS[localDate(key.slice(0, 10)).getDay()]} ${shortDate(key.slice(0, 10))} ${key.slice(11)}`;

async function setPrebook(key, add) {
  if (!saved.topic) {
    return sheet(el('h2', '', 'Forhåndsbooking'), el('p', 'muted', 'Indtast dit ntfy-emne under ☰ → App først.'), closeButton());
  }
  $('sheet').close();
  if (!await postCommand(`${add ? 'prebook' : 'unprebook'} ${key}`)) return toast('Kunne ikke sende til ntfy');
  const others = (saved.prebooks || []).filter((k) => k !== key);
  saved.prebooks = add ? [...others, key].sort() : others;
  saved.prebookSentAt = Date.now();
  save();
  render();
  toast(add ? `Forhåndsbooket ${keyLabel(key)}` : 'Forhåndsbooking fjernet');
}

function openPrebook(key) {
  const day = calendarId === HOME_CALENDAR_ID ? view.days.find((d) => d.date === key.slice(0, 10)) : null;
  const slot = day?.slots.find((s) => s.start === key.slice(11));
  const nodes = [
    el('h2', '', slot ? describe(day, slot) : keyLabel(key)),
    el('p', 'muted', 'Forhåndsbooket. Tjekket booker tiden, så snart du har en booking ledig, eller sletter din senest autobookede tid for at give plads. Er tiden optaget, bookes den, hvis den bliver ledig igen.'),
  ];
  if (slot?.kind === 'free') {
    const bookNow = action('Book nu', 'primary', () => book(day.date, slot.index, bookNow));
    nodes.push(bookNow);
  }
  nodes.push(action('Fjern forhåndsbooking', 'danger', () => setPrebook(key, false)), closeButton());
  sheet(...nodes);
}

// undefined: ikke hentet endnu. null: tjekket har ikke meldt sig.
let lastStatus;

function statusHealth(status, now = Date.now()) {
  if (!status) return { ok: false, text: 'Intet hørt fra tjekket de sidste 12 timer' };
  const age = now - status.sent;
  if (age > STATUS_STALE_MS) return { ok: false, text: `Tjekket meldte sig sidst ${timeAgo(age)}` };
  if (status.failing) return { ok: false, text: 'Tjekket kan ikke læse kalenderen lige nu' };
  return { ok: true, text: `Tjekket kører · meldte sig ${timeAgo(age)}` };
}

function renderHealth() {
  const dot = $('health');
  if (!dot) return;
  dot.hidden = !saved.topic || lastStatus === undefined;
  if (dot.hidden) return;
  const health = statusHealth(lastStatus);
  dot.classList.toggle('bad', !health.ok);
  dot.setAttribute('aria-label', health.text);
  dot.title = health.text;
}

// Tjekket fjerner en forhåndsbooking, når den er booket eller tiden er gået. Kun en status
// sendt efter appens egen seneste besked må overskrive listen. Autobookingerne kendes kun herfra.
async function syncPrebooks() {
  if (!saved.topic) return;
  try {
    const status = await fetchStatus();
    lastStatus = status;
    renderHealth();
    if (!status) return;
    const before = JSON.stringify([saved.prebooks, saved.autobooked]);
    if (Array.isArray(status.autobooked)) saved.autobooked = status.autobooked;
    if (Array.isArray(status.prebook) && status.sent > (saved.prebookSentAt || 0)) saved.prebooks = status.prebook;
    if (JSON.stringify([saved.prebooks, saved.autobooked]) === before) return;
    save();
    render();
  } catch {
    // Listen er ikke vigtig nok til at forstyrre.
  }
}

// Pause styres via det samme ntfy-emne som knappen i notifikationerne.
function activePause() {
  return saved.pauseUntil && saved.pauseUntil > isoDate(new Date()) ? saved.pauseUntil : null;
}

// Pausen sættes fra menuen eller notifikationen. Her ses den kun, mens den er slået til.
function renderPause() {
  const until = activePause();
  const chip = $('pauseChip');
  chip.hidden = !until;
  chip.classList.add('on');
  if (until) chip.textContent = `Pause · ingen besked om afbud før ${shortDate(until)}`;
}

const controlUrl = () => `${NTFY}/${encodeURIComponent(saved.topic)}-styring`;
const settings = () => ({ ...DEFAULT_SETTINGS, ...saved.settings });
const washPauseDays = () => Number(settings().WASH_PAUSE_DAYS);

async function postCommand(command) {
  try {
    const response = await fetch(controlUrl(), { method: 'POST', body: command });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendCommand(command, until) {
  $('sheet').close();
  if (!await postCommand(command)) return toast('Kunne ikke sende til ntfy');
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
    action(`Har vasket (${washPauseDays()} dage)`, 'primary', () => pauseDays(washPauseDays())),
    action('3 dage', 'secondary', () => pauseDays(3)),
    action('7 dage', 'secondary', () => pauseDays(7)),
    action('14 dage', 'secondary', () => pauseDays(14)),
  ];
  if (activePause()) nodes.push(action('Slå pause fra', 'secondary', () => sendCommand('resume', null)));
  nodes.push(action('Tilbage', 'secondary', openMenu));
  sheet(...nodes);
}

// En pause sat fra notifikationen kendes kun af ntfy, så den hentes herfra.
async function syncPause() {
  if (!saved.topic) return;
  try {
    const response = await fetch(`${controlUrl()}/json?poll=1&since=12h`);
    const messages = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const before = saved.pauseUntil;
    for (const message of messages) {
      if (message.event !== 'message') continue;
      const sent = new Date(message.time * 1000);
      const [word, days] = (message.message || '').trim().toLowerCase().split(/\s+/);
      if (word === 'washed') saved.pauseUntil = isoDate(addDays(sent, washPauseDays()));
      else if (word === 'pause' && /^\d+$/.test(days || '')) saved.pauseUntil = isoDate(addDays(sent, Number(days)));
      else if (word === 'resume') saved.pauseUntil = null;
    }
    if (saved.pauseUntil === before) return;
    save();
    render();
  } catch {
    // Pausevisningen er ikke vigtig nok til at forstyrre.
  }
}

function field(text, input) {
  const label = el('label', '', text);
  label.append(input);
  return label;
}

function numberField(draft, key, text, min, max) {
  const input = el('input');
  Object.assign(input, { type: 'number', inputMode: 'numeric', required: true, min, max, value: draft[key] });
  input.addEventListener('input', () => { draft[key] = input.value; });
  return field(text, input);
}

function timeField(draft, key, text) {
  const input = el('input');
  Object.assign(input, { type: 'time', required: true, value: draft[key] });
  input.addEventListener('input', () => { draft[key] = input.value; });
  return field(text, input);
}

function selectField(draft, key, text, options) {
  const select = el('select');
  select.append(...options.map(([value, name]) => {
    const option = el('option', '', name);
    option.value = value;
    option.selected = value === draft[key];
    return option;
  }));
  select.addEventListener('change', () => { draft[key] = select.value; });
  return field(text, select);
}

function toggleField(draft, key, text) {
  const input = el('input');
  Object.assign(input, { type: 'checkbox', checked: draft[key] === 'true' });
  input.addEventListener('change', () => { draft[key] = String(input.checked); });
  const label = el('label', 'toggle', text);
  label.append(input);
  return label;
}

function weekdayField(draft, key, text) {
  const chosen = new Set(draft[key].split(',').filter(Boolean));
  const days = el('div', 'weekdays');
  days.append(...SETTING_WEEKDAYS.map((name) => {
    const button = el('button', 'weekday', name);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(chosen.has(name)));
    button.addEventListener('click', () => {
      if (chosen.has(name)) chosen.delete(name);
      else chosen.add(name);
      button.setAttribute('aria-pressed', String(chosen.has(name)));
      draft[key] = SETTING_WEEKDAYS.filter((day) => chosen.has(day)).join(',');
    });
    return button;
  }));
  const group = el('div', 'group');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', text);
  group.append(el('span', 'muted', text), days);
  return group;
}

// En sektion der viser sine værdier på én linje og foldes ud ved tryk.
function section(title, summarize, fields, open = false) {
  const details = el('details', 'section');
  details.open = open;
  const head = el('summary');
  const value = el('span', 'value', summarize());
  head.append(el('span', 'title', title), value);
  details.append(head, el('div', 'fields'));
  details.lastChild.append(...fields);
  const update = () => { value.textContent = summarize(); };
  for (const type of ['input', 'change', 'click']) details.addEventListener(type, update);
  return details;
}

const onOff = (value) => (value === 'true' ? 'Til' : 'Fra');
const minutesText = (value, never = 'aldrig') => {
  const minutes = Number(value);
  if (!minutes) return never;
  if (minutes % 1440 === 0) return `${minutes / 1440} dag før`;
  if (minutes % 60 === 0) return `${minutes / 60} t før`;
  return `${minutes} min før`;
};

function startOptions(anyText) {
  const starts = view.days[0]?.slots.map((slot) => slot.start) || SLOT_STARTS;
  return [['', anyText], ...starts.map((start) => [start, start])];
}

function settingsProblem(draft) {
  if (!saved.topic) return 'Indtast dit ntfy-emne under App først.';
  if (!draft.NOTIFY_WEEKDAYS || !draft.AUTOBOOK_WEEKDAYS || !draft.PREBOOK_RULE_WEEKDAYS) return 'Vælg mindst én ugedag.';
  for (const prefix of ['NOTIFY', 'AUTOBOOK', 'PREBOOK_RULE']) {
    const earliest = draft[`${prefix}_EARLIEST_START`];
    const latest = draft[`${prefix}_LATEST_START`];
    if (earliest && latest && earliest > latest) return 'Tidligste start ligger efter seneste start.';
  }
  return null;
}

async function saveSettings(draft, button, message) {
  const inputs = [...$('sheetBody').querySelectorAll('input')];
  if (!inputs.every((input) => input.reportValidity())) return;
  message.textContent = settingsProblem(draft) || '';
  if (message.textContent) return;
  button.disabled = true;
  const sent = await postCommand(`settings ${JSON.stringify(draft)}`);
  button.disabled = false;
  if (!sent) {
    message.textContent = 'Kunne ikke sende til ntfy.';
    return;
  }
  saved.settings = draft;
  save();
  $('sheet').close();
}

function settingsSheet(title, intro, draft, fields, extra = []) {
  const message = el('p', 'error');
  message.setAttribute('role', 'alert');
  const saveButton = action('Gem', 'primary', () => saveSettings(draft, saveButton, message));
  sheet(
    el('h2', '', title), ...(intro ? [el('p', 'muted', intro)] : []), ...fields, message,
    saveButton, ...extra, action('Tilbage', 'secondary', openMenu),
  );
}

function sendTest(button) {
  button.disabled = true;
  postCommand('test').then((sent) => {
    button.textContent = sent ? 'Sendt' : 'Kunne ikke sende til ntfy';
  });
}

function openNotifications() {
  const draft = settings();
  const test = action('Send testbesked gennem tjekket', 'secondary', () => sendTest(test));
  test.disabled = !saved.topic;
  settingsSheet('Notifikationer', '', draft, [
    toggleField(draft, 'NOTIFY_ENABLED', 'Besked om afbud'),
    section('Hvilke afbud', () => windowSummary(draft, 'NOTIFY'), [
      numberField(draft, 'NOTIFY_MAX_DAYS_AHEAD', 'Op til så mange dage frem', 1, 30),
      weekdayField(draft, 'NOTIFY_WEEKDAYS', 'Ugedage'),
      selectField(draft, 'NOTIFY_EARLIEST_START', 'Tidligste start', startOptions('Alle tider')),
      selectField(draft, 'NOTIFY_LATEST_START', 'Seneste start', startOptions('Alle tider')),
      numberField(draft, 'NOTIFY_MIN_LEAD_MINUTES', 'Ignorér tider der starter om under (minutter)', 0, 720),
      numberField(draft, 'NOTIFY_URGENT_DAYS', 'Høj prioritet inden for (dage)', 0, 30),
      numberField(draft, 'WASH_PAUSE_DAYS', 'Dage på pause efter "Har vasket"', 1, 30),
    ]),
    section('Stille tid', () => `${draft.QUIET_START}–${draft.QUIET_END} · væk kun for ${draft.NOTIFY_NIGHT_DAYS} dage frem`, [
      timeField(draft, 'QUIET_START', 'Fra'),
      timeField(draft, 'QUIET_END', 'Til'),
      numberField(draft, 'NOTIFY_NIGHT_DAYS', 'Væk mig kun for tider inden for (dage)', 0, 30),
    ]),
    section('Min vask', () => [
      draft.NOTIFY_MACHINE_DONE === 'true' ? 'færdig' : '',
      draft.NOTIFY_MACHINE_ALMOST_DONE_MINUTES !== '0' ? `næsten færdig (${draft.NOTIFY_MACHINE_ALMOST_DONE_MINUTES} min)` : '',
      draft.NOTIFY_BOOKING_REMINDER_MINUTES !== '0' ? `påmindelse ${minutesText(draft.NOTIFY_BOOKING_REMINDER_MINUTES)}` : '',
    ].filter(Boolean).join(' · ') || 'Ingen beskeder', [
    toggleField(draft, 'NOTIFY_MACHINE_DONE', 'Besked når min maskine er færdig'),
    selectField(draft, 'NOTIFY_MACHINE_ALMOST_DONE_MINUTES', 'Besked med vibration før min maskine er færdig', [
      ['0', 'Aldrig'], ['1', '1 minut før'], ['2', '2 minutter før'], ['3', '3 minutter før'],
      ['5', '5 minutter før'], ['10', '10 minutter før'],
    ]),
    selectField(draft, 'NOTIFY_BOOKING_REMINDER_MINUTES', 'Påmind mig før min tid', [
      ['0', 'Aldrig'], ['15', '15 minutter før'], ['30', '30 minutter før'],
      ['60', '1 time før'], ['120', '2 timer før'], ['1440', '1 dag før'],
    ]),
    ]),
  ], [test]);
}

function openAutobook() {
  const draft = settings();
  settingsSheet('Autobooking', 'Booker selv ledige tider, der passer, og giver besked bagefter. Højst én tid pr. tjek. Tider du selv sletter, bookes ikke igen.', draft, [
    toggleField(draft, 'AUTOBOOK_ENABLED', 'Book afbud automatisk'),
    section('Hvilke tider', () => windowSummary(draft, 'AUTOBOOK'), [
      numberField(draft, 'AUTOBOOK_MAX_DAYS_AHEAD', 'Op til så mange dage frem', 1, 30),
      weekdayField(draft, 'AUTOBOOK_WEEKDAYS', 'Ugedage'),
      selectField(draft, 'AUTOBOOK_EARLIEST_START', 'Tidligste start', startOptions('Alle tider')),
      selectField(draft, 'AUTOBOOK_LATEST_START', 'Seneste start', startOptions('Alle tider')),
    ]),
    section('Til dig selv', () => `beholder ${draft.AUTOBOOK_KEEP_FREE} booking(er)`, [
      numberField(draft, 'AUTOBOOK_KEEP_FREE', 'Lad så mange bookinger stå til mig selv', 0, 10),
    ]),
  ], [action('Nulstil autobooking', 'secondary', confirmAutobookReset)]);
}

function openPrebookMenu() {
  const draft = settings();
  const waiting = prebooks();
  const list = waiting.length
    ? waiting.map((key) => menuRow(keyLabel(key), 'Fjern', () => setPrebook(key, false), 'remove-row'))
    : [el('p', 'muted', 'Ingen. Tryk på en optaget eller fuld tid i kalenderen for at forhåndsbooke den.')];
  settingsSheet('Forhåndsbooking', 'Går forud for autobooking. Har du ingen booking ledig, slettes din senest autobookede tid for at give plads. Dine egne bookinger røres aldrig.', draft, [
    el('h3', '', 'Venter'),
    el('div', 'menu-group'),
    toggleField(draft, 'PREBOOK_RULE_ENABLED', 'Fast ønske: sørg for, at jeg har en tid, der passer'),
    section('Hvilke tider', () => windowSummary(draft, 'PREBOOK_RULE'), [
      numberField(draft, 'PREBOOK_RULE_MAX_DAYS_AHEAD', 'Op til så mange dage frem', 1, 30),
      weekdayField(draft, 'PREBOOK_RULE_WEEKDAYS', 'Ugedage'),
      selectField(draft, 'PREBOOK_RULE_EARLIEST_START', 'Tidligste start', startOptions('Alle tider')),
      selectField(draft, 'PREBOOK_RULE_LATEST_START', 'Seneste start', startOptions('Alle tider')),
    ]),
  ]);
  $('sheetBody').querySelector('.menu-group').append(...list);
}

function confirmAutobookReset() {
  sheet(
    el('h2', '', 'Nulstil autobooking?'),
    el('p', '', 'Tider du selv har slettet, kan bookes automatisk igen, og loggen under Status ryddes.'),
    el('p', 'muted', 'Dine indstillinger og bookinger ændres ikke. Passer en ledig tid, kan den blive booket med det samme.'),
    action('Ja, nulstil', 'danger', async () => {
      if (!await postCommand('reset-autobook')) toast('Kunne ikke sende til ntfy');
      openAutobook();
    }),
    action('Tilbage', 'secondary', openAutobook),
  );
}

function openAppSettings() {
  const topic = el('input');
  topic.value = saved.topic || '';
  topic.autocapitalize = 'off';
  topic.spellcheck = false;
  const draft = { start: String(saved.startLaundry || HOME_CALENDAR_ID) };
  const laundries = saved.laundries?.length ? saved.laundries : [{ id: calendarId, title: view.place }];
  sheet(
    el('h2', '', 'App'),
    field('ntfy-emne', topic),
    selectField(draft, 'start', 'Åbn på vaskeri', laundries.map(({ id, title }) => [String(id), title])),
    action('Gem', 'primary', () => {
      saved.topic = topic.value.trim();
      saved.startLaundry = Number(draft.start);
      save();
      $('sheet').close();
      syncPause();
    }),
    action('Tilbage', 'secondary', openMenu),
  );
}

// Tjekket melder sig hver time og ved ændringer, på et emne telefonen ikke abonnerer på.
const STATUS_STALE_MS = 2 * 60 * 60 * 1000;
const statusUrl = () => `${NTFY}/${encodeURIComponent(saved.topic)}-status`;

async function fetchStatus() {
  const response = await fetch(`${statusUrl()}/json?poll=1&since=12h`);
  if (!response.ok) throw new Error('Status kunne ikke hentes');
  const messages = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const latest = messages.filter((message) => message.event === 'message').pop();
  return latest ? { ...JSON.parse(latest.message), sent: latest.time * 1000 } : null;
}

function timeAgo(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'lige nu';
  if (minutes < 60) return `for ${minutes} min siden`;
  return `for ${Math.floor(minutes / 60)} t ${minutes % 60} min siden`;
}

function windowSummary(server, prefix) {
  const weekdays = server[`${prefix}_WEEKDAYS`];
  const days = !weekdays || weekdays === ALL_WEEKDAYS ? 'alle dage' : weekdays.replaceAll(',', ', ');
  const earliest = server[`${prefix}_EARLIEST_START`];
  const latest = server[`${prefix}_LATEST_START`];
  const times = earliest || latest ? `${earliest || 'start'}–${latest || 'slut'}` : 'alle tider';
  return `${days} · ${times} · op til ${server[`${prefix}_MAX_DAYS_AHEAD`]} dage frem`;
}

function autobookSummary(server) {
  if (server.AUTOBOOK_ENABLED !== 'true') return 'Fra';
  return `${windowSummary(server, 'AUTOBOOK')} · beholder ${server.AUTOBOOK_KEEP_FREE || 1}`;
}

function prebookMenuText(current) {
  const count = prebooks().length;
  const parts = [count ? `${count} venter` : '', current.PREBOOK_RULE_ENABLED === 'true' ? 'fast ønske' : ''];
  return parts.filter(Boolean).join(' · ') || 'Ingen';
}

function card(title, rows) {
  const box = el('section', 'card');
  box.append(el('h3', '', title));
  for (const [label, value] of rows.filter(Boolean)) {
    const row = el('div', 'card-row');
    row.append(el('span', 'muted', label), el('span', '', value));
    box.append(row);
  }
  return box;
}

const keyList = (keys) => keys.map(keyLabel).join(', ');

function statusNodes(status, now = Date.now()) {
  const server = status.settings || {};
  const health = statusHealth(status, now);
  const banner = el('p', `health-line${health.ok ? '' : ' bad'}`, health.text);
  const pause = status.pause_until && status.pause_until.slice(0, 10) > isoDate(new Date(now))
    ? shortDate(status.pause_until.slice(0, 10)) : null;
  const nodes = [
    banner,
    card('Bookinger', [
      ['Tilbage', String(status.remaining ?? '?')],
      ['Besked om afbud', server.NOTIFY_ENABLED === 'true' ? 'Til' : 'Fra'],
      pause && ['Pause til', pause],
      status.cancelled?.length && ['Slettet af dig, bookes ikke igen', keyList(status.cancelled)],
    ]),
    card('Autobooking', [
      ['Indstilling', autobookSummary(server)],
      status.autobooked?.length && ['Autobookede tider', keyList(status.autobooked)],
      status.bump_next && ['Slettes først ved forhåndsbooking', keyLabel(status.bump_next)],
    ]),
    card('Forhåndsbooking', [
      ['Venter', status.prebook?.length ? keyList(status.prebook) : 'Ingen'],
      ['Fast ønske', server.PREBOOK_RULE_ENABLED === 'true' ? windowSummary(server, 'PREBOOK_RULE') : 'Fra'],
      status.prebook_failed?.length && ['Fejlede, prøves igen om lidt', keyList(status.prebook_failed)],
    ]),
  ];
  if (status.log?.length) nodes.push(card('Seneste hændelser', status.log.map((note) => [note.slot, note.text])));
  return nodes;
}

async function openStatus() {
  const title = el('h2', '', 'Status på tjekket');
  const back = action('Tilbage', 'secondary', openMenu);
  if (!saved.topic) return sheet(title, el('p', 'muted', 'Indtast dit ntfy-emne under App først.'), back);
  const loading = el('p', 'muted', 'Henter...');
  sheet(title, loading, back);
  let nodes;
  try {
    const status = await fetchStatus();
    lastStatus = status;
    renderHealth();
    nodes = status ? statusNodes(status) : [el('p', 'health-line bad', 'Intet hørt fra tjekket de sidste 12 timer. Serveren kan være nede.')];
  } catch {
    nodes = [el('p', '', 'Kunne ikke hente status fra ntfy.')];
  }
  // Arket kan være lukket eller skiftet, mens der blev hentet.
  if (loading.isConnected) sheet(title, ...nodes, back);
}

function menuRow(label, value, onClick, className = '') {
  const row = el('button', `menu-row ${className}`.trim());
  row.append(el('span', 'title', label), el('span', 'value', value || ''), el('span', 'chevron', '›'));
  row.addEventListener('click', onClick);
  return row;
}

function menuGroup(title, ...rows) {
  const group = el('div', 'menu-group');
  group.append(...rows);
  return [el('h3', '', title), group];
}

function logOut() {
  // Tjekket kører videre med indstillingerne, så appen skal stadig kende dem.
  localStorage.setItem('vaskeri', JSON.stringify({ settings: saved.settings }));
  location.reload();
}

function openMenu() {
  const current = settings();
  const until = activePause();
  const health = saved.topic && lastStatus !== undefined ? statusHealth(lastStatus) : null;
  const eVaskeri = menuRow('e-vaskeri-appen', 'Åbn', () => { location.href = E_VASKERI_APP; });
  sheet(
    el('h2', '', 'Indstillinger'),
    ...menuGroup(
      'Booking',
      menuRow('Autobooking', current.AUTOBOOK_ENABLED === 'true' ? windowSummary(current, 'AUTOBOOK') : 'Fra', openAutobook),
      menuRow('Forhåndsbooking', prebookMenuText(current), openPrebookMenu),
    ),
    ...menuGroup(
      'Beskeder',
      menuRow('Notifikationer', onOff(current.NOTIFY_ENABLED), openNotifications),
      menuRow('Pause', until ? `Til ${shortDate(until)}` : 'Fra', openPause),
    ),
    ...menuGroup(
      'Tjekket',
      menuRow('Status', health ? (health.ok ? 'Kører' : 'Problem') : '', openStatus, health && !health.ok ? 'warn' : ''),
    ),
    ...menuGroup(
      'Konto',
      menuRow('App', saved.topic ? 'ntfy-emne sat' : 'Mangler ntfy-emne', openAppSettings),
      eVaskeri,
      menuRow('Log ud', '', logOut, 'danger-row'),
    ),
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
$('health')?.addEventListener('click', openStatus);
$('laundry').addEventListener('change', (event) => switchLaundry(Number(event.target.value)));
$('more').addEventListener('click', () => { daysShown += 30; refresh(); });
$('sheet').addEventListener('click', (event) => { if (event.target === $('sheet')) $('sheet').close(); });
window.addEventListener('hashchange', flashHash);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('app').hidden) refresh();
});

// Træk ned øverst på siden for at opdatere.
const PULL_DISTANCE = 70;
let pullStart = null;
document.addEventListener('touchstart', (event) => {
  pullStart = window.scrollY === 0 && !$('sheet').open && !$('app').hidden ? event.touches[0].clientY : null;
}, { passive: true });
document.addEventListener('touchmove', (event) => {
  if (pullStart === null) return;
  const distance = Math.max(0, Math.min(event.touches[0].clientY - pullStart, PULL_DISTANCE * 1.5));
  $('app').style.transform = distance ? `translateY(${distance / 3}px)` : '';
  $('refresh').classList.toggle('armed', distance >= PULL_DISTANCE);
}, { passive: true });
document.addEventListener('touchend', () => {
  if (pullStart === null) return;
  const armed = $('refresh').classList.contains('armed');
  pullStart = null;
  $('app').style.transform = '';
  $('refresh').classList.remove('armed');
  if (armed) refresh();
});

setInterval(tickLive, LIVE_TICK_MS);
setInterval(() => { if (!document.hidden && !$('app').hidden) renderNext(); }, 30 * 1000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
if (saved.user && saved.password) showApp();
else showLogin();
