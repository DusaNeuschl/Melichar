// Nastavi (alebo zrusi) Telegram webhook na Cloudflare Worker.
//
//   node scripts/setup/set-telegram-webhook.mjs            # ukaze aktualny stav
//   node scripts/setup/set-telegram-webhook.mjs set        # nastavi webhook
//   node scripts/setup/set-telegram-webhook.mjs delete     # zrusi ho
//
// Na hodnoty, ktore chybaju, sa skript OPYTA. Netreba teda riesit, ze premenne
// prostredia sa v PowerShelli, cmd a bashi nastavuju tromi roznymi syntaxami -
// a token sa tak ani nedostane do historie prikazov.
//
// Kto chce, moze ich dodat aj vopred cez premenne:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_URL, TELEGRAM_WEBHOOK_SECRET
//
// POZOR: kym je webhook nastaveny, getUpdates vracia HTTP 409. Zalozny polling
// v check-weather.mjs to ocakava a len to zaznamena.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const action = process.argv[2] || 'info';

if (!['info', 'set', 'delete'].includes(action)) {
  console.error(`Neznámy príkaz "${action}". Použi: info | set | delete`);
  process.exit(1);
}

// Uvodzovky okolo hodnoty niektore shelly nechaju v premennej - orezeme ich.
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '');

const rl = createInterface({ input: stdin, output: stdout });

async function need(envName, otazka, kontrola) {
  let value = clean(process.env[envName]);
  while (!value || (kontrola && !kontrola(value))) {
    if (value) console.log('  (to nevyzerá správne, skús znova)');
    // Bez terminalu sa nema koho opytat - radsej zrozumitelna chyba nez ticho
    // visiaci proces (napr. ked to niekto puta z workflowu alebo s presmerovanym
    // vstupom).
    if (!stdin.isTTY) {
      console.error(`\nChýba ${envName} a nie je sa koho opýtať (vstup nie je terminál).`);
      console.error(`Spusti skript v okne terminálu, alebo nastav ${envName} vopred.`);
      rl.close();
      process.exit(1);
    }
    value = clean(await rl.question(`${otazka}: `));
  }
  return value;
}

const token = await need(
  'TELEGRAM_BOT_TOKEN',
  'Token bota od @BotFather',
  (v) => /^\d+:[\w-]+$/.test(v)
);

async function call(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} zlyhalo: ${JSON.stringify(data)}`);
  return data.result;
}

try {
  if (action === 'info') {
    const info = await call('getWebhookInfo');
    console.log('\nURL:                 ', info.url || '(žiadny — beží polling)');
    console.log('Čaká na doručenie:   ', info.pending_update_count);
    if (info.last_error_message) {
      const kedy = info.last_error_date
        ? new Date(info.last_error_date * 1000).toISOString().replace('T', ' ').slice(0, 19)
        : '?';
      console.log('Posledná chyba:      ', kedy, '—', info.last_error_message);
    } else if (info.url) {
      console.log('Posledná chyba:       žiadna — webhook je zdravý');
    }
  } else if (action === 'set') {
    const url = await need(
      'TELEGRAM_WEBHOOK_URL',
      'URL Workera (https://melichar.<subdoména>.workers.dev)',
      (v) => /^https:\/\/[^\s]+$/.test(v)
    );
    const secret = await need(
      'TELEGRAM_WEBHOOK_SECRET',
      'Tajomstvo pre webhook (to isté ako vo `wrangler secret put`)',
      (v) => v.length >= 8
    );
    await call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message'],
      // Zahodi spravy, ktore sa nakopili pocas prepinania - inak by Worker hned
      // po nasadeni vybavil aj staru komunikaciu.
      drop_pending_updates: true,
    });
    console.log(`\nWebhook nastavený na ${url}`);
    console.log('Od teraz getUpdates vracia 409 — to je v poriadku, príkazy vybavuje Worker.');
    console.log('Skús botovi napísať /stav — odpoveď má prísť do sekundy.');
  } else {
    await call('deleteWebhook', { drop_pending_updates: false });
    console.log('\nWebhook zrušený — príkazy zase vybaví polling v check-weather.mjs (3× denne).');
  }
} catch (err) {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
