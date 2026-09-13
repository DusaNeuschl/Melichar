import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  buildNights,
  buildNightSummary,
  decide,
  fmtTemp,
  forecastUrl,
  normalizeState,
  parseCommand,
  applyCommand,
  pragueToday,
  HELP_TEXT,
} from './lib/avocado.mjs';

const STATE_PATH = fileURLToPath(new URL('../state.json', import.meta.url));
const lat = process.env.LATITUDE;
const lon = process.env.LONGITUDE;
const runType = process.env.RUN_TYPE || 'manual';
const isManualRun = runType === 'manual';

// --- I/O -------------------------------------------------------------------
async function loadState() {
  try {
    return normalizeState(JSON.parse(await readFile(STATE_PATH, 'utf8')));
  } catch {
    return normalizeState({});
  }
}

async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

async function fetchForecast() {
  const res = await fetch(forecastUrl(lat, lon));
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

// --- Prikazy: zalozna cesta bez webhooku -----------------------------------
// Ked je nastaveny webhook (worker/), Telegram getUpdates odmieta s HTTP 409 a
// prikazy vybavuje Worker. Toto je zalozna cesta pre pripad, ze webhook este
// nie je nasadeny alebo bol zruseny - preto sa 409 len zaznamena a beh pokracuje.
async function fetchUpdates(offset) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);
  if (offset) url.searchParams.set('offset', String(offset));
  url.searchParams.set('timeout', '0');
  url.searchParams.set('allowed_updates', JSON.stringify(['message']));
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) {
    if (res.status === 409 || /webhook/i.test(data.description || '')) {
      console.log('Webhook je aktivny - prikazy vybavuje Worker, polling sa preskakuje.');
      return null;
    }
    throw new Error(`Telegram getUpdates failed: ${JSON.stringify(data)}`);
  }
  return data.result || [];
}

export async function processCommands(state, nights, today) {
  const replies = [];
  let next = state;
  const offset = next.telegram.lastUpdateId ? next.telegram.lastUpdateId + 1 : null;

  const updates = await fetchUpdates(offset);
  if (updates === null) return { state, replies };

  for (const update of updates) {
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

async function main() {
  const hourly = await fetchForecast();
  const nights = buildNights(hourly);
  const today = pragueToday();
  const loaded = await loadState();

  // 1) Zaostale prikazy (len ked nebezi webhook) - keby prisiel "/von", ma sa
  //    nasledujuce vyhodnotenie urobit uz nad novym stavom.
  const cmds = await processCommands(loaded, nights, today);
  for (const reply of cmds.replies) await sendTelegramMessage(reply);
  // Zapise sa hned: keby dalsi krok spadol, prikaz uz je vybaveny a odpoved
  // odoslana - opakovat by sa nemal.
  if (cmds.replies.length) await saveState(cmds.state);

  if (isManualRun) {
    // Manualny beh je diagnostika. Alarmy nevyhodnocuje, aby si testovanim
    // neodflagol milnik.
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
