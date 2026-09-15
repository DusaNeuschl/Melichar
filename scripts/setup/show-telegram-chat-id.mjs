// Vypise chat ID, z ktoreho botovi pisu spravy.
//
//   $env:TELEGRAM_BOT_TOKEN="..."
//   node scripts/setup/show-telegram-chat-id.mjs
//
// GitHub secrets sa spatne precitat nedaju, takze ked chat ID potrebujes znova
// (napr. pri nastavovani Workera), najjednoduchsie je vytiahnut si ho takto.
//
// POZOR: funguje len KYM NIE JE nastaveny webhook. Ked uz bezi Worker, Telegram
// getUpdates odmieta s HTTP 409 - vtedy webhook docasne zrus cez
// `node scripts/setup/set-telegram-webhook.mjs delete`, zisti ID a nastav spat.

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Chýba TELEGRAM_BOT_TOKEN.');
  console.error('PowerShell:  $env:TELEGRAM_BOT_TOKEN="123456:ABC..."');
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
  console.log('(Neprevzaté správy sa držia 24 hodín.)');
  process.exit(0);
}

console.log('Nájdené chaty:\n');
for (const chat of chats.values()) {
  const meno = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.title || '';
  console.log(`  TELEGRAM_CHAT_ID = ${chat.id}    (${chat.type}${meno ? ', ' + meno : ''})`);
}
console.log('\nTo je hodnota pre `wrangler secret put TELEGRAM_CHAT_ID`.');
