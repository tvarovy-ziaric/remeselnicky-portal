# Remeselnícky portál — Design culture v1

## Positioning

Remeselnícky portál má pôsobiť ako moderný, dôveryhodný a ergonomický marketplace pre remeslá. Dizajn nemá pripomínať lacný inzertný web ani korporátny enterprise systém. Má spájať:

- poctivé remeslo,
- poriadok a dôveru,
- jednoduchosť orientácie,
- lokálnosť a ľudskosť.

## Core principles

1. **Jasný ďalší krok** — používateľ má vždy vidieť, čo má urobiť teraz.
2. **UI neukazuje databázové entity** — ukazuje prirodzený proces: Dopyt → Ponuky → Zákazka → Dokončenie → Hodnotenie.
3. **Dôvera je viditeľná** — verified, evidence-supported a self-declared údaje musia byť vizuálne odlíšené.
4. **Komplexita je pod kapotou** — pokročilá logika nesmie vytvárať pocit zložitého systému.
5. **Remeselná téma bez gýču** — decentné technické/ dielenské detaily, nie klišé stavebných webov.

## Visual direction

- Warm neutral backgrounds
- White cards with subtle borders and mild shadow
- Graphite text
- Forest green primary
- Terracotta accent
- Muted blue trust color
- Rounded corners 10–14 px
- Clean line icons
- Spacious layout and readable typography

## Primary user mental models

### Customer

Potrebujem niečo opraviť / postaviť → vyplním dopyt → vyberiem remeselníkov → porovnám ponuky → zvolím jednu → sledujem priebeh → potvrdím dokončenie → ohodnotím.

### Craftsman

Som remeselník → dostanem pozvánku → rozhodnem sa → pošlem ponuku → po prijatí riadim zákazku → nahrávam priebeh → dokončím → získam hodnotenie.

## Navigation architecture

### Public

- Remeselníci
- Ako to funguje
- Vytvoriť dopyt
- Prihlásiť sa

### Authenticated core

- Prehľad
- Dopyty
- Zákazky
- Správy
- Profil / Účet

## UI patterns

- Wizard for request creation
- Card-based search results with trust facts
- Profile tabs: Prehľad / Realizácie / Hodnotenia / Odbornosť
- Job cockpit with timeline and next best action
- Human-readable statuses, never raw state names
- Sticky CTA on mobile for primary action

## Trust language

- `✓ Overené platformou`
- `◐ Podporené dôkazmi`
- `○ Uvádza remeselník`

## Content tone

- Human, direct, practical, calm
- Avoid jargon and legalese in core flow
- Always explain consequence of the next action

## Accessibility & ergonomics

- Strong contrast
- Large tap targets
- Clear labels
- Status not conveyed by color alone
- Mobile-first spacing and progressive disclosure
