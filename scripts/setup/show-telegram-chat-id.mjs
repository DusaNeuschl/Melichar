// Vypise chat ID, z ktoreho botovi pisu spravy.
//
// Token sa da dat ako argument - funguje rovnako v PowerShelli, cmd aj bashi,
// takze netreba riesit, ako sa v ktorom nastavuje premenna prostredia:
//
//   node scripts/setup/show-telegram-chat-id.mjs 123456:ABCdef
//
// Alebo cez premennu, ked ju uz mas nastavenu:
//
//   node scripts/setup/show-telegram-chat-id.mjs
//
// GitHub secrets sa spatne precitat nedaju, takze ked chat ID potrebujes znova
// (napr. pri nastavovani Workera), najjednoduchsie je vytiahnut si ho takto.
//
// POZOR: funguje len KYM NIE JE nastaveny webhook. Ked uz bezi Worker, Telegram
// getUpdates odmieta s HTTP 409 - vtedy webhook docasne zrus cez
// `node scripts/setup/set-telegram-webhook.mjs delete`, zisti ID a nastav spat.

// Uvodzovky okolo tokenu niektore shelly nechaju v hodnote - orezeme ich.
const token = (process.argv[2] || process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '');

if (!token) {
  console.error('Chýba token.');
  console.error('Použi:  node scripts/setup/show-telegram-chat-id.mjs <token-od-BotFather>');
  process.exit(1);
}

if (!/^\d+:[\w-]+$/.test(token)) {
  console.error(`Token "${token.slice(0, 12)}..." nevyzerá ako token od BotFather.`);
  console.error('Má tvar  číslice:písmená_a_číslice  (napr. 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw)');
  console.error('Pozor na zabudnuté špicaté zátvorky < > alebo úvodzovky.');
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await res.json();

if (!data.ok) {
  if (res.status === 409 || /webhook/i.test(data.description || '')) {
    console.error('Je nastavený webhook, takže getUpdates nefunguje.');
    console.error('Zruš ho: node scripts/setup/set-telegram-webhook.mjs delete');
    process.exit(1);
  }
  console.error(`Telegram odmietol: ${JSON.stringify(data)}`);
  console.error('Skontroluj, či je token správny (celý, aj s dvojbodkou).');
  process.exit(1);
}

const chats = new Map();
for (const u of data.result || []) {
  const chat = u.message?.chat;
  if (chat) chats.set(chat.id, chat);
}

if (chats.size === 0) {
  console.log('Telegram nedrží žiadnu správu. Napíš botovi čokoľvek a spusti to znova.');
  console.log('');
  console.log('Pozor na pretek s workflowom: check-weather.mjs tiež volá getUpdates a');
  console.log('prevzaté správy tým zmiznú. Ak ti medzitým bot odpovedal (napr. nápovedou),');
  console.log('zjedol ti ju práve on — napíš novú a spusti tento skript hneď, bez toho');
  console.log('aby si medzitým púšťal "Run workflow".');
  console.log('(Neprevzaté správy sa inak držia 24 hodín.)');
  process.exit(0);
}

console.log('Nájdené chaty:\n');
for (const chat of chats.values()) {
  const meno = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
  console.log(`  TELEGRAM_CHAT_ID = ${chat.id}    (${chat.type}${meno ? ', ' + meno : ''})`);
}
console.log('\nTo je hodnota pre `wrangler secret put TELEGRAM_CHAT_ID`.');
