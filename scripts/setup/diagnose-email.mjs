// Lokálna diagnostika všetkých zdrojov pre check-emails.mjs.
//
// Otestuje každú schránku samostatne a nič neodošle - žiadny Telegram,
// žiadny zápis do email-state.json.
//
// Použitie (PowerShell):
//   $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."
//   $env:GMAIL_PERSONAL_REFRESH_TOKEN="..."; $env:GMAIL_WORK_REFRESH_TOKEN="..."
//   $env:MS_CLIENT_ID="..."; $env:OUTLOOK_REFRESH_TOKEN="..."
//   $env:SEZNAM_IMAP_USER="..."; $env:SEZNAM_IMAP_PASSWORD="..."
//   $env:ANTHROPIC_API_KEY="..."
//   node scripts/setup/diagnose-email.mjs
//
// Chýbajúce premenné sa preskočia, takže sa dá testovať aj po jednej schránke.

import { getAccessToken } from '../lib/google-auth.mjs';
import { fetchNewOutlookMessages } from '../lib/outlook.mjs';
import { fetchNewImapMessages } from '../lib/imap.mjs';

const results = [];

function have(...names) {
  const missing = names.filter((n) => !process.env[n]);
  return { ok: missing.length === 0, missing };
}

async function check(name, needs, fn) {
  const { ok, missing } = have(...needs);
  if (!ok) {
    results.push({ name, status: 'PRESKOČENÉ', detail: `chýba ${missing.join(', ')}` });
    return;
  }
  try {
    const detail = await fn();
    results.push({ name, status: 'OK', detail });
  } catch (err) {
    results.push({ name, status: 'CHYBA', detail: err.message });
  }
}

async function gmailCheck(label, tokenVar) {
  const accessToken = await getAccessToken(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env[tokenVar]
  );

  const info = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  ).then((r) => r.json());
  if (info.aud !== process.env.GOOGLE_CLIENT_ID.trim()) {
    throw new Error(`token patrí inému klientovi (aud=${info.aud})`);
  }

  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=' +
      encodeURIComponent('newer_than:2d in:inbox -in:chats'),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail list zlyhal: ${JSON.stringify(data)}`);

  const profile = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then((r) => r.json());

  const adresa = profile.emailAddress || '(neznáma)';
  if (adresa !== label) {
    throw new Error(`token patrí schránke ${adresa}, nie ${label} - autorizoval si sa pod zlým účtom`);
  }
  return `${adresa}, ${(data.messages || []).length} správ za posledné 2 dni`;
}

await check('Gmail osobný (dushi.mokry@gmail.com)', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_PERSONAL_REFRESH_TOKEN'], () =>
  gmailCheck('dushi.mokry@gmail.com', 'GMAIL_PERSONAL_REFRESH_TOKEN')
);

await check('Gmail pracovný (dneuschl@monetplus.cz)', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_WORK_REFRESH_TOKEN'], () =>
  gmailCheck('dneuschl@monetplus.cz', 'GMAIL_WORK_REFRESH_TOKEN')
);

await check('Outlook (neuschl.dusan@outlook.cz)', ['MS_CLIENT_ID', 'OUTLOOK_REFRESH_TOKEN'], async () => {
  const lastCheck = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  const { emails } = await fetchNewOutlookMessages({
    label: 'neuschl.dusan@outlook.cz',
    clientId: process.env.MS_CLIENT_ID,
    refreshToken: process.env.OUTLOOK_REFRESH_TOKEN,
    lastCheck,
  });
  return `${emails.length} správ za posledné 2 dni`;
});

await check('Seznam IMAP (reaminator@email.cz)', ['SEZNAM_IMAP_USER', 'SEZNAM_IMAP_PASSWORD'], async () => {
  const { newLastUid } = await fetchNewImapMessages({
    label: 'reaminator@email.cz',
    host: 'imap.seznam.cz',
    port: 993,
    user: process.env.SEZNAM_IMAP_USER,
    password: process.env.SEZNAM_IMAP_PASSWORD,
    lastUid: null,
  });
  return `pripojenie OK, aktuálny UID vodoznak ${newLastUid}`;
});

await check('Anthropic API', ['ANTHROPIC_API_KEY'], async () => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return `model ${data.model} odpovedá`;
});

console.log('\n=== Zdroje pre check-emails.mjs ===\n');
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.name.padEnd(width)}  ${r.status.padEnd(11)} ${r.detail}`);
}

const chyby = results.filter((r) => r.status === 'CHYBA');
const preskocene = results.filter((r) => r.status === 'PRESKOČENÉ');
console.log(
  `\n${results.length - chyby.length - preskocene.length} OK, ${chyby.length} chýb, ${preskocene.length} preskočených`
);
if (chyby.length) {
  console.log('\nPOZOR: check-emails.mjs nemá izoláciu chýb - stačí jeden zlyhaný');
  console.log('zdroj a celý beh spadne bez toho, aby prišiel akýkoľvek súhrn.');
}
process.exit(chyby.length ? 1 : 0);
