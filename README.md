# Avokádo Guard

Sleduje 7-dňovú predpoveď počasia pre Oznice 158 (lat 49.4376699, lon 17.9046572)
a posiela cez Viber upozornenie, keď má niektorá noc klesnúť pod 10 °C.

- **Kontroly:** 3x denne (~07:00 / 12:00 / 16:00 Europe/Prague, cron beží v UTC takže
  s DST môže reálny čas skĺznuť o +-1h)
- **Zdroj počasia:** Open-Meteo (zdarma, bez API kľúča)
- **Notifikácia:** Viber Bot API (oficiálne, `send_message`)
- **Dedup logika:**
  - Večerný beh (16:00): ak dnešná noc < 10 °C, VŽDY pošle pripomienku
  - Ktorýkoľvek beh: ak sa zmenila predpoveď pre niektorý z dní +1 až +6
    (novo klesla pod 10 °C, alebo sa naopak zlepšila), pošle update
- **Stav** (`state.json`) sa po každom behu commitne späť do repa

## Prečo dva komponenty

Viber Bot API vyžaduje bežiaci verejný HTTPS webhook, inak `send_message`
nefunguje vôbec — nestačí len jednorazovo zavolať API. GitHub Actions je
len cron, nič neposlúcha, preto webhook beží samostatne na Cloudflare
Workers (zdarma, vždy dostupný). Samotná logika kontroly počasia beží
naďalej na GitHub Actions cron.

```
GitHub Actions (cron 3x/deň)          Cloudflare Worker (vždy bežiaci)
  -> Open-Meteo forecast                -> prijíma Viber webhook callbacky
  -> vyhodnotí prah 10°C                -> udržuje Viber účet aktívny
  -> Viber send_message  ------------>  (nezávislé, len jednorazovo treba
     (priamo, nie cez worker)            na získanie tvojho user ID)
```

## Nastavenie krok za krokom

### 1. Vytvor Viber bota

1. Choď na https://partners.viber.com, prihlás sa cez Viber účet.
2. Vytvor nový **Bot Account** (nie Public Account) — zadaj meno napr.
   "Avokádo Guard".
3. Po vytvorení nájdeš v nastaveniach bota **Auth Token** — skopíruj si ho.
4. Tam istom mieste nájdeš QR kód / verejný odkaz na bota.

### 2. Nasaď Cloudflare Worker (webhook)

Potrebuješ zadarmo Cloudflare účet.

```bash
cd worker
npm create cloudflare@latest -- --existing-script  # alebo priamo:
npx wrangler login
npx wrangler deploy
```

Po deploy dostaneš URL typu
`https://avokado-guard-viber-webhook.<tvoj-subdomain>.workers.dev`.

### 3. Zaregistruj webhook vo Viberi

```bash
curl -X POST https://chatapi.viber.com/pha/set_webhook \
  -H "X-Viber-Auth-Token: <AUTH_TOKEN_Z_KROKU_1>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://avokado-guard-viber-webhook.<tvoj-subdomain>.workers.dev",
    "event_types": ["subscribed", "unsubscribed", "conversation_started", "message"]
  }'
```

Malo by prísť `{"status":0,"status_message":"ok",...}`.

### 4. Zisti svoje Viber user ID

1. V druhom termináli spusti (necháš bežať): `npx wrangler tail` (v priečinku `worker/`)
2. Vo Viber appke pridaj bota (naskenuj QR z partners.viber.com alebo klikni
   na jeho verejný odkaz) a pošli mu ľubovoľnú správu, napr. "ahoj".
3. V logu `wrangler tail` sa objaví JSON s poľom `sender.id` (alebo `user.id`
   pri evente `subscribed`) — to je tvoje `VIBER_RECEIVER_ID`. Skopíruj si ho.

### 5. Založ GitHub repo a nastav secrets

1. Zaraď tento priečinok do nového GitHub repa (môže byť súkromné).
2. V repe choď do **Settings → Secrets and variables → Actions** a pridaj:
   - `VIBER_AUTH_TOKEN` — z kroku 1
   - `VIBER_RECEIVER_ID` — z kroku 4
3. Push. Workflow `.github/workflows/check-weather.yml` sa aktivuje
   automaticky podľa cron rozvrhu.
4. Over funkčnosť manuálne: **Actions → Avokádo Guard - Weather Check →
   Run workflow** (spustí sa ako "evening" beh, takže ak je dnes pod 10 °C,
   príde ti správa hneď).

## Neskorší presun na vlastnú VPS

Cloudflare Worker (webhook) môže ostať bežať zadarmo aj potom — nie je
dôvod ho sťahovať. Stačí presunúť len cron logiku: na VPS pridaj
`crontab` záznamy volajúce `node scripts/check-weather.mjs` s rovnakými
env premennými (`VIBER_AUTH_TOKEN`, `VIBER_RECEIVER_ID`, `RUN_TYPE`,
`LATITUDE`, `LONGITUDE`) namiesto GitHub Actions cronu, a `state.json`
nechaj len ako lokálny súbor (netreba git commit).

## Zmena prahovej teploty alebo súradníc

`THRESHOLD_C` a súradnice sú v [scripts/check-weather.mjs](scripts/check-weather.mjs)
(súradnice cez env `LATITUDE`/`LONGITUDE` vo workflow súbore).
