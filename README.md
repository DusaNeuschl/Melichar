# Melichar

Sleduje predpoveď počasia pre Oznice 158 (lat 49.4376699, lon 17.9046572) a cez
Telegram hlási, kedy treba vyletnené avokádo v kvetináči presťahovať dnu — a na
jar, kedy ho môžeš vrátiť von.

- **Kontroly:** 3x denne (~07:00 / 12:00 / 16:00 Europe/Prague, cron beží v UTC
  takže s DST môže reálny čas skĺznuť o +-1h; tu to nevadí, rozhodnutie sa týka
  nadchádzajúcej noci a stačí, aby jeden beh prešiel pred večerom)
- **Zdroj počasia:** Open-Meteo (zdarma, bez API kľúča) — **hodinové** dáta
  (`temperature_2m`, `cloud_cover`, `wind_speed_10m`)
- **Notifikácia:** Telegram Bot API (`sendMessage`) — zdarma, self-service, žiadne
  schvaľovanie ani 24h okno (na rozdiel od WhatsApp/Viber, kde je proaktívne
  posielanie správ mimo session okna zablokované/spoplatnené schválenými šablónami)
- **Príkazy:** Telegram webhook → Cloudflare Worker, odpoveď do sekundy
  (viď „Prepínanie cez Telegram")
- **Stav** (`state.json`) sa po každom behu commitne späť do repa

## Kedy sa alarm aktivuje

### Noc je okno 18:00 → 09:00, nie kalendárny deň

Pôvodná verzia čítala `temperature_2m_min`, čo je minimum **kalendárneho dňa** —
a to nastáva nadránom, teda patrí k noci, ktorá **už prebehla**. Večerná
pripomienka tak hlásila teplotu z dnešného rána namiesto nadchádzajúcej noci.
Teraz sa z hodinových dát skladá skutočné nočné okno 18:00 → 09:00 a noc sa
označuje dátumom rána, ktorým končí.

### Radiačné ochladenie

Predpoveď udáva teplotu vzduchu v 2 m v tieni. Za **jasnej bezvetrej noci**
vyžaruje list teplo do oblohy a býva o niekoľko stupňov chladnejší; kvetináč
navyše nemá tepelnú zotrvačnosť záhonu. Preto keď je priemerná nočná oblačnosť
pod `CLEAR_CLOUD_PCT` (30 %) a vietor pod `CALM_WIND_KMH` (10 km/h), odpočíta sa
od teploty `RADIATIVE_PENALTY_C` (3 °C) a rozhoduje sa podľa tohto odhadu teploty
na liste. Správa to vždy vypíše, nech je vidieť, prečo alarm padol pri 7,5 °C.

### Prahy

Vychádzajú z toho, ako avokádo reálne znáša chlad — ide o semenáčik v kvetináči,
vyletnený z bytu, teda mladý a neotužený:

| prah | čo sa stane | čo hrozí rastline |
|---|---|---|
| `BRING_IN_C` = 5 °C | „Prines avokádo dnu" + stav sa prepne na *dnu* | pásmo *chilling injury* (4–10 °C) — pri dlhšej expozícii sa poškodzujú listy |
| `URGENT_C` = 2 °C | „Ak je ešte vonku, musí dnu" | pri radiačnom ochladení už reálne hrozí mráz na liste |
| `FREEZE_C` = 0 °C | „Mrzne, neprežije to bez poškodenia" | spálené listy, odumieranie výhonov |
| `PUT_OUT_C` = 8 °C | po `PUT_OUT_RUN_NIGHTS` (7) nociach nad týmto prahom: „môžeš dať von" | — |

Medzi „prines dnu" (5 °C) a „môžeš dať von" (8 °C) je zámerne 3 °C hysterézia,
aby sa avokádo nehojdalo tam a späť okolo jednej hranice.

Pod ~10 °C avokádo len zastaví rast a ide do dormancie — to mu **neškodí**, preto
pôvodný prah 10 °C nebol o poškodení. V Oznici navyše padne pod 10 °C **249 nocí
za rok** (68 % roka, prvá už začiatkom augusta), takže z alarmu bol šum.

### Sezónny stav namiesto nočného spamu

Melichar si v `state.json` drží, či je avokádo podľa neho `outside` alebo
`inside`, a každý prah ohlási **najviac raz za sezónu** (`alertedBelow`):

```
ochladenie  prvá noc s odhadom na liste <= 5 °C
            -> "prines dnu", stav = inside, potom ticho
eskalácia   keď neskôr padne pod 2 °C a pod 0 °C, príde ešte jedno varovanie
            pre prípad, že si prvú správu prehliadol
oteplenie   7 nocí po sebe nad 8 °C (a aspoň 3 dni vnútri)
            -> "môžeš dať von", stav = outside, milníky sa vynulujú
```

Vyjde z toho **cca 6 správ za rok** namiesto 249.

### Prečo „môžeš dať von" nie je viazané na jar

Pôvodne sa táto správa posielala len v apríli až júni — ako poistka proti
februárovému oteplenu. Backtest na štyroch rokoch skutočných dát ale ukázal, že
to robí horšiu chybu, než akej bráni: **25. 7. 2023** stačila jedna chladná jasná
noc (7,6 °C, na liste 4,6) na „prines dnu" — a keďže „von" smelo len na jar,
avokádo by podľa Melichara zostalo vnútri až do **27. 4. 2024**. Deväť mesiacov
kvôli jednej júlovej noci.

Bez mesačnej hranice príde 11. 8. 2023 „môžeš dať von" a zvyšok leta je vonku.
Cena je +0,8 správy za rok (5,0 → 5,8). Februárové oteplenie riziko nie je:
požiadavka na **7 nocí po sebe nad 8 °C na liste** v Oznici v zime nepadne ani
raz za štyri roky.

`PUT_OUT_COOLDOWN_DAYS` (3) bráni tomu, aby sa čerstvo schované avokádo hneď
ponúkalo späť von. Väčšiu hodnotu netreba — meranie ukázalo, že proti hojdaniu
stačí už samotná požiadavka na 7 nocí po sebe (cooldown 0 vs 10 dní dáva 6,3 vs
5,8 správy ročne).

Rozhoduje sa z okna **najbližších dvoch nocí** — dosť na to, aby správa prišla
včas, a málo na to, aby sa hlásilo ochladenie, ktoré je 5 dní ďaleko a ešte sa
zmení.

## Prepínanie cez Telegram

Kde je avokádo, rozhoduješ ty — správou botovi. Melichar si na začiatku každého
behu vyzdvihne, čo mu medzitým prišlo (`getUpdates`), a odpovie:

| správa | čo spraví |
|---|---|
| `/dnu` | avokádo je vnútri → mlčí, kým sa neoteplí (označí všetky prahy chladu za vybavené) |
| `/von` | avokádo je vonku → vynuluje prahy a zase varuje pred chladom |
| `/stav` | povie, kde avokádo vedie a odkedy, plus prehľad nadchádzajúcich nocí |
| `/help` | zoznam príkazov |

Lomka je voliteľná, na veľkých písmenách ani diakritike nezáleží a rozumie aj
synonymám (`schoval`, `vnútri`, `vytiahol`, `vonku`…). Na nezrozumiteľnú správu
odpovie nápovedou.

**Odpoveď príde do sekundy.** Telegram volá Cloudflare Worker
([worker/index.mjs](worker/index.mjs)) priamo, ten overí, odpovie a zvyšok
nechá na GitHub Actions:

```
Telegram -> Cloudflare Worker -> odpoveď (< 1 s)
                  |
                  +-> repository_dispatch -> Actions zapíše state.json
```

Vyhodnocovanie alarmov zostáva **3× denne** v [check-weather.mjs](scripts/check-weather.mjs)
— Worker rieši len príkazy.

Worker nemá vlastné úložisko: aktuálny stav si prečíta z repa cez GitHub API
(nie cez `raw.githubusercontent`, ktoré je za CDN cache a vracalo by stav starý
aj niekoľko minút, takže `/stav` by klamal hneď po `/dnu`). Zmenu nezapisuje sám
— pošle `repository_dispatch` a zápis spraví
[handle-command.yml](.github/workflows/handle-command.yml). Odpoveď teda odíde
hneď, commit dobehne do minúty.

Rozhodovacia logika (prahy, synonymá príkazov, skladanie nocí) je v
[scripts/lib/avocado.mjs](scripts/lib/avocado.mjs), ktorý používa Worker aj Node
beh. Je to zámerné: keby mal každý svoju kópiu, nové synonymum alebo zmenený
prah by sa musel dopĺňať dvakrát.

Tri bezpečnostné poistky:

- `setWebhook` sa volá so `secret_token`, Telegram ho posiela v hlavičke
  `X-Telegram-Bot-Api-Secret-Token`. Bez nej by endpoint mohol volať ktokoľvek,
  kto uhádne URL — Worker takú požiadavku odmietne s 403.
- Príkazy sa berú **len z chatu v `TELEGRAM_CHAT_ID`**.
- Worker vracia Telegramu 200 aj keď spracovanie na pozadí zlyhá. Telegram
  opakuje doručenie, kým nedostane 200, takže inak by sa jeden príkaz posielal
  donekonečna.

`/help` odpovie bez jediného sieťového volania — nepotrebuje ani stav, ani
predpoveď. A `/stav` či opakované `/dnu` nespúšťajú workflow, keď sa stav
nemení.

### Keď webhook nebeží

Kým webhook nie je nastavený, príkazy vyzdvihuje záložný `getUpdates` priamo v
`check-weather.mjs` — teda 3× denne, s odozvou v hodinách. Po nasadení webhooku
začne `getUpdates` vracať HTTP 409; skript to očakáva, zaznamená to a pokračuje
ďalej. Prepínať sa dá kedykoľvek:

```
node scripts/setup/set-telegram-webhook.mjs          # ukáže aktuálny stav
node scripts/setup/set-telegram-webhook.mjs delete   # späť na polling
```

Na token sa skript opýta sám, takže nezáleží na tom, či si v PowerShelli,
cmd alebo bashi — a nedostane sa ani do histórie príkazov.

### Nasadenie Workera

1. Založ si účet na [Cloudflare](https://dash.cloudflare.com) (free tier stačí)
   a nainštaluj `npm install -g wrangler`, potom `wrangler login`.
2. Vyrob si GitHub token, ktorý smie spúšťať `repository_dispatch` — jemne
   zrnený token na repo `Melichar` s právom **Contents: Read and write**.
3. Vymysli si ľubovoľné dlhé náhodné tajomstvo pre webhook
   (`openssl rand -hex 32`).
4. Nastav tajomstvá a nasaď. Chat ID je tiež medzi nimi zámerne — repo je
   verejné, takže do `wrangler.toml` nepatrí:

   ```bash
   cd worker
   wrangler secret put TELEGRAM_BOT_TOKEN
   wrangler secret put TELEGRAM_CHAT_ID
   wrangler secret put TELEGRAM_WEBHOOK_SECRET
   wrangler secret put GITHUB_TOKEN
   wrangler deploy
   ```

   `wrangler deploy` vypíše URL v tvare `https://melichar.<účet>.workers.dev`.
   Pri prvom nasadení si vyžiada registráciu `workers.dev` subdomény — potvrď,
   je zadarmo a je celoúčtová aj trvalá, tak si vyber niečo neutrálne.
5. Nasmeruj naň Telegram. Skript si vypýta token, URL aj tajomstvo sám:

   ```
   cd ..
   node scripts/setup/set-telegram-webhook.mjs set
   ```
6. Napíš botovi `/stav`. Odpoveď má prísť do sekundy. Keď nepríde, pozri
   `node scripts/setup/set-telegram-webhook.mjs` (vypíše poslednú chybu od
   Telegramu) a `wrangler tail`.

## Architektúra

Vyhodnocovanie počasia beží v jednom kroku na GitHub Actions cron — na
posielanie správ Telegram nič bežiace nevyžaduje. Druhý komponent pribudol až
kvôli okamžitým odpovediam na príkazy: GitHub Actions cron sa pri záťaži odkladá
aj o hodiny (viď nižšie), takže „odpovedz hneď" sa cez neho spraviť nedá.
Cloudflare Worker je preto zámerne úzky — rieši len príkazy, nie alarmy.

```
Cloudflare Worker (nonstop, na webhook)
  -> /dnu /von /stav /help -> odpoveď do sekundy
  -> repository_dispatch -> Actions zapíšu state.json

GitHub Actions (cron 3x/deň)
  -> Open-Meteo hodinová predpoveď (Oznice)
  -> poskladá noci 18:00->09:00 + odhad teploty na liste
  -> porovná s prahmi a sezónnym stavom v state.json
  -> Telegram sendMessage
  -> commitne aktualizovaný state.json
```

### Dlhé správy

Telegram odmietne správu dlhšiu ako 4096 znakov a skript by spadol až po tom, čo
časť práce spravil. [scripts/lib/telegram.mjs](scripts/lib/telegram.mjs) preto
dlhé správy delí po riadkoch na viac kusov (`(1/3)`, `(2/3)`…). Používajú ho
všetky tri Node skripty.

### Zápis stavu a spoľahlivosť cronu

Všetky workflowy commitujú svoj stav cez spoločný
[.github/commit-state.sh](.github/commit-state.sh). Holý `git push` tam
nestačí: workflowy píšu do toho istého repa a keď sa dva behy prekryjú, druhému
pushu zlyhá non-fast-forward — job spadne **až po odoslaní správy**, takže sa
stratí len zápis stavu a pri ďalšom behu príde tá istá správa znova. (Presne to
sa stalo 13. 9. 2026 rannej agende.) Skript pri kolízii prerebasuje stav na
aktuálny `main` a push zopakuje, až 5×.

**Cron nie je presný.** GitHub sám dokumentuje, že naplánované behy sa pri
záťaži odkladajú a najhorší okamih je začiatok každej hodiny. Na tomto repe boli
pozorované odklady **2,5–4,5 hodiny**, takže minúty sú zámerne rozhodené mimo
`:00` a navzájom sa nekryjú:

| workflow | minúta | hodiny (UTC) |
|---|---|---|
| počasie | `:07` | 6, 11, 15 |
| kalendár | `:23` | 5, 6, 7, 11, 15 — záloha; agendu spúšťa Worker o 07:00 |
| emaily | — | len ranný signál z Workera o 07:00 |

`handle-command.yml` cron nemá — spúšťa ho Worker udalosťou
`repository_dispatch`, takže odklady sa ho netýkajú. S `check-weather.yml` zdieľa
`concurrency: melichar-state`, aby si dva zápisy do `state.json` neprepísali
navzájom.

Ranné sloty kalendára sú tri, aby mala denná agenda viac pokusov trafiť sa čo
najbližšie k 07:00 — pošle ju ten beh, ktorý sa reálne vykoná ako prvý po
siedmej. **Presný čas ale GitHub Actions zaručiť nevie**; keď bude treba mať
agendu naozaj o 07:00, je nutný vlastný scheduler (VPS cron podľa sekcie nižšie,
alebo externý trigger na `workflow_dispatch`).


## Nastavenie krok za krokom

### 1. Vytvor Telegram bota

1. V Telegrame nájdi **@BotFather** a napíš mu `/newbot`.
2. Zadaj meno bota (napr. "Melichar") a username (musí končiť na `bot`,
   napr. `melichar_avocado_bot`).
3. BotFather ti pošle **API token** — skopíruj si ho (vyzerá ako
   `123456789:ABCdefGhIJKlmNoPQRstuVwxYZ`).

### 2. Zisti svoje chat ID

1. Vo Telegrame si napíš svojmu novému botovi ľubovoľnú správu (napr. "ahoj").
2. Spusti (token ako argument — funguje rovnako v PowerShelli, cmd aj bashi):

   ```
   node scripts/setup/show-telegram-chat-id.mjs 123456789:AAHdq...
   ```

   Vypíše `TELEGRAM_CHAT_ID` aj s menom chatu. (Ručne sa to dá aj z
   `https://api.telegram.org/bot<TOKEN>/getUpdates`, kde je to v
   `"message":{"chat":{"id": ...}}`.)

Rovnaký skript použi, keď chat ID potrebuješ **znova** — GitHub secrets sa
spätne prečítať nedajú. Ak už beží webhook, `getUpdates` vracia 409; vtedy ho
dočasne zruš cez `set-telegram-webhook.mjs delete`, zisti ID a nastav späť.

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

## Zmena prahov alebo súradníc

Všetky prahy majú v [scripts/check-weather.mjs](scripts/check-weather.mjs)
predvolenú hodnotu a dajú sa prebiť env premennou vo workflow súbore, bez
zásahu do kódu:

| premenná | default | význam |
|---|---|---|
| `BRING_IN_C` | 5 | jesenné „prines dnu" |
| `URGENT_C` | 2 | naliehavé varovanie |
| `FREEZE_C` | 0 | mráz |
| `PUT_OUT_C` | 8 | jarné „môžeš dať von" |
| `PUT_OUT_RUN_NIGHTS` | 7 | koľko teplých nocí po sebe treba na návrat von |
| `PUT_OUT_COOLDOWN_DAYS` | 3 | koľko dní musí avokádo zostať vnútri, než sa ponúkne von |
| `PUT_OUT_MIN_MONTH` / `PUT_OUT_MAX_MONTH` | 1 / 12 | mesiace, v ktorých sa „môžeš dať von" vôbec zvažuje |
| `CLEAR_CLOUD_PCT` | 30 | hranica „jasno" (priemer za noc, %) |
| `CALM_WIND_KMH` | 10 | hranica „bezvetrie" (priemer za noc, km/h) |
| `RADIATIVE_PENALTY_C` | 3 | o koľko je list chladnejší za jasnej bezvetrej noci |

Súradnice sú cez env `LATITUDE`/`LONGITUDE` vo workflow súbore.

**Reset sezónneho stavu:** keď chceš Melicharovi povedať, že avokádo je zase
vonku (alebo dnu), uprav v `state.json` blok `avocado`:

```json
{ "avocado": { "location": "outside", "since": "2027-05-12", "alertedBelow": [] } }
```

`alertedBelow` je zoznam už ohlásených prahov v aktuálnej sezóne — vyprázdni ho,
ak chceš varovania dostať znova. Bežne to ale netreba: na prepínanie slúžia
správy `/dnu` a `/von` (viď „Prepínanie cez Telegram"), ručný zásah do súboru je
až núdzová cesta.

`telegram.lastUpdateId` je značka poslednej prevzatej správy z Telegramu.
Zmazaním sa Melichar pokúsi znova načítať všetko, čo Telegram ešte drží (24 h).

---

# Emailový súhrn

> **Raz denne o 07:00** spolu s agendou kalendára — spúšťa ho ten istý ranný
> signál z Cloudflare Workera. Pôvodný rozvrh 3× denne je v
> [check-emails.yml](.github/workflows/check-emails.yml) stále zakomentovaný.
> Súhrn príde aj v deň bez nových e-mailov („žiadne nové emaily"), aby sa ticho
> nedalo zameniť s nespusteným behom.

Druhá funkcia Melichara: každé ráno skontroluje 4
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

- **Ranná agenda:** každé ráno o **07:00 Europe/Prague** (celoročne, letný aj
  zimný čas) pošle prehľad dnešných udalostí zo všetkých kalendárov — aj keď
  je deň prázdny („Dnes žiadne naplánované udalosti.")
- **Zmeny** (všetky behy, cca 07:00/08:00/13:00/17:00 letného času): cez
  Google Calendar sync token deteguje nové, zrušené, presunuté alebo
  premenované udalosti od posledného behu a pošle ich, len ak nejaké nastali
- Pri prvom behu pre každý kalendár sa len založí sync token (baseline) —
  existujúce udalosti sa nereportujú ako "zmeny"

### Ako je zaručené 07:00 celoročne

GitHub Actions cron na tomto repe **meškal aj o 5 hodín** (16. 9. 2026 prišla
agenda o 12:04), takže ako budík nefunguje. Presný čas preto drží **Cloudflare
Worker**: jeho cron ide na sekundy a o 07:00 len „zaklope" na GitHub udalosťou
`repository_dispatch: melichar-morning`. Na tú štartujú okamžite oba ranné
workflowy — kalendár aj e-maily.

```
Cloudflare cron 05:00 a 06:00 UTC
  -> Worker: je v Prahe práve 7:00? (leto 05:00 UTC, zima 06:00 UTC)
  -> áno: repository_dispatch melichar-morning
       -> check-calendar.yml  (agenda)
       -> check-emails.yml    (súhrn e-mailov)
```

Cloudflare cron beží v UTC, ktoré neposúva letný čas, preto sú časy dva a Worker
pustí ďalej len ten, pri ktorom je v Prahe 7 hodín. Overené na každom dni roka
2026 vrátane dní prechodu času: práve jeden štart denne.

GitHub crony kalendára (`:23` o 5, 6, 7, 11 a 15 UTC) zostávajú ako **záloha a
kontrola zmien** cez deň. Keby ranný signál nedorazil, agendu pošle prvý z nich
po 07:00. Dvakrát za deň nepríde — skript si drží `lastAgendaDate` a workflow
má `concurrency`, aby sa ranný signál a záloha nepredbehli pri čítaní stavu.

Zápis stavu beží **aj keď skript spadne** (`if: always()`). Agenda sa totiž
odosiela ako prvá a `lastAgendaDate` sa ukladá hneď po nej; keby sa pri páde
neskoršej detekcie zmien neuložil, každý ďalší beh v ten deň by agendu poslal
znova.

Manuálny beh (**Run workflow**) agendu pošle vždy a `lastAgendaDate` nemení —
testovanie ti tak nezoberie skutočnú rannú správu.

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
