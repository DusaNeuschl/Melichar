import { ImapFlow } from 'imapflow';

function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Best-effort plain-text preview (not a full MIME parser) - good enough for
// AI classification purposes, may contain minor encoding artifacts on some messages.
export async function fetchNewImapMessages({ label, host, port, user, password, lastUid }) {
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });

  await client.connect();
  const emails = [];
  let newLastUid = lastUid;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { uidNext: true });
      const uidNext = status.uidNext;

      if (lastUid == null) {
        newLastUid = uidNext - 1;
      } else if (uidNext - 1 > lastUid) {
        const range = `${lastUid + 1}:${uidNext - 1}`;
        for await (const msg of client.fetch(range, { envelope: true, uid: true })) {
          let preview = '';
          try {
            const part = await client.download(msg.uid, 'TEXT', { uid: true });
            const chunks = [];
            for await (const chunk of part.content) chunks.push(chunk);
            preview = stripHtml(Buffer.concat(chunks).toString('utf8')).slice(0, 500);
          } catch {
            // best-effort preview only
          }
          emails.push({
            mailbox: label,
            id: String(msg.uid),
            from: msg.envelope?.from?.[0]?.address || '(neznámy)',
            subject: msg.envelope?.subject || '',
            preview,
          });
        }
        newLastUid = uidNext - 1;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { emails, newLastUid };
}
