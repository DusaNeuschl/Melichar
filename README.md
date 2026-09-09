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

> **Pozastavené:** automatický cron rozvrh je v
> [check-emails.yml](.github/workflows/check-emails.yml) vypnutý. Kód aj
> nastavenie zostávajú funkčné, dá sa spustiť manuálne cez
> **Actions → Melichar - Email Digest → Run workflow**, alebo znova zapnúť
> odkomentovaním `schedule` bloku vo workflow súbore.

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

### 1. Google Cloud projekt (spoločný pre Gmail aj kalendár)

> **Poznámka k novej konzole:** pôvodná jedna stránka *APIs & Services → OAuth
> consent screen* je dnes rozdelená do sekcie **Google Auth Platform** s
> položkami **Branding**, **Audience**, **Clients** a **Data access**. Postup
> nižšie používa nové názvy.

1. Choď na https://console.cloud.google.com, založ nový projekt.
2. **APIs & Services → Library** → povoľ **Gmail API** a **Google Calendar API**.
3. **Google Auth Platform → Branding** — vyplň tri povinné polia:
   - **App name**: `Melichar`
   - **User support email**: tvoj e-mail
   - **Developer contact information → Email addresses**: tvoj e-mail
   - logo, home page, privacy policy a authorised domains nechaj prázdne
   - klikni **Save** a počkaj na hlášku *"Branding changes saved."*

   **Pasca:** keď je **Save** sivé a polia sú pritom vyplnené, neznamená to
   „uložené" — môže ísť o predvyplnený formulár, ktorý na server nikdy
   neodišiel. Vynúť uloženie: klikni do **App name**, dopíš znak, zmaž ho →
   Save zmodrie → ulož. Kým Branding nie je reálne uložený, na stránke
   Audience svieti *"Your app's OAuth configuration is incomplete"* a
   **Publish app** je nedostupné.
4. **Google Auth Platform → Data access → Add or remove scopes** → pridaj
   `https://www.googleapis.com/auth/gmail.readonly` a
   `https://www.googleapis.com/auth/calendar.readonly`.
5. **Google Auth Platform → Audience**:
   - **User type**: External
   - **Publishing status** musí byť **In production**. Ak je tam „Testing",
     klikni **Publish app** → **Confirm**.
   - Žltý pruh *"Your app requires verification"*, ktorý sa objaví po
     publikovaní, **ignoruj**. Verifikácia rieši len varovanie „Google hasn't
     verified this app" pri prihlásení a limit 100 používateľov — na funkčnosť
     ani na životnosť tokenov nemá vplyv. Appku na review neposielaj a
     neklikaj **Back to testing**.

   **Prečo je "In production" povinné:** v režime Testing Google ruší refresh
   tokeny po 7 dňoch. Spoznáš to podľa poľa `refresh_token_expires_in: 604799`
   v odpovedi z Playgroundu — pri publikovanej appke toto pole v odpovedi
   vôbec nie je.
6. **Google Auth Platform → Clients → Create client**, typ **Web
   application**. Do **Authorised redirect URIs** pridaj
   `https://developers.google.com/oauthplayground` (presne takto, bez lomítka
   na konci). Dostaneš `Client ID` a `Client Secret` — to sú
   `GOOGLE_CLIENT_ID` a `GOOGLE_CLIENT_SECRET`, spoločné pre obe schránky aj
   pre kalendár.

   **Prečo Web application a nie Desktop app:** refresh tokeny sa tu berú cez
   OAuth Playground a ten sa autorizuje na svoju vlastnú redirect URI. Desktop
   app klient povoľuje len `localhost` a redirect URI sa mu nedá nastaviť, takže
   s Playgroundom nespolupracuje.

   **Client secret si hneď skopíruj** — konzola ho už druhýkrát nezobrazí, dá
   sa len pridať nový.

### 2. Refresh token pre každú Gmail schránku (cez OAuth Playground)

<a id="playground"></a>

Opakuj pre `dushi.mokry@gmail.com` aj `dneuschl@monetplus.cz` (prihlás sa v
prehliadači pod správnym účtom pred krokom 3):

1. Choď na https://developers.google.com/oauthplayground
2. Vpravo hore klikni na ozubené koliesko a nastav:
   - **Access type**: `Offline` — bez toho nedostaneš refresh token, len access
   - **Force prompt**: `Consent Screen` — vynúti vydanie nového tokenu
   - zaškrtni **"Use your own OAuth credentials"** → vlož `Client ID` a
     `Client Secret` z kroku 1
   - **Close**
3. V ľavom paneli nájdi a zaškrtni **Gmail API v1 → `https://www.googleapis.com/auth/gmail.readonly`**,
   klikni **Authorize APIs**, prihlás sa pod danou schránkou, potvrď
   (varovanie „Google hasn't verified this app" → **Advanced** → **Go to
   Melichar (unsafe)**).
4. **Než klikneš Exchange, skontroluj pravý panel.** V riadku `Location:`
   toho `302 Found` musí byť **tvoje** `client_id=...`. Ak je tam
   `client_id=407408718192.apps.googleusercontent.com`, je to vlastný klient
   Playgroundu — pozri pascu nižšie.
5. Klikni **Exchange authorization code for tokens**.
6. V odpovedi skontroluj, že **nie je** prítomné pole
   `refresh_token_expires_in`. Ak tam je, appka nie je publikovaná (krok 1, bod 5) a
   token by o 7 dní zomrel.
7. Skopíruj **`refresh_token`** (začína `1//`) — pre `dushi.mokry@gmail.com` to
   je `GMAIL_PERSONAL_REFRESH_TOKEN`, pre `dneuschl@monetplus.cz` to je
   `GMAIL_WORK_REFRESH_TOKEN`.

**Pasca — Playground si nastavenia neuchová.** Konfigurácia v ozubenom koliesku
žije len v aktuálnej session. Po reloade stránky (napr. keď medzitým odvoláš
prístup na myaccount.google.com) sa **"Use your own OAuth credentials" ticho
odškrtne** a Playground autorizuje pod svojím vlastným klientom
`407408718192`. Takto vydaný refresh token potom v Actions skončí na
`unauthorized_client`. Preto tá kontrola `client_id` v kroku 4 — trvá dve
sekundy a ušetrí celé kolo cez GitHub Actions.

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

V repe **Settings → Secrets and variables → Actions → New repository secret**.

**Schránky sa dajú zapínať postupne.** Skript preskočí každú schránku, ku
ktorej nie sú vyplnené secrets — nenahlási to ako chybu a beh zostane zelený.
Nemusíš teda mať naraz všetko; stačí začať jednou a ďalšie dopĺňať neskôr.

| Zdroj | Potrebné secrets |
|---|---|
| Gmail `dushi.mokry@gmail.com` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_PERSONAL_REFRESH_TOKEN` |
| Gmail `dneuschl@monetplus.cz` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_WORK_REFRESH_TOKEN` |
| Outlook `neuschl.dusan@outlook.cz` | `MS_CLIENT_ID`, `OUTLOOK_REFRESH_TOKEN` |
| Seznam `reaminator@email.cz` | `SEZNAM_IMAP_USER`, `SEZNAM_IMAP_PASSWORD` |

Navyše treba `ANTHROPIC_API_KEY` (triedenie emailov) a
`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` (odosielanie, zdieľané s
weather-checkom). Bez Anthropic kľúča príde súhrn ako holý zoznam predmetov
namiesto roztriedeného.

### 7. Over funkčnosť

Najprv lokálne — diagnostika otestuje každý zdroj samostatne, nič neodošle a
nič nezapíše do `email-state.json`:

```powershell
$env:GOOGLE_CLIENT_ID="..."
$env:GOOGLE_CLIENT_SECRET="..."
$env:GMAIL_PERSONAL_REFRESH_TOKEN="1//..."
# ...a ďalšie podľa toho, ktoré schránky zapínaš
node scripts/setup/diagnose-email.mjs
```

Vypíše tabuľku `OK` / `CHYBA` / `PRESKOČENÉ` pre všetky štyri schránky aj pre
Anthropic API. Pri Gmaile overí navyše, či token patrí správnemu klientovi
**aj správnej schránke** — chytí teda aj to, keď si sa v Playgrounde omylom
prihlásil pod druhým účtom.

Potom **Actions → Melichar - Email Digest → Run workflow.** Pri prvom behu pre
každú schránku sa len založí vodoznak (žiadny súhrn nepríde, aj keby si
mal 500 neprečítaných emailov — to je zámer). Pošli si potom testovací
email a spusti workflow znova — mal by sa objaviť v súhrne.

### 8. Zapni automatický rozvrh

V `.github/workflows/check-emails.yml` je `schedule` blok zakomentovaný.
Odkomentuj ho, až keď ti manuálny beh chodí správne.

### Ako sa skript správa pri výpadkoch

Štyri schránky sú štyri nezávislé externé systémy, takže každá beží izolovane:

- **nenakonfigurovaná** (chýbajúce secrets) → ticho preskočená, beh zelený
- **nakonfigurovaná, ale zlyhá** → ostatné schránky pokračujú, vodoznaky
  úspešných sa uložia, a na konci telegramovej správy pribudne sekcia
  `⚠️ Nedostupné zdroje` s dôvodom; beh skončí červený, aby to bolo vidieť aj
  v Actions
- **zlyhá triedenie cez Claude** → pošle sa aspoň holý zoznam predmetov

Preto má krok „Commit updated state" vo workflowe `if: always()` — bez toho by
sa pri čiastočnom zlyhaní vodoznaky nezacommitovali a správy úspešných schránok
by prišli pri ďalšom behu znova.

---

# Kalendár

Tretia funkcia Melichara: sleduje Google kalendár `dushi.mokry@gmail.com`
vrátane všetkých podkalendárov, ktoré vidí (`calendarList`, teda aj
zdieľané/prihlásené kalendáre).

- **Ranná agenda** (beh "07:00"): pošle prehľad dnešných udalostí zo
  všetkých kalendárov, aj keď je prázdny ("Dnes žiadne naplánované
  udalosti.")
- **Zmeny** (všetky 3 behy 07:00/12:00/16:00): cez Google Calendar sync
  token deteguje nové, zrušené, presunuté alebo premenované udalosti od
  posledného behu a pošle ich, len ak nejaké nastali
- Pri prvom behu pre každý kalendár sa len založí sync token (baseline) —
  existujúce udalosti sa nereportujú ako "zmeny"

Používa **rovnaký** Google Cloud OAuth klient (`GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET`) ako Gmail vyššie, len s novým refresh tokenom pre
scope Calendar.

## Nastavenie krok za krokom

### 1. Povoľ Calendar API a pridaj scope

1. V tom istom Google Cloud projekte ako pre Gmail (**APIs & Services →
   Library**) povoľ **Google Calendar API**.
2. **Google Auth Platform → Data access → Add or remove scopes** → pridaj
   `https://www.googleapis.com/auth/calendar.readonly`.
3. Over na **Google Auth Platform → Audience**, že **Publishing status** je
   **In production**. Ak je tam „Testing", refresh token vydrží len 7 dní —
   postup publikovania je v kroku 1 nastavenia Gmailu vyššie.

### 2. Refresh token pre kalendár (cez OAuth Playground)

Prihlás sa v prehliadači pod `dushi.mokry@gmail.com` a postupuj presne podľa
[kroku 2 pri Gmaile](#playground) vrátane oboch kontrol
(`client_id` v 302 redirecte a neprítomnosť `refresh_token_expires_in`), len
namiesto Gmail scope zaškrtni **Calendar API v3 →
`https://www.googleapis.com/auth/calendar.readonly`**.

Výsledný `refresh_token` je `GOOGLE_CALENDAR_REFRESH_TOKEN`.

Pred uložením do GitHub secretov si to over lokálne — ušetríš kolo cez Actions:

```powershell
$env:GOOGLE_CLIENT_ID="..."
$env:GOOGLE_CLIENT_SECRET="..."
$env:GOOGLE_CALENDAR_REFRESH_TOKEN="1//..."
node scripts/setup/diagnose-google-auth.mjs
```

Musí vypísať `OK — access token získaný` a `tokeninfo.aud` zhodné s tvojím
Client ID.

### 3. Pridaj secrets do GitHub repa

Pridaj `GOOGLE_CALENDAR_REFRESH_TOKEN` (Settings → Secrets and variables →
Actions). `GOOGLE_CLIENT_ID` a `GOOGLE_CLIENT_SECRET` už existujú z
nastavenia Gmailu, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` tiež.

### 4. Over funkčnosť

**Actions → Melichar - Calendar → Run workflow** (manuálny beh sa vždy
správa ako "morning", takže hneď pošle dnešnú agendu). Zmeny sa pri tomto
prvom behu ešte nereportujú (zakladá sa baseline) — over ich tak, že
niečo v kalendári zmeníš/pridáš a spustíš workflow znova.

### 5. Riešenie problémov s Google prihlásením

Keď workflow spadne na `Google token refresh failed`, spusti lokálne
diagnostiku — vypíše, ktorá z troch hodnôt je zlá, a nič nikam neposiela:

```powershell
$env:GOOGLE_CLIENT_ID="..."
$env:GOOGLE_CLIENT_SECRET="..."
$env:GOOGLE_CALENDAR_REFRESH_TOKEN="..."
node scripts/setup/diagnose-google-auth.mjs
```

(Pre Gmail token: `node scripts/setup/diagnose-google-auth.mjs GMAIL_PERSONAL_REFRESH_TOKEN`.)

Čo znamenajú jednotlivé chyby z Google:

| Chyba | Význam | Oprava |
|---|---|---|
| `unauthorized_client` | Client ID aj secret sú platné, ale refresh token bol vydaný **inému** OAuth klientovi | Vygeneruj refresh token znova a v Playgrounde maj zaškrtnuté "Use your own OAuth credentials" s tým istým Client ID/Secret, aké sú v GitHub secretoch |
| `invalid_client` | Klient neexistuje alebo nesedí secret | Skopíruj `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` znova z Google Auth Platform → Clients |
| `invalid_grant` | Token je zrušený alebo expirovaný | Google Auth Platform → Audience musí byť "In production" (v "Testing" platí token 7 dní); potom vygeneruj token znova |

Pri kopírovaní do GitHub secretov pozor na koncový newline a úvodzovky —
diagnostika oboje deteguje.

**Chyba sa zmenila = posun dopredu.** Tieto tri chyby sú tri rôzne problémy,
nie ten istý. Prechod z `unauthorized_client` na `invalid_grant` znamená, že
dvojica Client ID + Secret je už v poriadku a zostáva doriešiť samotný token.

**Keď zmažeš OAuth klienta**, prestanú platiť **všetky** refresh tokeny, ktoré
vydal — teda `GOOGLE_CALENDAR_REFRESH_TOKEN` aj oba Gmail tokeny. Treba
pregenerovať všetky, ktoré používaš.

**Stack trace prezradí, ktorá verzia kódu bežala.** Keď riadok v chybe
nesedí s aktuálnym `scripts/lib/google-auth.mjs`, pozeráš sa na starý beh z
času pred pushom, nie na aktuálny stav.
