// Spolocne posielanie sprav na Telegram pre vsetky Node skripty.
//
// Telegram odmietne spravu dlhsiu ako 4096 znakov ("message is too long") a
// skript by spadol az PO tom, co cast prace uz spravil. Dlhe spravy sa preto
// delia po riadkoch na viac kusov.

const LIMIT = 3900; // rezerva pod 4096

export function splitMessage(text, limit = LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = '';
  for (const line of text.split('\n')) {
    // Riadok sam o sebe dlhsi ako limit - rozseka sa natvrdo.
    if (line.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      parts.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const parts = splitMessage(text);
  for (const [i, part] of parts.entries()) {
    const body = parts.length > 1 ? `${part}\n\n(${i + 1}/${parts.length})` : part;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: body }),
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
}
