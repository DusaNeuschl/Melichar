async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

function headerValue(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Dedup is done via a capped set of processed message ids rather than a precise
// timestamp, because Gmail's search query only supports day-granularity
// ("newer_than:Nd"), not exact timestamps.
export async function fetchNewGmailMessages({ label, clientId, clientSecret, refreshToken, processedIds }) {
  const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
  const authHeaders = { Authorization: `Bearer ${accessToken}` };

  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=' +
      encodeURIComponent('newer_than:2d in:inbox -in:chats'),
    { headers: authHeaders }
  );
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error(`Gmail list failed (${label}): ${JSON.stringify(listData)}`);

  const ids = (listData.messages || []).map((m) => m.id);
  const processedSet = new Set(processedIds || []);
  const newIds = ids.filter((id) => !processedSet.has(id));

  const emails = [];
  for (const id of newIds) {
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: authHeaders }
    );
    const msg = await msgRes.json();
    if (!msgRes.ok) continue;
    emails.push({
      mailbox: label,
      id,
      from: headerValue(msg.payload?.headers, 'From'),
      subject: headerValue(msg.payload?.headers, 'Subject'),
      preview: msg.snippet || '',
    });
  }

  const newProcessedIds = [...new Set([...ids, ...(processedIds || [])])].slice(0, 300);
  return { emails, newProcessedIds };
}
