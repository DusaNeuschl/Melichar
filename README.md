# Melichar

Sleduje 7-dňovú predpoveď počasia pre Oznice 158 (lat 49.4376699, lon 17.9046572)
a posiela cez Telegram upozornenie, keď má niektorá noc klesnúť pod 10 °C.

- **Kontroly:** 3x denne (~07:00 / 12:00 / 16:00 Europe/Prague, cron beží v UTC takže
  s DST môže reálny čas skĺznuť o +-1h)
- **Zdroj počasia:** Open-Meteo (zdarma, bez API kľúča)
- **Notifikácia:** Telegram Bot API (`sendMessage`) — zdarma, self-service, žiadne
  schvaľovanie ani 24h okno (na rozdiel od WhatsApp/Viber, kde je proaktívne
  posielanie správ mimo session okna zablokované/spoplatnené schválenými šablónami)
- **Dedup logika:**
  - Večerný beh (16:00): ak dnešná noc < 10 °C, VŽDY pošle pripomienku
  - Ktorýkoľvek beh: ak sa zmenila predpoveď pre niektorý z dní +1 až +6
    (novo klesla pod 10 °C, alebo sa naopak zlepšila), pošle update
- **Stav** (`state.json`) sa po každom behu commitne späť do repa

## Architektúra

Celá logika beží v jednom kroku na GitHub Actions cron — Telegram Bot API
nevyžaduje žiadny bežiaci webhook pre jednosmerné posielanie správ, takže
netreba žiadny druhý komponent (na rozdiel od pôvodne zvažovaného Vibera).

```
GitHub Actions (cron 3x/deň)
  -> Open-Meteo forecast (Oznice)
  -> vyhodnotí prah 10 °C + dedup voči state.json
  -> Telegram sendMessage
  -> commitne aktualizovaný state.json
```

## Nastavenie krok za krokom

### 1. Vytvor Telegram bota

1. V Telegrame nájdi **@BotFather** a napíš mu `/newbot`.
2. Zadaj meno bota (napr. "Melichar") a username (musí končiť na `bot`,
   napr. `melichar_avocado_bot`).
3. BotFather ti pošle **API token** — skopíruj si ho (vyzerá ako
   `123456789:ABCdefGhIJKlmNoPQRstuVwxYZ`).

### 2. Zisti svoje chat ID

1. Vo Telegrame si napíš svojmu novému botovi ľubovoľnú správu (napr. "ahoj").
2. Otvor v prehliadači (nahraď `<TOKEN>` skutočným tokenom):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. V JSON odpovedi nájdi `"message":{"chat":{"id": ...}}` — to číslo je tvoje
   `TELEGRAM_CHAT_ID`.

### 3. Založ GitHub repo a nastav secrets

1. Repo `melichar` je už založené a pushnuté: https://github.com/DusaNeuschl/Melichar
2. V repe choď do **Settings → Secrets and variables → Actions** a pridaj:
   - `TELEGRAM_BOT_TOKEN` — z kroku 1
   - `TELEGRAM_CHAT_ID` — z kroku 2
3. Workflow `.github/workflows/check-weather.yml` sa aktivuje automaticky
   podľa cron rozvrhu.
4. Over funkčnosť manuálne: **Actions → Melichar - Weather Check →
   Run workflow** (spustí sa ako "evening" beh, takže ak je dnes pod 10 °C,
   príde ti správa hneď).

## Neskorší presun na vlastnú VPS

Stačí presunúť cron logiku: na VPS pridaj `crontab` záznamy volajúce
`node scripts/check-weather.mjs` s rovnakými env premennými
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `RUN_TYPE`, `LATITUDE`,
`LONGITUDE`) namiesto GitHub Actions cronu, a `state.json` nechaj len ako
lokálny súbor (netreba git commit).

## Zmena prahovej teploty alebo súradníc

`THRESHOLD_C` a súradnice sú v [scripts/check-weather.mjs](scripts/check-weather.mjs)
(súradnice cez env `LATITUDE`/`LONGITUDE` vo workflow súbore).
