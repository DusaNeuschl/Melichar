import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchNewGmailMessages } from './lib/gmail.mjs';
import { fetchNewOutlookMessages } from './lib/outlook.mjs';
import { fetchNewImapMessages } from './lib/imap.mjs';
import { classifyEmails } from './lib/claude.mjs';

const STATE_PATH = fileURLToPath(new URL('../email-state.json', import.meta.url));

async function loadState() {
  try {
    const text = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed.mailboxes) parsed.mailboxes = {};
    return parsed;
  } catch {
    return { mailboxes: {} };
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

async function main() {
  const state = await loadState();
  const allNewEmails = [];
  const stateUpdates = {};

  // Gmail: dushi.mokry@gmail.com
  {
    const key = 'gmail:dushi.mokry@gmail.com';
    const prev = state.mailboxes[key] || {};
    const isBaseline = !prev.processedIds;
    const { emails, newProcessedIds } = await fetchNewGmailMessages({
      label: 'dushi.mokry@gmail.com',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_PERSONAL_REFRESH_TOKEN,
      processedIds: prev.processedIds,
    });
    if (!isBaseline) allNewEmails.push(...emails);
    stateUpdates[key] = { processedIds: newProcessedIds };
  }

  // Gmail (Google Workspace): dneuschl@monetplus.cz
  {
    const key = 'gmail:dneuschl@monetplus.cz';
    const prev = state.mailboxes[key] || {};
    const isBaseline = !prev.processedIds;
    const { emails, newProcessedIds } = await fetchNewGmailMessages({
      label: 'dneuschl@monetplus.cz',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_WORK_REFRESH_TOKEN,
      processedIds: prev.processedIds,
    });
    if (!isBaseline) allNewEmails.push(...emails);
    stateUpdates[key] = { processedIds: newProcessedIds };
  }

  // Outlook: neuschl.dusan@outlook.cz
  {
    const key = 'outlook:neuschl.dusan@outlook.cz';
    const prev = state.mailboxes[key] || {};
    const isBaseline = !prev.lastCheck;
    const lastCheck = prev.lastCheck || new Date().toISOString();
    const { emails, newLastCheck } = await fetchNewOutlookMessages({
      label: 'neuschl.dusan@outlook.cz',
      clientId: process.env.MS_CLIENT_ID,
      refreshToken: process.env.OUTLOOK_REFRESH_TOKEN,
      lastCheck,
    });
    if (!isBaseline) allNewEmails.push(...emails);
    stateUpdates[key] = { lastCheck: newLastCheck };
  }

  // IMAP: reaminator@email.cz (Seznam)
  {
    const key = 'imap:reaminator@email.cz';
    const prev = state.mailboxes[key] || {};
    const isBaseline = prev.lastUid == null;
    const { emails, newLastUid } = await fetchNewImapMessages({
      label: 'reaminator@email.cz',
      host: 'imap.seznam.cz',
      port: 993,
      user: process.env.SEZNAM_IMAP_USER,
      password: process.env.SEZNAM_IMAP_PASSWORD,
      lastUid: prev.lastUid,
    });
    if (!isBaseline) allNewEmails.push(...emails);
    stateUpdates[key] = { lastUid: newLastUid };
  }

  for (const [key, value] of Object.entries(stateUpdates)) {
    state.mailboxes[key] = value;
  }
  await saveState(state);

  if (allNewEmails.length === 0) {
    console.log('No new emails since last check.');
    return;
  }

  const classifications = await classifyEmails(allNewEmails);

  const offers = [];
  let otherCount = 0;
  for (const c of classifications) {
    const email = allNewEmails[c.index];
    if (!email) continue;
    if (c.category === 'ponuka') {
      offers.push({ from: email.from, summary: c.summary || email.subject });
    } else {
      otherCount += 1;
    }
  }

  const lines = ['📧 Melichar — emaily'];
  if (offers.length) {
    lines.push('', `Obchodné ponuky (${offers.length}):`);
    offers.forEach((o, i) => lines.push(`${i + 1}. [${o.from}] ${o.summary}`));
  }
  if (otherCount) {
    lines.push('', `Ostatné: +${otherCount} iných emailov`);
  }

  await sendTelegramMessage(lines.join('\n'));
  console.log(`Sent digest: ${offers.length} offers, ${otherCount} other.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
