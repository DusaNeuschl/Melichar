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

---

# Emailový súhrn

Druhá funkcia Melichara: 3x denne (rovnaký rozvrh ako počasie) skontroluje 4
schránky, cez Claude (Anthropic API) roztriedi nové emaily na **obchodné
ponuky** (dostanú krátke AI zhrnutie) a **ostatné** (len sa spočítajú), a
pošle súhrn na Telegram. Pri prvom behu pre každú schránku sa len založí
"vodoznak" (aktuálny stav) bez posielania súhrnu za historické emaily —
reportujú sa len emaily, ktoré prídu odteraz.

## Sledované schránky

| Schránka | Typ | Poznámka |
|---|---|---|
| dushi.mokry@gmail.com | Gmail API (OAuth2) | osobný účet |
| dneuschl@monetplus.cz | Gmail API (OAuth2) | Google Workspace na firemnej doméne, beží na `imap.gmail.com`/Gmail API infra |
| neuschl.dusan@outlook.cz | Microsoft Graph (OAuth2, device code) | osobný Microsoft účet |
| reaminator@email.cz | IMAP (`imap.seznam.cz`, heslo) | Seznam email.cz |

**Riziko pri monetplus.cz:** ak má firma v Google Workspace Admin Console
zapnuté obmedzenie prístupu API pre neschválené aplikácie (Security → API
controls → App access control), autorizácia zlyhá a treba appku nechať
whitelistnúť IT oddelením. Skús to, a ak to zlyhá s chybou o "unauthorized
app", vieš, že je to toto.

## Nastavenie krok za krokom

### 1. Google Cloud projekt (pre obidve Gmail schránky)

1. Choď na https://console.cloud.google.com, založ nový projekt.
2. **APIs & Services → Library** → povoľ **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: External
   - Vyplň názov appky (napr. "Melichar"), tvoj email
   - Scopes: pridaj `https://www.googleapis.com/auth/gmail.readonly`
   - Test users: pridaj `dushi.mokry@gmail.com` a `dneuschl@monetplus.cz`
   - **Dôležité:** po dokončení choď späť na OAuth consent screen a klikni
     **"Publish App"** (prepni z "Testing" na "In production"). Bez tohto
     kroku Google zruší refresh token po 7 dňoch. Pri "In production" bez
     verifikácie uvidíš pri prihlásení varovanie "Google neoveril túto
     appku" — to je v poriadku, len klikni "Advanced → Go to Melichar
     (unsafe)".
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**,
   typ **Desktop app**. Dostaneš `Client ID` a `Client Secret` — to sú
   `GOOGLE_CLIENT_ID` a `GOOGLE_CLIENT_SECRET` (spoločné pre obe schránky).

### 2. Refresh token pre každú Gmail schránku (cez OAuth Playground)

Opakuj pre `dushi.mokry@gmail.com` aj `dneuschl@monetplus.cz` (prihlás sa v
prehliadači pod správnym účtom pred krokom 3):

1. Choď na https://developers.google.com/oauthplayground
2. Vpravo hore klikni na ozubené koliesko → zaškrtni **"Use your own OAuth
   credentials"** → vlož `Client ID` a `Client Secret` z kroku 1.
3. V ľavom paneli nájdi a zaškrtni **Gmail API v1 → `https://www.googleapis.com/auth/gmail.readonly`**,
   klikni **Authorize APIs**, prihlás sa pod danou schránkou, potvrď.
4. Klikni **Exchange authorization code for tokens**.
5. Skopíruj **Refresh token** — pre `dushi.mokry@gmail.com` to je
   `GMAIL_PERSONAL_REFRESH_TOKEN`, pre `dneuschl@monetplus.cz` to je
   `GMAIL_WORK_REFRESH_TOKEN`.

### 3. Azure app registration + refresh token pre Outlook

1. Choď na https://portal.azure.com → **Microsoft Entra ID → App
   registrations → New registration**.
2. Meno: napr. "Melichar". **Supported account types:** vyber "Personal
   Microsoft accounts only" (keďže outlook.cz je osobný účet).
3. **Redirect URI:** nepotrebné pre device code flow, môžeš nechať prázdne.
4. Po vytvorení skopíruj **Application (client) ID** — to je `MS_CLIENT_ID`.
5. **Authentication** → zapni "Allow public client flows" → Yes → Save.
6. **API permissions → Add a permission → Microsoft Graph → Delegated
   permissions** → pridaj `Mail.Read` a `offline_access`.
7. Lokálne spusti (z priečinka projektu):
   ```bash
   node scripts/setup/get-outlook-token.mjs <MS_CLIENT_ID>
   ```
   Skript ti vypíše odkaz + kód — otvor odkaz v prehliadači, zadaj kód,
   prihlás sa pod `neuschl.dusan@outlook.cz`. Skript potom vypíše refresh
   token — to je `OUTLOOK_REFRESH_TOKEN`.

### 4. Seznam IMAP heslo

1. Over, či má `reaminator@email.cz` zapnuté dvojfaktorové overenie. Ak áno,
   v nastaveniach účtu na seznam.cz/email.cz vytvor **aplikačné heslo**
   špeciálne pre IMAP prístup (nepoužívaj bežné prihlasovacie heslo).
2. `SEZNAM_IMAP_USER` = `reaminator@email.cz`, `SEZNAM_IMAP_PASSWORD` =
   toto heslo.

### 5. Anthropic API kľúč

1. Choď na https://console.anthropic.com → **API Keys → Create Key**.
2. To je `ANTHROPIC_API_KEY`. Pri pár emailoch denne ide o zanedbateľné
   náklady (model Claude Haiku, jedno volanie za beh).

### 6. Pridaj secrets do GitHub repa

V repe **Settings → Secrets and variables → Actions → New repository
secret**, pridaj všetkých 10:

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_PERSONAL_REFRESH_TOKEN`,
`GMAIL_WORK_REFRESH_TOKEN`, `MS_CLIENT_ID`, `OUTLOOK_REFRESH_TOKEN`,
`SEZNAM_IMAP_USER`, `SEZNAM_IMAP_PASSWORD`, `ANTHROPIC_API_KEY` — plus už
existujúce `TELEGRAM_BOT_TOKEN` a `TELEGRAM_CHAT_ID` (zdieľané s
weather-check).

### 7. Over funkčnosť

**Actions → Melichar - Email Digest → Run workflow.** Pri prvom behu pre
každú schránku sa len založí vodoznak (žiadny súhrn nepríde, aj keby si
mal 500 neprečítaných emailov — to je zámer). Pošli si potom testovací
email a spusti workflow znova — mal by sa objaviť v súhrne.
