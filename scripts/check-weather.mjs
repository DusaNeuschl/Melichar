import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const THRESHOLD_C = 10;
const STATE_PATH = fileURLToPath(new URL('../state.json', import.meta.url));

const lat = process.env.LATITUDE;
const lon = process.env.LONGITUDE;
const runType = process.env.RUN_TYPE || 'manual';
const isEveningRun = runType === 'evening' || runType === 'manual';

function fmtTemp(t) {
  return `${Math.round(t * 10) / 10}°C`;
}

async function loadState() {
  try {
    const text = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed.days) parsed.days = {};
    return parsed;
  } catch {
    return { days: {} };
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchForecast() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_min&timezone=Europe%2FPrague&forecast_days=7`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.daily.time.map((date, i) => ({ date, min: data.daily.temperature_2m_min[i] }));
}

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
    }),
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Telegram send failed: HTTP ${res.status} - ${raw.slice(0, 300)}`);
  }
  if (!data.ok) {
    throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
  }
}

async function main() {
  const forecast = await fetchForecast();
  const state = await loadState();

  const messages = [];
  const [today, ...rest] = forecast;

  if (isEveningRun && today.min < THRESHOLD_C) {
    messages.push(`Dnes v noci klesne na ${fmtTemp(today.min)} — schovaj avokádo.`);
  }
  state.days[today.date] = { min: today.min, flagged: today.min < THRESHOLD_C };

  const changeLines = [];
  for (const day of rest) {
    const newFlag = day.min < THRESHOLD_C;
    const prev = state.days[day.date];
    const isNewChange = !prev || prev.flagged !== newFlag;
    if (isNewChange && (newFlag || prev)) {
      const verb = newFlag ? 'novo klesla pod 10°C' : 'sa zlepšila nad 10°C';
      changeLines.push(`${day.date}: predpoveď ${verb} (${fmtTemp(day.min)})`);
    }
    state.days[day.date] = { min: day.min, flagged: newFlag };
  }
  if (changeLines.length) {
    messages.push(`Zmena vo výhľade:\n${changeLines.join('\n')}`);
  }

  const validDates = new Set(forecast.map((d) => d.date));
  for (const key of Object.keys(state.days)) {
    if (!validDates.has(key)) delete state.days[key];
  }

  if (messages.length) {
    await sendTelegramMessage(`🥶 Melichar\n\n${messages.join('\n\n')}`);
    console.log('Notification sent:\n' + messages.join('\n\n'));
  } else {
    console.log('No notification needed. Today min:', fmtTemp(today.min));
  }

  await saveState(state);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
