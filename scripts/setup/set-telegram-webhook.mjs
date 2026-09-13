// Nastavi (alebo zrusi) Telegram webhook na Cloudflare Worker.
//
//   node scripts/setup/set-telegram-webhook.mjs            # ukaze aktualny stav
//   node scripts/setup/set-telegram-webhook.mjs set        # nastavi webhook
//   node scripts/setup/set-telegram-webhook.mjs delete     # zrusi ho
//
// Potrebne premenne:
//   TELEGRAM_BOT_TOKEN        token bota
//   TELEGRAM_WEBHOOK_URL      https://melichar.<ucet>.workers.dev
//   TELEGRAM_WEBHOOK_SECRET   rovnaka hodnota ako `wrangler secret put TELEGRAM_WEBHOOK_SECRET`
//
// POZOR: kym je webhook nastaveny, getUpdates vracia HTTP 409. Zalozny polling
// v check-weather.mjs to ocakava a len to zaznamena.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Chýba TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

const action = process.argv[2] || 'info';

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

if (action === 'info') {
  const info = await call('getWebhookInfo');
  console.log('URL:                 ', info.url || '(žiadny — beží polling)');
  console.log('Čaká na doručenie:   ', info.pending_update_count);
  console.log('Kontrola tajomstva:  ', info.has_custom_certificate ? 'vlastný cert' : 'secret_token');
  if (info.last_error_message) {
    console.log('Posledná chyba:      ', info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString()
      : '?', info.last_error_message);
  }
} else if (action === 'set') {
  const url = process.env.TELEGRAM_WEBHOOK_URL;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!url || !secret) {
    console.error('Chýba TELEGRAM_WEBHOOK_URL alebo TELEGRAM_WEBHOOK_SECRET.');
    process.exit(1);
  }
  await call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message'],
    // Zahodi spravy, ktore sa nakopili pocas prepinania - inak by Worker hned
    // po nasadeni vybavil aj staru komunikaciu.
    drop_pending_updates: true,
  });
  console.log(`Webhook nastavený na ${url}`);
  console.log('Od teraz getUpdates vracia 409 — to je v poriadku, príkazy vybavuje Worker.');
} else if (action === 'delete') {
  await call('deleteWebhook', { drop_pending_updates: false });
  console.log('Webhook zrušený — príkazy zase vybaví polling v check-weather.mjs (3× denne).');
} else {
  console.error(`Neznámy príkaz "${action}". Použi: info | set | delete`);
  process.exit(1);
}
