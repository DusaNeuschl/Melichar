export async function listCalendars(accessToken) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Calendar list failed: ${JSON.stringify(data)}`);
  return (data.items || []).filter((c) => !c.deleted);
}

export async function fetchDayAgenda(accessToken, calendarId, timeMin, timeMax) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', timeMin);
  url.searchParams.set('timeMax', timeMax);
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '50');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Calendar agenda failed (${calendarId}): ${JSON.stringify(data)}`);
  return data.items || [];
}

async function listPage(accessToken, calendarId, params) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

// syncToken and timeMin are mutually exclusive on the Calendar API (HTTP 400
// if combined) - timeMin only bounds the initial/baseline full sync, every
// incremental call afterwards uses syncToken alone.
export async function syncCalendar(accessToken, calendarId, { syncToken, timeMinForBaseline }) {
  const items = [];
  let pageToken;
  let nextSyncToken = null;

  const baseParams = syncToken
    ? { syncToken, singleEvents: 'true', maxResults: '250' }
    : { timeMin: timeMinForBaseline, singleEvents: 'true', maxResults: '250' };

  do {
    const { ok, status, data } = await listPage(accessToken, calendarId, { ...baseParams, pageToken });
    if (!ok) {
      if (status === 410) return { items: [], nextSyncToken: null, expired: true };
      throw new Error(`Calendar sync failed (${calendarId}): ${JSON.stringify(data)}`);
    }
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
  } while (pageToken);

  return { items, nextSyncToken, expired: false };
}
