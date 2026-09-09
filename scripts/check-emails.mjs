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
  const failures = [];

  // Každá schránka je samostatný externý systém, ktorý môže vypadnúť nezávisle
  // od ostatných. Zlyhanie jednej sa preto zbiera a beh pokračuje ďalej, aby
  // výpadok jedného zdroja nezobral súhrn zo zvyšných troch.
  //
  // Nenakonfigurovaná schránka (chýbajúce secrets) sa ticho preskočí a nepočíta
  // sa ako zlyhanie - schránky sa dajú zapínať postupne, jedna po druhej, bez
  // toho, aby zvyšné hlásili chybu pri každom behu.
  async function source(key, needs, run) {
    const missing = needs.filter((n) => !process.env[n]);
    if (missing.length) {
      console.log(`[${key}] preskočené, nenakonfigurované (chýba ${missing.join(', ')})`);
      return;
    }
    const prev = state.mailboxes[key] || {};
    try {
      const { emails, update, isBaseline } = await run(prev);
      if (!isBaseline) allNewEmails.push(...emails);
      stateUpdates[key] = update;
    } catch (err) {
      failures.push({ key, message: err.message });
      console.error(`[${key}] ${err.message}`);
    }
  }

  await source('gmail:dushi.mokry@gmail.com', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_PERSONAL_REFRESH_TOKEN'], async (prev) => {
    const { emails, newProcessedIds } = await fetchNewGmailMessages({
      label: 'dushi.mokry@gmail.com',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_PERSONAL_REFRESH_TOKEN,
      processedIds: prev.processedIds,
    });
    return { emails, update: { processedIds: newProcessedIds }, isBaseline: !prev.processedIds };
  });

  await source('gmail:dneuschl@monetplus.cz', ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GMAIL_WORK_REFRESH_TOKEN'], async (prev) => {
    const { emails, newProcessedIds } = await fetchNewGmailMessages({
      label: 'dneuschl@monetplus.cz',
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_WORK_REFRESH_TOKEN,
      processedIds: prev.processedIds,
    });
    return { emails, update: { processedIds: newProcessedIds }, isBaseline: !prev.processedIds };
  });

  await source('outlook:neuschl.dusan@outlook.cz', ['MS_CLIENT_ID', 'OUTLOOK_REFRESH_TOKEN'], async (prev) => {
    const { emails, newLastCheck } = await fetchNewOutlookMessages({
      label: 'neuschl.dusan@outlook.cz',
      clientId: process.env.MS_CLIENT_ID,
      refreshToken: process.env.OUTLOOK_REFRESH_TOKEN,
      lastCheck: prev.lastCheck || new Date().toISOString(),
    });
    return { emails, update: { lastCheck: newLastCheck }, isBaseline: !prev.lastCheck };
  });

  await source('imap:reaminator@email.cz', ['SEZNAM_IMAP_USER', 'SEZNAM_IMAP_PASSWORD'], async (prev) => {
    const { emails, newLastUid } = await fetchNewImapMessages({
      label: 'reaminator@email.cz',
      host: 'imap.seznam.cz',
      port: 993,
      user: process.env.SEZNAM_IMAP_USER,
      password: process.env.SEZNAM_IMAP_PASSWORD,
      lastUid: prev.lastUid,
    });
    return { emails, update: { lastUid: newLastUid }, isBaseline: prev.lastUid == null };
  });

  // Vodoznaky úspešných schránok sa uložia aj vtedy, keď iné zlyhali - inak by
  // sa ich správy pri ďalšom behu poslali znova.
  for (const [key, value] of Object.entries(stateUpdates)) {
    state.mailboxes[key] = value;
  }
  await saveState(state);

  const lines = ['📧 Melichar — emaily'];

  if (allNewEmails.length > 0) {
    const offers = [];
    let otherCount = 0;
    try {
      for (const c of await classifyEmails(allNewEmails)) {
        const email = allNewEmails[c.index];
        if (!email) continue;
        if (c.category === 'ponuka') {
          offers.push({ from: email.from, summary: c.summary || email.subject });
        } else {
          otherCount += 1;
        }
      }
    } catch (err) {
      // Bez klasifikácie je lepšie poslať holý zoznam než nič.
      failures.push({ key: 'klasifikácia', message: err.message });
      console.error(`[klasifikácia] ${err.message}`);
      lines.push('', `Nové emaily (${allNewEmails.length}), neroztriedené:`);
      allNewEmails.forEach((e, i) => lines.push(`${i + 1}. [${e.from}] ${e.subject}`));
    }

    if (offers.length) {
      lines.push('', `Obchodné ponuky (${offers.length}):`);
      offers.forEach((o, i) => lines.push(`${i + 1}. [${o.from}] ${o.summary}`));
    }
    if (otherCount) {
      lines.push('', `Ostatné: +${otherCount} iných emailov`);
    }
  }

  if (failures.length) {
    lines.push('', `⚠️ Nedostupné zdroje (${failures.length}):`);
    failures.forEach((f) => lines.push(`- ${f.key}: ${f.message.slice(0, 200)}`));
  }

  if (lines.length > 1) {
    await sendTelegramMessage(lines.join('\n'));
  } else {
    console.log('No new emails since last check.');
  }

  console.log(`Sources failed: ${failures.length}, new emails: ${allNewEmails.length}.`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
