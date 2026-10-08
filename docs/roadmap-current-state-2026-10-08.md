# Remeselnícky portál — aktualizovaná vývojová roadmapa podľa kódu

**Dátum hodnotenia:** 2026-10-08  
**Zdroj:** GitHub `tvarovy-ziaric/remeselnicky-portal`, vetva `main`; posledný posúdený commit `7da4267cf5d7336c1eeffad7fbca31920c3a1fce`  
**Typ:** pracovná, nekanonická roadmapa / analytický overlay. Nenahrádza uzamknuté `ROADMAP.md` a `IMPLEMENTATION_BACKLOG.md`.  
**Stupnica:** IMPLEMENTOVANÉ V KÓDE ≠ AUTOMATIZOVANE OVERENÉ ≠ MANUÁLNE UAT ≠ PRODUKČNE SCHVÁLENÉ.

## 1. Východiská a metodika

Podkladom je aktuálna štruktúra monorepa (Next.js web, Fastify API, worker, zdieľané doménové balíky, PostgreSQL/PostGIS), zdrojové súbory, `docs/execution-checkpoint.md`, `docs/release/go-no-go-checklist.md`, existujúce testovacie cesty a posledné commity. Nevykonalo sa lokálne spustenie systému, živý prechod všetkých obrazoviek ani kompletný nezávislý test; priechodnosť celej používateľskej cesty preto zostáva predmetom UAT. Pôvodný checkpoint má dátum 2026-10-01; neskoršie commity dokumentujú spravovanú taxonómiu a celomestské vyhľadávanie.

## 2. Inventúra podľa modulu

| Oblasť | Implementačné dôkazy | Stav / chýbajúce overenie |
|---|---|---|
| Základ architektúry | `apps/web`, `apps/api`, `apps/worker`, packages, CI, PostGIS | Implementované; produkčná infraštruktúra musí splniť go/no-go |
| Registrácia, prihlásenie, rolové kontexty | auth, onboarding, `/ucet`, e-mail/telefón verifikácia | Implementované a synteticky testované; manuálne UAT a poskytovateľské nastavenia |
| Profil remeselníka | craftsman authoring/public profile, credential claims | Implementované; schvaľovanie dokladov cez skutočného admina s MFA čaká |
| Profesie a služby | spravovaný katalóg, návrhy, aliasy, admin taxonomy, migrácie 0117–0121 | Implementované; reálne admin UAT čaká na MFA |
| Geografia, PSČ a verejné hľadanie | autocomplete, search cards, mig. 0122, posledný commit s podporou celého mesta | Implementované; regresia a manuálna kontrola aktuálneho buildu |
| Portfólio a fotografie | craftsman portfolio/media/upload/review | Implementované; manuálne upload, oprávnenia a skutočné zariadenia overiť |
| Dopyt → shortlist → pozvánky | job request drafts, customer shortlist, invitations | Implementované; UAT na presnej revízii |
| Chat a cenové ponuky | conversations, quotes, comparison, acceptance | Implementované; UAT s reálnym UX a chybovými scenármi |
| Potvrdená zákazka | job lifecycle, contacts, dashboards | Implementované; viacnásobné kliknutia, výpadky a integrita |
| Priebeh, míľniky, zmenové listy | milestones, documentation, change orders, workgroups | Implementované; kompletný manuálny zákazkový priechod |
| Dokončenie a hodnotenia | completion, proposal, bilateral/context/supervisor reviews, response | Implementované s CI dôkazmi; potvrdiť manuálny end-to-end a súkromie |
| Administrácia a moderácia | admin console, reviews, cases, appeals, taxonomy, analytics | Kód existuje; privilegované vetvy blokuje skutočný MFA provider/enrollment |
| Notifikácie | notification center/outbox/worker | Implementované; externá prevádzka a failure injection |
| Súkromie a export dát | privacy cases, base JSON export a čiastkové executory | Čiastočne hotové; reálne právne, retenčné a recovery postupy nedokončené |
| Monitoring / zálohy | invariants, testy, lokálny restore | Lokálne skúšané; produkčný provider, alerting, incident owner a restore evidence chýbajú |
| Samostatný Android / iOS klient | Expo mobilný klient nebol v preskúmanom workspace potvrdený | PLÁNOVANÉ, neoznačovať za hotové |
| Feed, sledovanie a uložené realizácie | žiadny spoľahlivý dôkaz kompletného social produktu v preskúmanom rozsahu | Neskoršie rozšírenie, potrebný presný audit |
| Platené účty, escrow, cenové AI | nesúvisí s pripravenosťou alfy | Dlhodobý rozvoj, nie release blocker |

## 3. Bezprostredné blokery

1. **Reálne admin MFA:** schválený provider, administrátorské enrollment, testovanie oprávnení, expirácie a obnovy; bez obchádzania MFA.
2. **Manuálne UAT:** anonymný používateľ, zákazník, remeselník, admin; autentifikácia, dopyt, vyhľadanie, ponuka, potvrdenie, realizácia, dokončenie, hodnotenie, moderácia a dokumenty.
3. **Reálny staging a produkčná prevádzka:** tajomstvá, oddelenie prostredí, monitoring, alert receiver, incident owner, zálohovanie a obnova, objektové úložisko a e-mail/SMS integrácia.
4. **Právne a súkromie:** schválené účely, retenčné lehoty, export/mazanie zdieľaných údajov, reklamácie, podmienky, reálne registračné toky.
5. **Akceptácia vydania:** presný commit/release marker, nula otvorených BLOCKER/CRITICAL, schválená úvodná kohorta a podpísané go/no-go.

## 4. Roadmapa od 2026-10-08

### Fáza A — stavový audit a UAT príprava (1–2 týždne)
- Audit admina na aktuálnom builde; zapísať každý stav PASS/FAIL/NOT_EVALUATED.
- Spárovať posledný Git commit s prevádzkovým release identifikátorom.
- Overiť či existujúci checklist mapuje nové moduly taxonómie/lokality.
- Vytvoriť evidenciu blockerov (severity, vlastník, reprodukcia, kritérium opravy).
- Zafixovať scope uzavretej pilotnej verzie; nezavádzať teraz nové rozsiahle funkcie.
**Výstup:** reprodukovateľný audit; backlog opráv; release kandidát.

### Fáza B — bezpečná webová alfa / uzavretý pilot (2–6 týždňov po A; závisí od human gates)
- Odstránenie UX/funkčných regresií z manuálneho UAT.
- Dokončenie administrátorského MFA a skutočného schvaľovania.
- Provider-managed staging, skutočné notifikačné kanály, zálohy a monitoring.
- Vyjasniť prípustný rozsah reálnych údajov a schváliť privacy/legal minimum.
- Pilot s malým počtom pozvaných používateľov až po PASS na všetkých tvrdých gateoch.
**Výstup:** uzavretá alfa s reálnymi používateľmi (iba po formálnom GO).

### Fáza C — webová beta a produktová kvalita (4–8 týždňov po B)
- Opraviť problémy z pilotu a nástupný funnel.
- Dokončiť responzivitu, prístupnosť, vyhľadávanie, rýchlosť a SEO.
- Rozšíriť observabilitu, onboarding, moderáciu a podpůrné pracovné postupy.
- Pridať feed/uložené realizácie alebo dostupnosť iba podľa reálnych potrieb pilotu.
**Výstup:** stabilný a merateľný webový marketplace.

### Fáza D — Android a iOS mobilná aplikácia (6–10 týždňov nad stabilným API; môže sa čiastočne prekrývať s C)
- Expo/React Native shared client, autentifikácia, profil, realizácie, vyhľadávanie.
- Dopyty, chat, ponuky, zákazky, fotografie, notifikácie, deep links.
- Testy reálnych zariadení, oprávnení, distribúcia cez TestFlight / interné Android testovanie.
**Výstup:** mobilná beta; samostatné obchody až po splnení pravidiel a review.

### Fáza E — verejná V1 a rast (4–8 týždňov po webovej bete; závislé od výsledkov pilotu)
- Verejné uvedenie len s pripravenou prevádzkou, supportom a bezpečnostnými procesmi.
- Lokalizované vstupné stránky, analytika akvizície, regionálny seed kvality.
- Zlepšovanie reputácie a dokončených zákaziek bez predaja falošných odznakov.
**Výstup:** udržateľná V1 webu, prípadne mobilných klientov podľa pripravenosti.

### Fáza F — rozšírený pracovný ekosystém (ďalších 3–9+ mesiacov, variabilné)
- Sociálne funkcie, pracovné partie, subdodávky, firemné workflow.
- Pokročilé dokumenty, platené profesionálne nástroje, cenová analytika.
- AI asistované dopyty a ponuky po kvalitnom datasete.
- Platby/escrow, poistenie a integrované služby iba po právnej a obchodnej validácii.
**Výstup:** postupný produktový rast, nie predpoklad vstupu na trh.

## 5. Plán v poradí vykonania

1. **T1–T2:** Audit UI/admina, backendu a databázy, presný UAT report.
2. **T3–T4:** Opravy najkritickejších chýb, kontrola prístupov, MFA integrácia.
3. **T5–T8:** Staging, právne/prevádzkové podmienky, recovery a pilot, len po GO.
4. **T9–T12:** Zlepšenie webového UX, výkonu, stability a pilotných konverzií.
5. **T13–T16:** Webová beta; rast prvých regiónov podľa výsledkov.
6. **T13–T22 (paralelne podľa kapacity):** Expo Android/iOS.
7. **T17–T24+:** Verejná V1 po schválení, SEO, podpora a meranie.
8. **Neskôr:** Siete remeselníkov, social, firmy, platené nástroje, ceny, AI a fintech.

**Upozornenie:** Ide o odhady práce a závislostí, nie garantované termíny. Pri jednom vývojárovi paralelné mobilné práce môžu predĺžiť webový harmonogram. Externé schvaľovanie, MFA, právne rozhodnutia a provider infra môžu byť kritickou cestou bez pevného konca.

## 6. Prvý konkrétny sprint

- [ ] Spustiť presnú súpravu `pnpm check` na pracovnej revízii a zaznamenať CI výsledok.
- [ ] Overiť `/admin` a admin moduly s korektným MFA; bez providera označiť NOT_EVALUATED.
- [ ] Prejsť registrovaného zákazníka od `/dopyt` k porovnaniu ponúk.
- [ ] Prejsť remeselníka od registrácie cez profesie, služby a portfólio po prijatie zákazky.
- [ ] Otestovať PSČ/obce/celomestské vyhľadávanie, bez diakritiky a limity návrhov.
- [ ] Prejsť Quote → Accepted Job → Change → Completion → Review s auditom.
- [ ] Overiť upload súkromných a verejných médií, prístupové hranice a chyby.
- [ ] Spísať výsledky ako PASS/FAIL/NOT_EVALUATED + URL/screenshot/commit/tester.
- [ ] Roztriediť nálezy a aktualizovať release no-go checklist.

## 7. Kľúčové rozhodnutie

**Priorita nie je doprogramovať ďalších desať modulov. Priorita je dokázať, že existujúce jadro funguje bezpečne pre zákazníka aj remeselníka, a až potom pozývať reálnych používateľov.**

## Referencie

- `README.md`, `package.json`, `apps/api/src/index.ts`
- `docs/execution-checkpoint.md`
- `docs/release/go-no-go-checklist.md`
- `docs/release/manual-uat.md`
- GitHub commits `7da4267` (celomestské vyhľadávanie), `e533744` (draft taxonomy), `f2f64c2` (spravovaná taxonómia), `d5927c0` (navigácia používateľa).
