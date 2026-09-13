// Zapise do state.json prikaz, ktory uz vybavil Worker.
//
// Worker odpoveda okamzite, ale nema kam zapisat - posle repository_dispatch a
// tento skript (cez handle-command.yml) zmenu ulozi do repa. Odpoved uz je
// odoslana, takze tu sa NIC neposiela; kdyby sa poslalo, prisla by dvakrat.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyCommand, buildNights, forecastUrl, normalizeState, pragueToday } from './lib/avocado.mjs';

const STATE_PATH = fileURLToPath(new URL('../state.json', import.meta.url));

const command = process.env.COMMAND;
const today = process.env.COMMAND_DATE || pragueToday();

if (!['inside', 'outside'].includes(command)) {
  // "status" ani "help" stav nemenia, Worker ich sem ani neposiela.
  console.error(`Neznámy alebo nezapisovateľný príkaz: ${JSON.stringify(command)}`);
  process.exit(1);
}

const state = normalizeState(JSON.parse(await readFile(STATE_PATH, 'utf8')));

// Nocna predpoved je tu len preto, ze applyCommand ju pouziva do textu odpovede.
// Odpoved zahadzujeme, takze ked Open-Meteo zlyha, pokracujeme s prazdnym polom.
let nights = [];
try {
  const res = await fetch(forecastUrl(process.env.LATITUDE, process.env.LONGITUDE));
  if (res.ok) nights = buildNights((await res.json()).hourly);
} catch (err) {
  console.log(`Predpoveď nedostupná (${err.message}), pokračujem bez nej.`);
}

const applied = applyCommand(command, state, nights, today);

if (!applied.changed) {
  console.log(`Stav sa nemení (avokádo už je ${state.avocado.location}).`);
  process.exit(0);
}

await writeFile(STATE_PATH, JSON.stringify(applied.state, null, 2) + '\n');
console.log(`Zapísané: ${JSON.stringify(applied.state.avocado)}`);
