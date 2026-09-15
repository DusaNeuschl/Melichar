// Ciste rozhodovanie o avokade - ziadne I/O, ziadny fetch, ziadny subor.
//
// Tento modul pouziva Node beh (scripts/check-weather.mjs) aj Cloudflare Worker
// (worker/index.mjs). Preto tu nesmie byt nic, co bezi len v Node: synonyma
// prikazov ani prahy sa nesmu udrziavat na dvoch miestach.

// `process` v Cloudflare Workers neexistuje - konfiguracia sa cita obozretne.
const env = (typeof process !== 'undefined' && process.env) || {};
const num = (name, fallback) => Number(env[name] ?? fallback);

// --- Prahy -----------------------------------------------------------------
// Avokado je subtropicka rastlina. Pod 10 C len zastavi rast (neskodi mu to),
// pasmo 4-10 C je uz chilling injury pri dlhsej expozicii, pod 0 C prichadza
// realne poskodenie mladych neotuzenych rastlin v kvetinaci.
export const BRING_IN_C = num('BRING_IN_C', 5); // jesenne "prines dnu"
export const URGENT_C = num('URGENT_C', 2); // "ak je este vonku, hori"
export const FREEZE_C = num('FREEZE_C', 0); // mraz
export const PUT_OUT_C = num('PUT_OUT_C', 8); // "mozes dat von"
export const PUT_OUT_RUN_NIGHTS = num('PUT_OUT_RUN_NIGHTS', 7); // kolko teplych noci po sebe
// Mesiace, v ktorych sa "mozes dat von" vobec zvazuje (vratane).
const PUT_OUT_MIN_MONTH = num('PUT_OUT_MIN_MONTH', 1);
const PUT_OUT_MAX_MONTH = num('PUT_OUT_MAX_MONTH', 12);
// Kolko dni musi avokado zostat dnu, nez sa ponuka navrat von. Backtest na 4
// rokoch ukazal, ze proti hojdaniu staci uz poziadavka na 7 noci po sebe
// (cooldown 0 vs 10 dni = 6,3 vs 5,8 spravy rocne), takze staci mala poistka.
const PUT_OUT_COOLDOWN_DAYS = num('PUT_OUT_COOLDOWN_DAYS', 3);

// Milniky sa hlasia raz za sezonu, zoradene od najteplejsieho.
export const MILESTONES = [BRING_IN_C, URGENT_C, FREEZE_C];

// Radiacny mraz: za jasnej bezvetrej noci vyzaruje list teplo do oblohy a je
// chladnejsi nez teplota vzduchu v 2 m, ktoru hlasi predpoved. Kvetinac navyse
// nema tepelnu zotrvacnost zahonu.
const CLEAR_CLOUD_PCT = num('CLEAR_CLOUD_PCT', 30);
const CALM_WIND_KMH = num('CALM_WIND_KMH', 10);
const RADIATIVE_PENALTY_C = num('RADIATIVE_PENALTY_C', 3);

export function fmtTemp(t) {
  return `${Math.round(t * 10) / 10}°C`;
}

export function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
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

// Prazdny stav, ked este ziadny neexistuje.
export function emptyState() {
  return {
    avocado: { location: 'outside', since: null, alertedBelow: [] },
    telegram: { lastUpdateId: null },
  };
}

// Doplni chybajuce bloky do nacitaneho stavu (aj migracia zo starsieho tvaru).
export function normalizeState(parsed) {
  const state = { ...(parsed || {}) };
  // `days` z povodnej verzie (detekcia zmien v 7-dnovom vyhlade) uz netreba -
  // rozhodovanie stoji na sezonnom stave, nie na porovnavani predpovedi.
  delete state.days;
  if (!state.avocado) state.avocado = emptyState().avocado;
  if (!Array.isArray(state.avocado.alertedBelow)) state.avocado.alertedBelow = [];
  if (!state.telegram) state.telegram = { lastUpdateId: null };
  return state;
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

  // "Mozes dat von": az ked je cely vyhlad stabilne teply. Nie je to viazane na
  // jar - aj po jesennom ochladeni sa moze vratit babie leto a avokado moze ist
  // este na par tyzdnov von. Proti hojdaniu tam a spat je cooldown.
  const month = Number(today.slice(5, 7));
  const warmRun = upcoming.slice(0, PUT_OUT_RUN_NIGHTS);
  const dnuDost =
    !avocado.since || daysBetween(avocado.since, today) >= PUT_OUT_COOLDOWN_DAYS;
  if (
    avocado.location === 'inside' &&
    month >= PUT_OUT_MIN_MONTH &&
    month <= PUT_OUT_MAX_MONTH &&
    dnuDost &&
    warmRun.length >= PUT_OUT_RUN_NIGHTS &&
    warmRun.every((n) => n.leafMin > PUT_OUT_C)
  ) {
    const coldest = Math.min(...warmRun.map((n) => n.leafMin));
    messages.push(
      `🌱 Melichar\n\nNajbližších ${PUT_OUT_RUN_NIGHTS} nocí neklesne pod ${fmtTemp(coldest)} — ` +
        'avokádo môžeš dať von na balkón.'
    );
    avocado.location = 'outside';
    avocado.since = today;
    avocado.alertedBelow = [];
  }

  return { messages, state: { ...state, avocado } };
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

// --- Prikazy ---------------------------------------------------------------
const COMMAND_WORDS = {
  inside: ['dnu', 'dovnutra', 'vnutri', 'schoval', 'schovane', 'inside', 'in'],
  outside: ['von', 'vonku', 'vytiahol', 'vytiahnute', 'outside', 'out'],
  status: ['stav', 'status'],
  help: ['help', 'pomoc', 'start'],
};

export const HELP_TEXT = [
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
      return {
        state,
        changed: false,
        reply: `Avokádo mám vedené ako dnu už od ${avocado.since || 'neznámeho dátumu'}.`,
      };
    }
    avocado.location = 'inside';
    avocado.since = today;
    // Jesenne varovania su tym vybavene - uz niet pred cim varovat.
    avocado.alertedBelow = [...MILESTONES];
    return {
      state: { ...state, avocado },
      changed: true,
      reply:
        '👍 Avokádo je dnu. Budem ticho a ozvem sa, keď príde ' +
        `${PUT_OUT_RUN_NIGHTS} nocí po sebe nad ${PUT_OUT_C} °C — vtedy ho môžeš dať zase von.`,
    };
  }

  if (cmd === 'outside') {
    if (avocado.location === 'outside') {
      return {
        state,
        changed: false,
        reply: `Avokádo mám vedené ako vonku už od ${avocado.since || 'neznámeho dátumu'}.`,
      };
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
      changed: true,
      reply:
        `👍 Avokádo je vonku. Zase sledujem chlad a ozvem sa pred prvou nocou ` +
        `pod ${BRING_IN_C} °C.${outlook}`,
    };
  }

  if (cmd === 'status') {
    return { state, changed: false, reply: buildNightSummary(nights, state, today) };
  }
  return { state, changed: false, reply: HELP_TEXT };
}

// Open-Meteo URL je rovnake pre Node aj Worker.
export function forecastUrl(lat, lon) {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&hourly=temperature_2m,cloud_cover,wind_speed_10m&timezone=Europe%2FPrague&forecast_days=8'
  );
}
