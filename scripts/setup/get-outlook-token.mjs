const clientId = process.argv[2];
if (!clientId) {
  console.error('Použitie: node scripts/setup/get-outlook-token.mjs <CLIENT_ID>');
  process.exit(1);
}

const scope = 'offline_access Mail.Read';

async function main() {
  const deviceRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/devicecode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  const device = await deviceRes.json();
  if (!deviceRes.ok) {
    console.error('Device code request zlyhal:', device);
    process.exit(1);
  }

  console.log(device.message);
  console.log('Čakám na prihlásenie...\n');

  const interval = (device.interval || 5) * 1000;
  const expiresAt = Date.now() + (device.expires_in || 900) * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval));
    const tokenRes = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.device_code,
      }),
    });
    const token = await tokenRes.json();
    if (tokenRes.ok) {
      console.log('Úspech! Toto je tvoj refresh token (ulož ako secret OUTLOOK_REFRESH_TOKEN):\n');
      console.log(token.refresh_token);
      return;
    }
    if (token.error !== 'authorization_pending') {
      console.error('Chyba:', token);
      process.exit(1);
    }
  }
  console.error('Vypršal čas na prihlásenie, spusti skript znova.');
  process.exit(1);
}

main();
