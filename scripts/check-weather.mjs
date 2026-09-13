import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// --- Prahy (vsetky prepisatelne cez env) -----------------------------------
// Avokado je subtropicka rastlina. Pod 10 C len zastavi rast (neskodi mu to),
// pasmo 4-10 C je uz chilling injury pri dlhsej expozicii, pod 0 C prichadza
// realne poskodenie mladych neotuzenych rastlin v kvetinaci.
const BRING_IN_C = Number(process.env.BRING_IN_C || 5); // jesenne "prines dnu"
const URGENT_C = Number(process.env.URGENT_C || 2); // "ak je este vonku, hori"
const FREEZE_C = Number(process.env.FREEZE_C ?? 0); // mraz
const PUT_OUT_C = Number(process.env.PUT_OUT_C || 8); // jarne "mozes dat von"
const SPRING_RUN_NIGHTS = Number(process.env.SPRING_RUN_NIGHTS || 7);

// Milniky sa hlasia raz za sezonu, zoradene od najteplejsieho.
const MILESTONES = [BRING_IN_C, URGENT_C, FREEZE_C];

// Radiacny mraz: za jasnej bezvetrej noci vyzaruje list teplo do oblohy a je
// chladnejsi nez teplota vzduchu v 2 m, ktoru hlasi predpoved. Kvetinac navyse
// nema tepelnu zotrvacnost zahonu.
const CLEAR_CLOUD_PCT = Number(process.env.CLEAR_CLOUD_PCT || 30);
const CALM_WIND_KMH = Number(process.env.CALM_WIND_KMH || 10);
const RADIATIVE_PENALTY_C = Number(process.env.RADIATIVE_PENALTY_C || 3);

const STATE_PATH = fileURLToPath(new URL('../state.json', import.meta.url));
const lat = process.env.LATITUDE;
const lon = process.env.LONGITUDE;
const runType = process.env.RUN_TYPE || 'manual';
const isManualRun = runType === 'manual';

function fmtTemp(t) {
  return `${Math.round(t * 10) / 10}°C`;
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Datum v Prahe, nie v UTC casu runnera.
export function pragueToday(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// --- Noc ako skutocne okno, nie ako kalendarny den -------------------------
// Denne minimum z API je minimum kalendarneho dna a nastava nadranom, takze
// patri k noci, ktora uz prebehla. Nas zaujima okno 18:00 -> 09:00 rana.
// Noc sa oznacuje datumom RANA, ktorym konci.
export function buildNights(hourly) {
  const nights = new Map();

  hourly.time.forEach((stamp, i) => {
    const [date, clock] = stamp.split('T');
    const hour = Number(clock.slice(0, 2));
    let morning;
    if (hour >= 18) morning = addDays(date, 1);
    else if (hour <= 9) morning = date;
    else return;

    if (!nights.has(morning)) {
      nights.set(morning, { date: morning, temps: [], clouds: [], winds: [] });
    }
    const n = nights.get(morning);
    n.temps.push(hourly.temperature_2m[i]);
    n.clouds.push(hourly.cloud_cover[i]);
    n.winds.push(hourly.wind_speed_10m[i]);
  });

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return [...nights.values()]
    // Orezane okrajove noci na hranici predpovede (plna noc ma 16 hodin).
    .filter((n) => n.temps.length >= 12)
    .map((n) => {
      const airMin = Math.min(...n.temps);
      const cloud = mean(n.clouds);
      const wind = mean(n.winds);
      const clearCalm = cloud < CLEAR_CLOUD_PCT && wind < CALM_WIND_KMH;
      return {
        date: n.date,
        airMin,
        cloud,
        wind,
        clearCalm,
        leafMin: clearCalm ? airMin - RADIATIVE_PENALTY_C : airMin,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function nightLabel(night, today) {
  const prefix = night.date === addDays(today, 1) ? 'Dnes v noci' : `V noci na ${night.date}`;
  const air = `klesne na ${fmtTemp(night.airMin)}`;
  if (!night.clearCalm) return `${prefix} ${air}.`;
  return (
    `${prefix} ${air}, ale má byť jasno a bezvetrie ` +
    `(oblačnosť ${Math.round(night.cloud)} %, vietor ${Math.round(night.wind)} km/h) — ` +
    `na liste to vychádza okolo ${fmtTemp(night.leafMin)}.`
  );
}

function buildAlert(level, night, location, today) {
  let body;
  if (level === BRING_IN_C) {
    body =
      location === 'outside'
        ? 'Prines avokádo dnu — začína sezóna, keď mu vonku škodí chlad ' +
          '(v pásme pod 5 °C sa pri dlhšej expozícii poškodzujú listy).'
        : 'Prvá noc pod 5 °C v tejto sezóne.';
  } else if (level === URGENT_C) {
    body = 'Ak je avokádo ešte vonku, dnes mu to naozaj uškodí — musí dnu.';
  } else {
    body = 'Mrzne. Avokádo vonku túto noc neprežije bez poškodenia.';
  }
  const icon = level === BRING_IN_C ? '🥶' : '🧊';
  return `${icon} Melichar\n\n${nightLabel(night, today)}\n${body}`;
}

// --- Rozhodovanie ----------------------------------------------------------
export function decide(nights, state, today) {
  const avocado = { ...state.avocado, alertedBelow: [...state.avocado.alertedBelow] };
  const upcoming = nights.filter((n) => n.date > today);
  const messages = [];
  if (!upcoming.length) return { messages, state: { ...state, avocado } };

  // Dnesna a zajtrajsia noc - dost na to, aby sprava prisla vcas, a malo na to,
  // aby sa hlasilo ochladenie, ktore je este 5 dni daleko a moze sa zmenit.
  const horizon = upcoming.slice(0, 2);

  // Najstudensi milnik, ktory v tomto okne padne a este sa tuto sezonu nehlasil.
  let hit = null;
  for (const night of horizon) {
    for (const level of MILESTONES) {
      if (night.leafMin <= level && !avocado.alertedBelow.includes(level)) {
        if (!hit || level < hit.level) hit = { level, night };
      }
    }
  }

  if (hit) {
    // Odflagne sa vsetko, co tato noc prekrocila, nielen najnizsi milnik -
    // inak by pri skoku z 8 na -1 prisli tri spravy za sebou.
    for (const level of MILESTONES) {
      if (hit.night.leafMin <= level && !avocado.alertedBelow.includes(level)) {
        avocado.alertedBelow.push(level);
      }
    }
    messages.push(buildAlert(hit.level, hit.night, avocado.location, today));
    if (avocado.location === 'outside') {
      avocado.location = 'inside';
      avocado.since = today;
    }
  }

  // Jar: az ked je cely vyhlad stabilne teply. Mesiac je poistka proti
  // februarovemu oteplenu, po ktorom este pride mraz.
  const month = Number(today.slice(5, 7));
  const warmRun = upcoming.slice(0, SPRING_RUN_NIGHTS);
  if (
    avocado.location === 'inside' &&
    month >= 4 &&
    month <= 6 &&
    warmRun.length >= SPRING_RUN_NIGHTS &&
    warmRun.every((n) => n.leafMin > PUT_OUT_C)
  ) {
    const coldest = Math.min(...warmRun.map((n) => n.leafMin));
    messages.push(
      `🌱 Melichar\n\nNajbližších ${SPRING_RUN_NIGHTS} nocí neklesne pod ${fmtTemp(coldest)} — ` +
        'avokádo môžeš dať von na balkón.'
    );
    avocado.location = 'outside';
    avocado.since = today;
    avocado.alertedBelow = [];
  }

  return { messages, state: { ...state, avocado } };
}

// --- Prikazy z Telegramu ---------------------------------------------------
// Melichar nema webhook (a nepotrebuje ho) - na zaciatku kazdeho behu sa spyta
// getUpdates, co mu odvtedy prislo. Telegram drzi neprevzate spravy 24 h, co pri
// troch behoch denne staci.

const COMMAND_WORDS = {
  inside: ['dnu', 'dovnutra', 'vnutri', 'schoval', 'schovane', 'inside', 'in'],
  outside: ['von', 'vonku', 'vytiahol', 'vytiahnute', 'outside', 'out'],
  status: ['stav', 'status'],
  help: ['help', 'pomoc', 'start'],
};

const HELP_TEXT = [
  'Melichar rozumie týmto správam:',
  '',
  '/dnu — avokádo som schoval dnu; cez zimu mlč a ozvi sa na jar',
  '/von — avokádo je zase vonku; sleduj chlad a varuj ma',
  '/stav — kde je avokádo a aké sú najbližšie noci',
  '/help — tento zoznam',
].join('\n');

// Diakritika a velke pismena sa ignoruju, lomka je volitelna, "/dnu@bot" tiez.
export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const word = text
    .trim()
    .split(/\s+/)[0]
    .replace(/@\S+$/, '')
    .replace(/^\//, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  for (const [cmd, words] of Object.entries(COMMAND_WORDS)) {
    if (words.includes(word)) return cmd;
  }
  return null;
}

export function applyCommand(cmd, state, nights, today) {
  const avocado = { ...state.avocado, alertedBelow: [...state.avocado.alertedBelow] };

  if (cmd === 'inside') {
    if (avocado.location === 'inside') {
      return { state, reply: `Avokádo mám vedené ako dnu už od ${avocado.since || 'neznámeho dátumu'}.` };
    }
    avocado.location = 'inside';
    avocado.since = today;
    // Jesenne varovania su tym vybavene - uz niet pred cim varovat.
    avocado.alertedBelow = [...MILESTONES];
    return {
      state: { ...state, avocado },
      reply:
        '👍 Avokádo je dnu. Cez zimu budem ticho a ozvem sa na jar, keď vyjde ' +
        `${SPRING_RUN_NIGHTS} nocí po sebe nad ${PUT_OUT_C} °C.`,
    };
  }

  if (cmd === 'outside') {
    if (avocado.location === 'outside') {
      return { state, reply: `Avokádo mám vedené ako vonku už od ${avocado.since || 'neznámeho dátumu'}.` };
    }
    avocado.location = 'outside';
    avocado.since = today;
    // Nova sezona vonku - varovania sa zase zapinaju.
    avocado.alertedBelow = [];
    const next = nights.find((n) => n.date > today);
    const outlook = next
      ? ` Najbližšia noc ${fmtTemp(next.leafMin)}${next.clearCalm ? ' na liste' : ''}.`
      : '';
    return {
      state: { ...state, avocado },
      reply:
        `👍 Avokádo je vonku. Zase sledujem chlad a ozvem sa pred prvou nocou ` +
        `pod ${BRING_IN_C} °C.${outlook}`,
    };
  }

  if (cmd === 'status') return { state, reply: buildNightSummary(nights, state, today) };
  return { state, reply: HELP_TEXT };
}

async function fetchUpdates(offset) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  if (offset) url.searchParams.set('offset', String(offset));
  url.searchParams.set('timeout', '0');
  url.searchParams.set('allowed_updates', JSON.stringify(['message']));
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram getUpdates failed: ${JSON.stringify(data)}`);
  return data.result || [];
}

export async function processCommands(state, nights, today) {
  const replies = [];
  let next = state;
  const offset = next.telegram.lastUpdateId ? next.telegram.lastUpdateId + 1 : null;

  for (const update of await fetchUpdates(offset)) {
    // Offset sa posuva aj pri sprave, ktoru zahodime - inak by sa citala donekonecna.
    next = { ...next, telegram: { lastUpdateId: update.update_id } };
    const message = update.message;
    if (!message) continue;

    // Bota moze najst ktokolvek - prikazy beriem len z nakonfigurovaneho chatu.
    if (String(message.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID)) {
      console.log(`Ignorujem spravu z cudzieho chatu ${message.chat?.id}.`);
      continue;
    }

    const cmd = parseCommand(message.text);
    if (!cmd) {
      const quoted = (message.text || '').slice(0, 40);
      replies.push(`Nerozumiem „${quoted}".\n\n${HELP_TEXT}`);
      continue;
    }

    const applied = applyCommand(cmd, next, nights, today);
    next = applied.state;
    replies.push(applied.reply);
  }

  return { state: next, replies };
}

// --- I/O -------------------------------------------------------------------
async function loadState() {
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    parsed = {};
  }
  // `days` z povodnej verzie (detekcia zmien v 7-dnovom vyhlade) uz netreba -
  // rozhodovanie stoji na sezonnom stave, nie na porovnavani predpovedi.
  delete parsed.days;
  if (!parsed.avocado) parsed.avocado = { location: 'outside', since: null, alertedBelow: [] };
  if (!Array.isArray(parsed.avocado.alertedBelow)) parsed.avocado.alertedBelow = [];
  if (!parsed.telegram) parsed.telegram = { lastUpdateId: null };
  return parsed;
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&hourly=temperature_2m,cloud_cover,wind_speed_10m&timezone=Europe%2FPrague&forecast_days=8';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status} ${await res.text()}`);
  return (await res.json()).hourly;
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

export function buildNightSummary(nights, state, today) {
  const where = state.avocado.location === 'outside' ? 'vonku' : 'dnu';
  const lines = nights
    .filter((n) => n.date > today)
    .map((n) => {
      const leaf = n.clearCalm ? ` → na liste ~${fmtTemp(n.leafMin)} (jasno, bezvetrie)` : '';
      return `noc na ${n.date}: ${fmtTemp(n.airMin)}${leaf}`;
    });
  const since = state.avocado.since ? ` od ${state.avocado.since}` : '';
  return (
    `📋 Melichar — nadchádzajúce noci (Oznice)\n\n` +
    `Avokádo je podľa Melichara ${where}${since}.\n\n${lines.join('\n')}`
  );
}

async function main() {
  const hourly = await fetchForecast();
  const nights = buildNights(hourly);
  const today = pragueToday();
  const loaded = await loadState();

  // 1) Najprv prikazy - keby prisiel "/von", ma sa nasledujuce vyhodnotenie
  //    urobit uz nad novym stavom.
  const cmds = await processCommands(loaded, nights, today);
  for (const reply of cmds.replies) await sendTelegramMessage(reply);
  // Zapise sa hned: keby dalsi krok spadol, prikaz uz je vybaveny a odpoveda
  // odoslana - opakovat by sa nemal.
  if (cmds.replies.length) await saveState(cmds.state);

  if (isManualRun) {
    // Manualny beh je diagnostika + rucne "sprav to hned" pre prikazy.
    // Alarmy nevyhodnocuje, aby si testovanim neodflagol milnik.
    await sendTelegramMessage(buildNightSummary(nights, cmds.state, today));
    console.log(`Manual run - ${cmds.replies.length} command(s) handled, summary sent.`);
    return;
  }

  const { messages, state } = decide(nights, cmds.state, today);
  for (const msg of messages) await sendTelegramMessage(msg);
  await saveState(state);

  if (messages.length) {
    console.log(`Sent ${messages.length} message(s).\n\n${messages.join('\n\n')}`);
  } else {
    const next = nights.find((n) => n.date > today);
    console.log(
      `No notification needed. Avocado: ${state.avocado.location}. ` +
        `Next night: ${next ? fmtTemp(next.leafMin) : 'n/a'} (leaf).`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
