// Cloudflare Worker: prijma Telegram webhook a odpoveda OKAMZITE.
//
// Delba prace s GitHub Actions:
//   Worker   - odpoveda na prikazy (do sekundy, nonstop)
//   Actions  - zapisuje stav do repa a 3x denne vyhodnocuje alarmy
//
// Worker nema vlastne ulozisko. Aktualny stav si precita z repa cez GitHub API
// a zmenu nezapisuje sam - posle repository_dispatch a zapis spravi workflow
// handle-command.yml. Odpoved teda odide hned, commit dobehne do minuty.

import {
  applyCommand,
  buildNights,
  forecastUrl,
  normalizeState,
  parseCommand,
  pragueToday,
  HELP_TEXT,
} from '../scripts/lib/avocado.mjs';

const GITHUB_API = 'https://api.github.com';

async function telegram(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${JSON.stringify(data)}`);
  return data.result;
}

// Cita sa cez API, nie cez raw.githubusercontent - raw je za CDN cache a vracal
// by stav stary aj niekolko minut, takze "/stav" by klamal hned po "/dnu".
async function readState(env) {
  const url = `${GITHUB_API}/repos/${env.GITHUB_REPO}/contents/state.json?ref=main`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'melichar-worker',
    },
  });
  if (!res.ok) throw new Error(`GitHub contents failed: ${res.status} ${await res.text()}`);
  return normalizeState(JSON.parse(await res.text()));
}

async function dispatchCommand(env, cmd, today) {
  const res = await fetch(`${GITHUB_API}/repos/${env.GITHUB_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'melichar-worker',
    },
    body: JSON.stringify({
      event_type: 'melichar-command',
      client_payload: { command: cmd, today },
    }),
  });
  if (!res.ok) throw new Error(`repository_dispatch failed: ${res.status} ${await res.text()}`);
}

async function fetchNights(env) {
  const res = await fetch(forecastUrl(env.LATITUDE, env.LONGITUDE));
  if (!res.ok) return [];
  const { hourly } = await res.json();
  return hourly ? buildNights(hourly) : [];
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('Melichar webhook', { status: 200 });

    // Telegram posiela tajomstvo nastavene pri setWebhook. Bez tejto kontroly by
    // mohol endpoint volat ktokolvek, kto uhadne URL.
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    // Telegram opakuje doruceni, kym nedostane 200. Chybu preto spracujeme
    // vnutri a vonku vzdy vratime 200, aby sa jeden prikaz neopakoval donekonecna.
    ctx.waitUntil(handle(update, env).catch((err) => console.error(err)));
    return new Response('ok', { status: 200 });
  },
};

async function handle(update, env) {
  const message = update.message;
  if (!message) return;

  // Bota moze najst ktokolvek - prikazy beriem len z nakonfigurovaneho chatu.
  if (String(message.chat?.id) !== String(env.TELEGRAM_CHAT_ID)) {
    console.log(`Ignorujem spravu z cudzieho chatu ${message.chat?.id}.`);
    return;
  }

  const cmd = parseCommand(message.text);
  if (!cmd) {
    const quoted = (message.text || '').slice(0, 40);
    await telegram(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `Nerozumiem „${quoted}".\n\n${HELP_TEXT}`,
    });
    return;
  }

  // "/help" nepotrebuje ani stav, ani predpoved - odpovie sa bez sietovych volani.
  if (cmd === 'help') {
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: HELP_TEXT });
    return;
  }

  const today = pragueToday();
  const [state, nights] = await Promise.all([readState(env), fetchNights(env)]);
  const applied = applyCommand(cmd, state, nights, today);

  await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text: applied.reply });

  // Stav sa meni len ked sa naozaj zmenil - "/stav" ani opakovane "/dnu"
  // nemaju preco spustat workflow.
  if (applied.changed) await dispatchCommand(env, cmd, today);
}
