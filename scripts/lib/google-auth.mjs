const HINTS = {
  unauthorized_client:
    'refresh token patrí inému OAuth klientovi než GOOGLE_CLIENT_ID (vygeneruj token znova tým istým klientom)',
  invalid_client: 'nesedí GOOGLE_CLIENT_ID alebo GOOGLE_CLIENT_SECRET',
  invalid_grant: 'refresh token je zrušený alebo expirovaný (consent screen v režime Testing platí 7 dní)',
};

export async function getAccessToken(clientId, clientSecret, refreshToken) {
  const missing = [
    ['client_id', clientId],
    ['client_secret', clientSecret],
    ['refresh_token', refreshToken],
  ]
    .filter(([, v]) => !v)
    .map(([n]) => n);
  if (missing.length) throw new Error(`Google auth: chýbajú hodnoty: ${missing.join(', ')}`);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      refresh_token: refreshToken.trim(),
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const hint = HINTS[data.error];
    throw new Error(
      `Google token refresh failed: ${JSON.stringify(data)}${hint ? `\n  → ${hint}` : ''}` +
        `\n  → diagnostika: node scripts/setup/diagnose-google-auth.mjs`
    );
  }
  return data.access_token;
}
