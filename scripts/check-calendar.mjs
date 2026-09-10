import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './lib/google-auth.mjs';
import { listCalendars, fetchDayAgenda, syncCalendar } from './lib/calendar.mjs';

const STATE_PATH = fileURLToPath(new URL('../calendar-state.json', import.meta.url));
const runType = process.env.RUN_TYPE || 'manual';
const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const AGENDA_HOUR = Number(process.env.AGENDA_HOUR || 7);

// Runner bezi v UTC, uzivatel zije v Europe/Prague - vsetky "dnes"/"kolko je hodin"
// rozhodnutia musia ist cez tuto zonu, inak sa v lete posunu o hodinu.
export function pragueParts(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// "+02:00" / "+01:00" podla toho, ci prave plati letny cas.
export function pragueOffset(d = new Date()) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Prague',
    timeZoneName: 'longOffset',
  })
    .formatToParts(d)
    .find((x) => x.type === 'timeZoneName').value;
  return name.replace('GMT', '') || '+00:00';
}

// Agenda sa posiela raz za den, pri prvom behu od AGENDA_HOUR miestneho casu.
// Nie je naviazana na konkretny cron vyraz zamerne: GitHub Actions cron sa
// bezne oneskoruje o desiatky minut a pri fixnom mapovani by sprava vypadla.
export function shouldSendAgenda(state, now) {
  if (runType === 'manual') return true;
  const { date, hour } = pragueParts(now);
  return hour >= AGENDA_HOUR && state.lastAgendaDate !== date;
}

async function loadState() {
  try {
    const text = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed.calendars) parsed.calendars = {};
    return parsed;
  } catch {
    return { calendars: {} };
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram send failed: HTTP ${res.status} - ${raw.slice(0, 300)}`);
  }
  if (!data.ok) throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
}

function fmtTime(start) {
  if (!start || start.date) return 'celý deň';
  return new Date(start.dateTime).toLocaleTimeString('sk-SK', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Prague',
  });
}

function startKey(ev) {
  return ev.start?.dateTime || ev.start?.date || '';
}

async function runMorningAgenda(accessToken, calendars, now = new Date()) {
  // Hranice dna sa pocitaju v Prahe, nie v UTC casu runnera - inak by agenda
  // zacinala o 02:00 a pretiekla do nasledujuceho dna.
  const { date } = pragueParts(now);
  const offset = pragueOffset(now);
  const startOfDay = `${date}T00:00:00${offset}`;
  const endOfDay = `${date}T23:59:59${offset}`;

  const agendaLines = [];
  for (const cal of calendars) {
    const events = await fetchDayAgenda(accessToken, cal.id, startOfDay, endOfDay);
    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      agendaLines.push({
        time: fmtTime(ev.start),
        summary: ev.summary || '(bez názvu)',
        calendar: cal.summary,
      });
    }
  }
  agendaLines.sort((a, b) => a.time.localeCompare(b.time));

  const dateLabel = now.toLocaleDateString('sk-SK', { timeZone: 'Europe/Prague' });
  const lines = [`📅 Melichar — dnešná agenda (${dateLabel})`];
  if (agendaLines.length === 0) {
    lines.push('', 'Dnes žiadne naplánované udalosti.');
  } else {
    lines.push('');
    for (const a of agendaLines) lines.push(`${a.time} — ${a.summary} (${a.calendar})`);
  }
  await sendTelegramMessage(lines.join('\n'));
}

async function runChangeDetection(accessToken, calendars, state) {
  const changeLines = [];
  const nowMs = Date.now();

  for (const cal of calendars) {
    const key = cal.id;
    const prev = state.calendars[key] || {};
    let isBaseline = !prev.syncToken;
    const cache = prev.eventCache || {};

    let { items, nextSyncToken, expired } = await syncCalendar(accessToken, cal.id, {
      syncToken: prev.syncToken,
      timeMinForBaseline: new Date().toISOString(),
    });

    if (expired) {
      isBaseline = true;
      const fresh = await syncCalendar(accessToken, cal.id, {
        syncToken: null,
        timeMinForBaseline: new Date().toISOString(),
      });
      items = fresh.items;
      nextSyncToken = fresh.nextSyncToken;
    }

    const newCache = isBaseline ? {} : { ...cache };

    for (const ev of items) {
      if (ev.status === 'cancelled') {
        const cached = cache[ev.id];
        if (!isBaseline && cached) {
          changeLines.push(`✗ Zrušená: "${cached.summary}" (${cached.calendar})`);
        }
        delete newCache[ev.id];
        continue;
      }

      const summary = ev.summary || '(bez názvu)';
      const start = startKey(ev);
      const cached = cache[ev.id];

      if (!isBaseline) {
        if (!cached) {
          changeLines.push(`+ Nová: "${summary}" ${fmtTime(ev.start)} (${cal.summary})`);
        } else if (cached.start !== start) {
          changeLines.push(`~ Presunutá: "${summary}" na ${fmtTime(ev.start)} (${cal.summary})`);
        } else if (cached.summary !== summary) {
          changeLines.push(`~ Premenovaná: "${cached.summary}" → "${summary}" (${cal.summary})`);
        }
      }

      newCache[ev.id] = { summary, start, calendar: cal.summary };
    }

    for (const [id, e] of Object.entries(newCache)) {
      const t = Date.parse(e.start);
      if (!Number.isNaN(t) && t < nowMs - CACHE_MAX_AGE_MS) delete newCache[id];
    }

    state.calendars[key] = {
      syncToken: nextSyncToken || prev.syncToken,
      eventCache: newCache,
    };
  }

  return changeLines;
}

async function main() {
  const accessToken = await getAccessToken(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  );

  const calendars = await listCalendars(accessToken);
  const state = await loadState();

  const now = new Date();
  const sendAgenda = shouldSendAgenda(state, now);
  if (sendAgenda) {
    await runMorningAgenda(accessToken, calendars, now);
    // Zapise sa hned po odoslani, nie az na konci behu: keby detekcia zmien
    // spadla, nasledujuci beh by agendu poslal druhy raz.
    if (runType !== 'manual') {
      state.lastAgendaDate = pragueParts(now).date;
      await saveState(state);
    }
  }

  const changeLines = await runChangeDetection(accessToken, calendars, state);
  await saveState(state);

  if (changeLines.length) {
    await sendTelegramMessage(['📅 Melichar — zmeny v kalendári', '', ...changeLines].join('\n'));
  }

  console.log(`Calendar check done. Morning agenda sent: ${sendAgenda}. Changes: ${changeLines.length}.`);
}

// Pri importe (napr. z overovacieho skriptu) sa main nespusti - iba pri
// priamom spusteni cez `node scripts/check-calendar.mjs`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
