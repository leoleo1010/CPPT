# Planning Tesi

**Titolo provvisorio:** Framework IaC per il riuso di componenti in un Cyber Range (LXrange)
**Contesto:** Tesi magistrale in Cybersecurity svolta durante lo stage aziendale
**Inizio:** 21 settembre 2026
**Consegna / sessione di laurea:** da definire

---

## Stato attuale — checkpoint 13/10/2026

Il modello concettuale è stato ridefinito su CPPT: i concetti sono le 12 figure professionali ECSF, i laboratori sono gli stage CPPT (livello = tier), le esercitazioni verticali sono i percorsi di carriera nativi, quelle trasversali sono i percorsi generati da Profession Custom. La catena dei concetti è stata aggiornata di conseguenza (4 famiglie per colore, nessun ordine sequenziale obbligato). Fase 1 è sostanzialmente conclusa (resta solo "Altro da definire").

Il motore di Profession Custom — matching e ragionamento (via Claude) per affinità professionale e sequenziamento in tier — è **già implementato e verificato**, inclusi casi di studio su figure custom e su una job description reale (Leonardo S.p.A., Junior Cyber Security Engineer).

Resta da fare: formalizzare "Componente" (golden image/VM) nel modello, e scegliere la scala del case study da ricostruire con IaC reale.

Documenti di riferimento:
- `modello_concettuale_laboratori.pdf` — bozza per il tutor (definizioni, criterio, grafo, Recon)
- `grafo_concetti_recon_espanso.drawio` — grafo esteso editabile, con Recon espanso in VM Red/Blue/Target
- `Planning_Tesi.md` — questo file

---

## Struttura dei capitoli

| Capitolo | Titolo |
|---|---|
| — | Introduzione |
| 1 | Stato dell'arte |
| 2 | Cyber Range e LXrange |
| 3 | Modello proposto |
| 4 | Implementazione del framework |
| 5 | Composizione dello scenario e testing dei case study |
| — | Conclusioni |

---

## Modello concettuale (definito)

- **Concetto**: una delle 12 figure professionali definite dal framework ufficiale ENISA ECSF (European Cybersecurity Skills Framework, settembre 2022). Ogni concetto raccoglie l'insieme di laboratori (stage) associati a quella figura.
- **Laboratorio (building block)**: uno stage CPPT (lab VM o tabletop) — "building block" e "laboratorio" sono lo stesso concetto. Comprende una o più VM, non vincolate a un numero fisso. Ogni VM è un'istanza di una componente (golden image); la stessa golden image può generare più istanze anche all'interno dello stesso laboratorio, ciascuna con una configurazione diversa. Il **livello** è dato dal **tier** della figura professionale a cui lo stage appartiene (es. Associate → Engineer → Principal), la progressione di seniority ufficiale del ruolo. Ogni laboratorio è ancorato a un sottoinsieme reale di task, skill e knowledge della figura, più uno scenario e, nei lab VM, flag di verifica.
- **Componente (golden image)**: template VM riutilizzabile. Una stessa componente può essere istanziata più volte — anche nello stesso laboratorio — personalizzata ogni volta tramite file di configurazione.
- **Esercitazione**: unione di una serie di argomenti, tecniche, skill, competenze (e altro) trattati in più laboratori, composta in un'unica cosa.
  - **Verticale**: sulla stessa figura professionale, tier crescente — il percorso di carriera nativo della figura.
  - **Trasversale**: tocca laboratori di figure professionali diverse, composta per affinità professionale — il percorso generato da Profession Custom: a partire da una selezione di task/skill/knowledge/competenze e-CF/seniority (anche da una job description reale), il framework calcola l'affinità con le 12 figure e genera una sequenza di laboratori dal fondamentale all'avanzato.
- **Criterio dei concetti**: ancorato allo standard ufficiale ENISA ECSF — i 12 concetti sono le 12 figure standardizzate, con task/skill/knowledge/competenze e-CF derivati dal documento ufficiale.

### Catena dei concetti (ridefinita su CPPT)

I 12 concetti sono raggruppati in **4 famiglie da 3**, così come già organizzate nella mappa di CPPT (colore = famiglia):

- **Famiglia blu**: Chief Information Security Officer (CISO) · Cyber Legal, Policy & Compliance Officer · Cybersecurity Implementer
- **Famiglia rossa**: Cyber Incident Responder · Cybersecurity Risk Manager · Penetration Tester
- **Famiglia ambra**: Cyber Threat Intelligence Specialist · Cybersecurity Auditor · Digital Forensics Investigator
- **Famiglia verde**: Cybersecurity Architect · Cybersecurity Educator · Cybersecurity Researcher

A differenza del vecchio modello attack-path, qui non c'è un ordine sequenziale obbligato tra i concetti (nessun concetto è "input" di un altro): la composizione delle esercitazioni trasversali non segue una catena fissa, ma l'affinità professionale calcolata da Profession Custom.

---

## Fasi

### Fase 1 – Definizione ed espansione dei concetti *(priorità massima, prerequisito del modello – cap. 3)*

- [x] Definizioni di concetto, laboratorio, esercitazione
- [x] Struttura del laboratorio: ripresa dalla struttura reale di CPPT — ogni laboratorio (stage) ha un tipo (lab VM o tabletop), appartiene a un tier della figura, ha un titolo e uno scenario narrativo, è ancorato a un sottoinsieme reale di task/skill/knowledge della figura (tramite indici locali), e nei lab VM porta anche flag di verifica, difficoltà e durata stimata.
- [x] Criterio di scelta dei concetti: ancorato allo standard ufficiale ENISA ECSF (settembre 2022) — i 12 concetti sono le 12 figure professionali lì definite, non una suddivisione auto-inventata.
- [x] Grafo dei concetti esteso (catena completa + trasversali), ovvero i grafi fatti nella directory `src` di CPPT (i 12 ruoli con i loro tier/stage, così come codificati in `ROLES`/`PATHS`)
- [ ] Altro da definire

### Fase 2 – Introduzione *(bozza ora, versione finale a fine lavoro)*

- [ ] Contesto e motivazioni
- [ ] Obiettivi della tesi
- [ ] Panoramica del lavoro svolto e del contributo
- [ ] Struttura della tesi

### Fase 3 – Stato dell'arte *(cap. 1, può procedere in parallelo)*

- [ ] Cyber Range
- [ ] Infrastructure as Code
- [ ] Digital Twin
- [ ] Scenario Engineering
- [ ] Riuso di componenti software
- [ ] Analisi dei problemi di LXrange: asset duplicati, immagini obsolete, deployment non uniformi, difficoltà di manutenzione, assenza di metadati e parametrizzazioni

### Fase 4 – Cyber Range e LXrange *(cap. 2)*

- [ ] Cosa sono i Cyber Range in generale (breve)
- [ ] Introduzione verticale a LXrange
- [ ] Contributo personale a LXrange

### Fase 5 – Modello proposto *(cap. 3)*

- [x] Modello del laboratorio: concetti associati, livello, metadati, parametri — definito (vedi Modello concettuale)
- [x] Modello dell'esercitazione: composizione verticale e trasversale — definito (vedi Modello concettuale)
- [x] Criterio di composizione per figura professionale: affinità calcolata da Profession Custom (task/skill/knowledge/competenze e-CF/seniority, anche da una job description reale) — definito e già implementato
- [ ] Studio del framework IaC per il riuso dei componenti (golden image/VM) — ancora da fare

### Fase 6 – Implementazione del framework *(cap. 4)*

- [x] Implementazione del motore Profession Custom: pool deduplicati di task/skill/knowledge/competenze, scoring di affinità, ragionamento Claude per affinità e sequenziamento in tier — già costruito e verificato
- [ ] Studio degli scenari critici: topologia di rete, tool di attacco e difesa
- [ ] Costruzione dei building block (golden image/VM)
- [ ] Automazione delle configurazioni

### Fase 7 – Composizione e testing dei case study *(cap. 5)*

- [x] Case study sulle 12 figure CPPT: percorsi verticali (carriera nativa) e trasversali (Profession Custom) generati e verificati dal vivo
- [x] Case study di validazione esterna: job description reale (Leonardo S.p.A., Junior Cyber Security Engineer) mappata sul framework — risultato 95% Cybersecurity Implementer
- [ ] Costruzione e deployment dello scenario (golden image reali)
- [ ] Testing dello scenario e delle tecniche coperte dai laboratori
- [ ] Testing di difesa e hardening

### Fase 8 – Scrittura finale e consegna

- [ ] Conclusioni
- [ ] Versione finale dell'introduzione
- [ ] Abstract
- [ ] Revisione con tutor e relatore
- [ ] Consegna

---

## Timeline

| Fase | Periodo | Stato |
|---|---|---|
| 1 – Definizione ed espansione dei concetti | da definire | In corso |
| 2 – Introduzione | da definire | Da iniziare |
| 3 – Stato dell'arte | da definire | Da iniziare |
| 4 – Cyber Range e LXrange | da definire | Da iniziare |
| 5 – Modello proposto | da definire | Da iniziare |
| 6 – Implementazione | da definire | Da iniziare |
| 7 – Composizione e testing | da definire | Da iniziare |
| 8 – Scrittura finale e consegna | da definire | Da iniziare |

---

## Punti aperti

---

## Registro decisioni

| Data | Decisione |
|---|---|
| 13/10/2026 | CPPT (framework a 12 figure professionali ECSF, con il motore Profession Custom) diventa parte integrante della tesi, non un progetto separato |
| 13/10/2026 | Modello concettuale riscritto su CPPT: Concetto = figura professionale ECSF; Laboratorio = stage CPPT (livello = tier); Esercitazione verticale = percorso di carriera nativo della figura; Esercitazione trasversale = percorso generato da Profession Custom |
| 13/10/2026 | Criterio di scelta dei concetti ancorato allo standard ufficiale ENISA ECSF (settembre 2022), non più alle fasi dell'attack path |
| 13/10/2026 | Catena dei concetti ridefinita: 4 famiglie da 3 figure (per colore, come nella mappa CPPT), nessun ordine sequenziale obbligato tra i concetti |
| 13/10/2026 | Distinti due livelli di riuso: infrastrutturale (golden image/VM, ancora da costruire nella tesi) e pedagogico (laboratorio intero, già presente in CPPT) |
| 13/10/2026 | Collocazione di Profession Custom: modello (cap. 3), implementazione del motore di matching (cap. 4), case study incluso quello reale su Leonardo S.p.A. (cap. 5) |
