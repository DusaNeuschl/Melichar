// Lokálna diagnostika Google OAuth refresh tokenu.
//
// Použitie (PowerShell):
//   $env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."; $env:GOOGLE_CALENDAR_REFRESH_TOKEN="..."
//   node scripts/setup/diagnose-google-auth.mjs
//
// Alebo iný token, napr. Gmail:
//   node scripts/setup/diagnose-google-auth.mjs GMAIL_PERSONAL_REFRESH_TOKEN

const tokenVar = process.argv[2] || 'GOOGLE_CALENDAR_REFRESH_TOKEN';

const inputs = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  [tokenVar]: process.env[tokenVar],
};

function mask(v) {
  if (!v) return '(nenastavené)';
  if (v.length <= 12) return `${v.slice(0, 2)}…${v.slice(-2)} (dĺžka ${v.length})`;
  return `${v.slice(0, 8)}…${v.slice(-4)} (dĺžka ${v.length})`;
}

console.log('=== Vstupy ===');
let fatal = false;
for (const [name, value] of Object.entries(inputs)) {
  const notes = [];
  if (!value) {
    notes.push('CHÝBA');
    fatal = true;
  } else {
    if (value !== value.trim()) notes.push('POZOR: medzera/newline na okraji');
    if (/^["']|["']$/.test(value)) notes.push('POZOR: obalené úvodzovkami');
  }
  console.log(`${name.padEnd(32)} ${mask(value)} ${notes.join(' | ')}`);
}

const clientId = inputs.GOOGLE_CLIENT_ID || '';
if (clientId && !clientId.endsWith('.apps.googleusercontent.com')) {
  console.log('POZOR: client_id nekončí na .apps.googleusercontent.com — asi nie je celý.');
}
const refresh = inputs[tokenVar] || '';
if (refresh && !refresh.startsWith('1//')) {
  console.log("POZOR: refresh token nezačína na '1//' — Google refresh tokeny takto začínajú.");
}
if (fatal) {
  console.log('\nChýbajúce vstupy — doplň premenné a spusti znova.');
  process.exit(2);
}

console.log('\n=== Volanie https://oauth2.googleapis.com/token ===');
const res = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId.trim(),
    client_secret: (inputs.GOOGLE_CLIENT_SECRET || '').trim(),
    refresh_token: refresh.trim(),
    grant_type: 'refresh_token',
  }),
});
const data = await res.json();
console.log(`HTTP ${res.status}`);

if (res.ok) {
  console.log(`OK — access token získaný, platí ${data.expires_in}s`);
  console.log(`scope: ${data.scope}`);
  const info = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(data.access_token)}`
  ).then((r) => r.json());
  console.log(`tokeninfo.aud (klient, ktorému token patrí): ${info.aud}`);
  console.log(`tokeninfo.email: ${info.email || '(neuvedený)'}`);
  if (info.aud && info.aud !== clientId.trim()) {
    console.log('POZOR: aud sa nezhoduje s odoslaným client_id.');
  }
  process.exit(0);
}

console.log(JSON.stringify(data, null, 2));
const diagnoza = {
  unauthorized_client:
    'Refresh token NEPATRÍ tomuto client_id. Token bol vydaný inému OAuth klientovi\n' +
    '  — najčastejšie: v OAuth Playground nebolo zaškrtnuté "Use your own OAuth credentials",\n' +
    '    takže token patrí Googlu vlastnému playground klientovi;\n' +
    '  — alebo bol client v Google Cloud zmazaný a vytvorený nanovo (nový client_id);\n' +
    '  — alebo je v GitHub secrete client_id z iného projektu než ten, cez ktorý si autorizoval.\n' +
    '  RIEŠENIE: vygenerovať refresh token znova tým istým client_id/secret, ktorý je v secretoch.',
  invalid_client:
    'Nesedí client_id alebo client_secret (klient neexistuje alebo zlý secret).\n' +
    '  RIEŠENIE: skopírovať oba znova z Google Cloud → Credentials.',
  invalid_grant:
    'Refresh token je neplatný, zrušený alebo expirovaný.\n' +
    '  Typicky: consent screen je v režime "Testing" (token platí 7 dní), heslo účtu sa zmenilo,\n' +
    '  prístup bol odobraný v myaccount.google.com, alebo bol token skrátený pri kopírovaní.\n' +
    '  RIEŠENIE: Publish App na consent screene + vygenerovať token znova.',
  invalid_request: 'Zle poskladaná požiadavka — skontroluj, či niektorá hodnota nie je prázdna.',
};
console.log('\n=== Diagnóza ===');
console.log(diagnoza[data.error] || `Neznáma chyba: ${data.error}`);
process.exit(1);
