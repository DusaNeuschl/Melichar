async function getAccessToken(clientId, refreshToken) {
  const res = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'offline_access Mail.Read',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Outlook token refresh failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export async function fetchNewOutlookMessages({ label, clientId, refreshToken, lastCheck }) {
  const accessToken = await getAccessToken(clientId, refreshToken);
  const filter = `receivedDateTime gt ${lastCheck}`;
  const url =
    'https://graph.microsoft.com/v1.0/me/messages?$select=id,from,subject,bodyPreview,receivedDateTime&$orderby=receivedDateTime desc&$top=50&$filter=' +
    encodeURIComponent(filter);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Outlook list failed (${label}): ${JSON.stringify(data)}`);

  const emails = (data.value || []).map((m) => ({
    mailbox: label,
    id: m.id,
    from: m.from?.emailAddress?.address || m.from?.emailAddress?.name || '(neznámy)',
    subject: m.subject || '',
    preview: m.bodyPreview || '',
  }));

  return { emails, newLastCheck: new Date().toISOString() };
}
