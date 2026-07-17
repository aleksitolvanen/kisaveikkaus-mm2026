// Hakee oikean otteluohjelman ja live-tulokset FIFA:n virallisesta v3-API:sta
// ja päivittää data/<tid>/tournament.json + results.json. Yhdistää FIFA-ottelut
// meidän otteluihin lohko + joukkuepari -avaimella (otteluiden id:t A1..L6
// säilyvät → veikkaukset pysyvät kohdallaan).
//
//   node tools/fetch-fifa.mjs [tid] --mode schedule|results|all
//
// Lähteet:  api.fifa.com/api/v3 · idCompetition=17 · idSeason=285023 (MM 2026).
// HTTP-kuljetus curl-lapsiprosessina (kuten finnkino).
import { readFile, writeFile, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Atominen JSON-kirjoitus: temp + rename samaan hakemistoon. Keskeytynyt ajo ei
// koskaan jätä puolikasta tiedostoa — puolikas results.json oli juuri se joka
// laukaisi alla olevan luvun virhepolun ja hävitti kertyneen tilan.
export async function writeJson(p, obj) {
  const tmp = p + ".tmp";
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  await rename(tmp, p);
}

// results.json:n luku: puuttuva tiedosto → tyhjä runko; RIKKINÄINEN tiedosto →
// kova virhe. (Aiemmin mikä tahansa lukuvirhe nollasi koko tilan hiljaa ja
// seuraava kirjoitus tuhosi peruuttamattomasti myös käsin-overridet
// goalsManual/dirtiestTeamsManual.) Puuttuvat alikentät täydennetään, joten
// käsin "tyhjennetty" {} kelpaa eikä kaada ajoa.
export async function readResults(rPath) {
  let results;
  try { results = JSON.parse(await readFile(rPath, "utf-8")); }
  catch (e) {
    if (e.code === "ENOENT") results = {};
    else throw new Error(`${rPath} ei jäsenny (${e.message}) — EI nollata automaattisesti: korjaa tai poista tiedosto käsin`);
  }
  results.matches = results.matches || {};
  results.live = results.live || {};
  results.dirtiestTeams = results.dirtiestTeams || [];
  results.rounds = results.rounds || {};
  results.goals = results.goals || {};
  return results;
}

const tid = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "mm2026";
const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=all").split("=")[1];
const dir = path.join("data", tid);

const FIFA = {
  base: "https://api.fifa.com/api/v3",
  idCompetition: "17",
  idSeason: "285023",
  from: "2026-06-11T00:00:00Z",
  to: "2026-07-20T00:00:00Z", // koko turnaus (finaali 19.7)
};
// Pudotuspelikierrokset (StageName -> avain/label/järjestys).
// HUOM: MM2026:n API kutsuu pronssiottelua nimellä "Bronze final"; molemmat
// muodot pidetään kartassa, koska nimi on vaihdellut turnauksittain. Tuntematon
// StageName pudottaisi ottelun HILJAA pois knockoutista -> warnUnknownStages.
const KO_ROUNDS = {
  "Round of 32": { key: "r32", label: "1/16-finaali", order: 1 },
  "Round of 16": { key: "r16", label: "1/8-finaali", order: 2 },
  "Quarter-final": { key: "qf", label: "Puolivälierä", order: 3 },
  "Semi-final": { key: "sf", label: "Välierä", order: 4 },
  "Bronze final": { key: "bronze", label: "Pronssiottelu", order: 5 },
  "Play-off for third place": { key: "bronze", label: "Pronssiottelu", order: 5 },
  "Final": { key: "final", label: "Finaali", order: 6 },
};
// Lohkovaiheen lavannimi(t): nämä EIVÄT kuulu knockoutiin (ottelut tunnistetaan
// pareittain), joten niitä ei varoiteta.
const GROUP_STAGES = new Set(["First Stage", "Group Stage"]);
// Kaadu äänekkäästi jos FIFA nimeää lavan tavalla jota kartta ei tunne: muuten
// koko ottelu katoaa knockoutista ilman merkkiä (näin kävi pronssiottelulle).
export function warnUnknownStages(fifa) {
  const unknown = [...new Set(fifa.map((m) => m.StageName?.[0]?.Description).filter(Boolean))]
    .filter((s) => !KO_ROUNDS[s] && !GROUP_STAGES.has(s));
  if (unknown.length) {
    console.warn(`VAROITUS: tuntematon StageName -> ottelut jäävät pois knockoutista: ${unknown.map((s) => `"${s}"`).join(", ")}`);
    console.warn("  Lisää nimi KO_ROUNDS- tai GROUP_STAGES-karttaan (tools/fetch-fifa.mjs).");
  }
  return unknown;
}
// Oikea julkinen matsisivu: match-centre/match/{kilpailu}/{kausi}/{vaihe}/{ottelu}
const matchUrl = (idStage, idMatch) =>
  `https://www.fifa.com/en/match-centre/match/${FIFA.idCompetition}/${FIFA.idSeason}/${idStage}/${idMatch}`;

function curlJson(url) {
  const out = execFileSync("curl", ["-sS", "--max-time", "30", url], {
    encoding: "utf-8", maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(out);
}

function fetchFifaMatches(fromIso = FIFA.from, toIso = FIFA.to) {
  const url = `${FIFA.base}/calendar/matches?idCompetition=${FIFA.idCompetition}` +
    `&idSeason=${FIFA.idSeason}&from=${fromIso}&to=${toIso}&count=104&language=en`;
  const j = curlJson(url);            // API palauttaa null jos parametrit eivät kelpaa
  return (j && j.Results) || [];
}

// Avain: lohkokirjain + aakkostettu joukkuepari (FIFA-koodeilla, kuten datakin)
export const groupLetter = (g) => (g || "").replace(/group/i, "").trim().toUpperCase();
export const pairKey = (grp, a, b) => `${grp}|${[a, b].sort().join("-")}`;

export function indexFifa(matches) {
  const byPair = {};
  for (const m of matches) {
    const grp = groupLetter(m.GroupName?.[0]?.Description);
    const h = m.Home?.Abbreviation, a = m.Away?.Abbreviation;
    if (!grp || !h || !a) continue; // ohita knockout/placeholderit
    byPair[pairKey(grp, h, a)] = m;
  }
  return byPair;
}

// Lohkotulokset: päättyneet (MatchStatus 0) → results.matches, käynnissä →
// results.live (vain näyttöä varten — pisteytys lukee matches). Palauttaa
// muutosten määrän. live rakennetaan joka ajolla puhtaalta pöydältä, jolloin
// päättyneet/poistuneet putoavat siitä automaattisesti.
export function applyResults(byPair, tournament, results) {
  let n = 0;
  const live = {};
  for (const m of tournament.matches) {
    const f = byPair[pairKey(m.group, m.home, m.away)];
    if (!f) continue;
    const st = String(f.MatchStatus);
    const finished = st === "0";
    // Siivoa ristiriitainen jäännös vain kun FIFA sanoo EKSPLISIITTISESTI ettei
    // ottelu ole päättynyt (1=ei alkanut, 3=käynnissä, 12=esiottelu). Tuntematon
    // status ei poista kirjattua tulosta (API-välähdyksen suoja).
    if (!finished && ["1", "3", "12"].includes(st) && results.matches[m.id]) {
      delete results.matches[m.id]; n++;
    }
    const hs = f.HomeTeamScore, as = f.AwayTeamScore;
    if (hs == null || as == null || String(f.MatchStatus) === "1") continue;
    const fHome = f.Home?.Abbreviation;
    const [H, A] = fHome === m.home ? [hs, as] : [as, hs]; // kohdista koti/vieras koodilla
    const v = `${H}-${A}`;
    if (finished) {
      if (results.matches[m.id] !== v) { results.matches[m.id] = v; n++; }
    } else {
      live[m.id] = v;
    }
  }
  if (JSON.stringify(results.live || {}) !== JSON.stringify(live)) { results.live = live; n++; }
  return n;
}

// Päivittää olemassa olevat pudotuspeli-entryt (parit + tulokset) FIFA-datasta. Palauttaa muuttuiko.
// API-välähdyksen suoja kuten applyResultsissa: kirjattu lopputulos tai tunnettu
// joukkuepari poistetaan vain kun FIFA sanoo EKSPLISIITTISESTI ettei ottelu ole
// päättynyt (1=ei alkanut, 3=käynnissä, 12=esiottelu). Hetkellinen outo status tai
// puuttuva kenttä ei nollaa päättynyttä puolivälierää (→ cup-pisteet ja johdetut
// kierrokset katoaisivat julkisesta tilanteesta seuraavaan onnistuneeseen hakuun asti).
const EXPLICIT_NOT_FINISHED = ["1", "3", "12"];
export function updateKnockout(fifa, tournament) {
  if (!tournament.knockout) return false;
  warnUnknownStages(fifa);
  const byId = {};
  for (const e of tournament.knockout) byId[e.fifaId] = e;
  let changed = false;
  for (const fm of fifa) {
    if (!KO_ROUNDS[fm.StageName?.[0]?.Description]) continue;
    const e = byId[fm.IdMatch];
    if (!e) continue;
    const st = String(fm.MatchStatus);
    let home = fm.Home?.Abbreviation || fm.PlaceHolderA || "?";
    let away = fm.Away?.Abbreviation || fm.PlaceHolderB || "?";
    let real = !!(fm.Home?.Abbreviation && fm.Away?.Abbreviation);
    if (e.real && !real) { home = e.home; away = e.away; real = true; }   // tunnettu pari ei palaa placeholderiksi
    const hasScore = fm.HomeTeamScore != null && fm.AwayTeamScore != null && st !== "1";
    const finished = hasScore && st === "0";
    let score = finished ? `${fm.HomeTeamScore}-${fm.AwayTeamScore}` : null;
    if (score == null && e.score != null && !EXPLICIT_NOT_FINISHED.includes(st)) score = e.score;   // välähdys ei pyyhi lopputulosta
    const liveScore = hasScore && !finished ? `${fm.HomeTeamScore}-${fm.AwayTeamScore}` : null;
    if (e.home !== home || e.away !== away || e.score !== score || e.liveScore !== liveScore || e.real !== real) {
      e.home = home; e.away = away; e.real = real; e.score = score; e.liveScore = liveScore; changed = true;
    }
  }
  return changed;
}

// --- Timeline-faktat per ottelu: maalit + kortit RAAKANA (pisteytys tehdään
// UI:ssa/scoring.mjs:ssä, ei tässä). Käytetyt FIFA Event-tyypit: 0 = maali,
// 41 = rankkarimaali, 34 = oma maali (og:true), 2 = keltainen, 3 = suora punainen,
// 4 = toisesta keltaisesta tullut punainen, 51 = rankkari ohi / 60 = torjuttu.
// (Koko tyyppilegenda: AGENTS.md.)
// FIFA Period (paritont = peliosa): 3=1. puoliaika, 5=2., 7/9=jatkoaika,
// 11=RANKKARIKISA → näiden maalit merkitään so:true (eivät maalintekijäpisteisiin).
// Rankkarikisan ohi/torjutut potkut (51/60, vain Period 11) talletetaan so:true +
// miss:"ohi"|"torjuttu" → näytetään rankkariosiossa, eivät vaikuta pisteytykseen.
const SHOOTOUT_PERIOD = 11;
function parseTimeline(f) {
  const url = `${FIFA.base}/timelines/${FIFA.idCompetition}/${FIFA.idSeason}/${f.IdStage}/${f.IdMatch}?language=en`;
  const tl = curlJson(url);
  const ev = tl.Event || [];
  const home = { id: String(f.Home?.IdTeam), code: f.Home?.Abbreviation };
  const away = { id: String(f.Away?.IdTeam), code: f.Away?.Abbreviation };
  const codeOf = (id) => String(id) === home.id ? home.code : String(id) === away.id ? away.code : null;
  const soMiss = (e) => (e.Type === 51 || e.Type === 60) && e.Period === SHOOTOUT_PERIOD;
  // Vain faktat: minuutti + pelaaja-id + joukkue. Nimi EI talletu tähän — se
  // luetaan results.players[id]:stä (kokoonpanoista), ettei nimiä monisteta.
  // min = ottelutilanteen minuutti (esim. "45'+5'"), käytetään myös aikajanaan.
  const goals = ev.filter((e) => e.Type === 0 || e.Type === 41 || e.Type === 34 || soMiss(e))
    .map((e) => {
      const g = { min: e.MatchMinute || null, id: e.IdPlayer || null, team: codeOf(e.IdTeam), pen: e.Type === 41 };
      if (e.Type === 34) g.og = true;                  // oma maali: näytetään aikajanalla, EI maalintekijäpisteisiin
      if (e.Period === SHOOTOUT_PERIOD) g.so = true;   // rankkarikisapotku ei ole maalintekijämaali
      if (soMiss(e)) g.miss = e.Type === 60 ? "torjuttu" : "ohi";   // ei mennyt maaliin
      return g;
    });
  const cards = ev.filter((e) => [2, 3, 4].includes(e.Type))
    .map((e) => ({ min: e.MatchMinute || null, id: e.IdPlayer || null, team: codeOf(e.IdTeam), type: e.Type === 2 ? "y" : e.Type === 4 ? "r2" : "r" }));
  return { goals, cards };
}

// Joukkueen kokoonpano: palauttaa Players[] (IdPlayer, PlayerName=koko nimi, ShortName=sukunimi).
function fetchSquad(idTeam) {
  try {
    const j = curlJson(`${FIFA.base}/teams/${idTeam}/squad?idCompetition=${FIFA.idCompetition}&idSeason=${FIFA.idSeason}&language=en`);
    return j.Players || [];
  } catch { return []; }
}

// Hae yhden ottelun timeline + täydennä puuttuvat pelaajanimet kokoonpanoista.
// Tallettaa results.timelines[key]:hin. Palauttaa muutosmäärän.
function storeTimeline(f, key, results, squadCache) {
  let n = 0;
  const tl = parseTimeline(f);
  if (JSON.stringify(results.timelines[key]) !== JSON.stringify(tl)) { results.timelines[key] = tl; n++; }
  // Pelaajien koko nimet (id -> {full,last}) kokoonpanoista — haetaan vain
  // puuttuville id:ille, joten live-ottelua ei haeta turhaan joka syklissä.
  const ids = [...new Set([...tl.goals, ...tl.cards].map((e) => e.id).filter(Boolean))];
  const missing = ids.filter((id) => !results.players[id]);
  if (missing.length) {
    for (const idTeam of [f.Home?.IdTeam, f.Away?.IdTeam]) {
      if (!idTeam) continue;
      if (!squadCache[idTeam]) squadCache[idTeam] = fetchSquad(idTeam);
      for (const pl of squadCache[idTeam]) {
        if (missing.includes(pl.IdPlayer) && !results.players[pl.IdPlayer]) {
          const full = (pl.PlayerName && pl.PlayerName[0] && pl.PlayerName[0].Description) || "";
          const last = (pl.ShortName && pl.ShortName[0] && pl.ShortName[0].Description) || full.split(/\s+/).pop() || "";
          results.players[pl.IdPlayer] = { full, last };
          n++;
        }
      }
    }
  }
  return n;
}

// Haetaanko ottelun timeline uudelleen tällä syklillä?
// - live: aina (juokseva tilanne).
// - päättynyt: kerran kun se on VAIHTUNUT päättyneeksi (finalized-lippu vielä pois).
//   Live-pollaus tallettaa timelinen joka syklillä, mutta applyResults siirtää
//   ottelun liveistä matchesiin ENNEN tätä → ilman tätä lopullista hakua viimeisen
//   live-pollauksen ja loppuvihellyksen välissä tulleet maalit/kortit jäisivät
//   pysyvästi pois (ja nyt ne vaikuttavat maalintekijä-/sikajengipisteisiin).
export function shouldFetchTimeline(live, finished, finalized) {
  return !!(live || (finished && !finalized));
}

// Täytä results.timelines: käynnissä olevat (aina päivitä) + päättyneet (kerran,
// lopullisena loppuvihellyksen jälkeen). Kattaa sekä lohko-ottelut (byPair) että
// pudotuspelit (fifa-indeksi fifaId:llä) — maalintekijämaalit kertyvät myös
// knockoutissa. Hakee 1 timeline-kutsun per tällainen ottelu. Palauttaa muutosmäärän.
export function updateTimelines(byPair, fifa, tournament, results) {
  results.timelines = results.timelines || {};
  results.players = results.players || {};   // IdPlayer -> { full, last } (kokoonpanoista)
  results.timelinesFinal = results.timelinesFinal || {};   // id -> true: päättynyt timeline haettu lopullisena
  let n = 0;
  const squadCache = {};   // idTeam -> Players[] (saman ajon sisällä, ei turhia hakuja)
  const fetchOne = (f, id, finished) => {
    n += storeTimeline(f, id, results, squadCache);
    if (finished && !results.timelinesFinal[id]) { results.timelinesFinal[id] = true; n++; }
  };
  for (const m of tournament.matches) {
    const f = byPair[pairKey(m.group, m.home, m.away)];
    if (!f || !f.IdStage || !f.IdMatch || !f.Home?.Abbreviation) continue;
    const finished = !!(results.matches || {})[m.id];
    const live = !!(results.live || {})[m.id];
    if (!shouldFetchTimeline(live, finished, results.timelinesFinal[m.id])) continue;
    try { fetchOne(f, m.id, finished); }
    catch { /* timeline/kokoonpano ei vielä saatavilla — yritetään seuraavalla ajolla */ }
  }
  // Pudotuspelit: tunnistus fifaId:llä (knockout-entryt eivät ole byPair-indeksissä).
  const byFifaId = {};
  for (const fm of (fifa || [])) byFifaId[String(fm.IdMatch)] = fm;
  for (const e of (tournament.knockout || [])) {
    const f = e.fifaId && byFifaId[String(e.fifaId)];
    if (!f || !f.IdStage || !f.Home?.Abbreviation) continue;
    const finished = !!e.score;
    const live = !!e.liveScore;
    if (!shouldFetchTimeline(live, finished, results.timelinesFinal[e.id])) continue;
    try { fetchOne(f, e.id, finished); }
    catch { /* yritetään seuraavalla ajolla */ }
  }
  return n;
}

// --- Johdetut pisteytyskohteet timeline-faktoista: maalintekijä + sikajengi.
// Molemmissa KÄSIN-OVERRIDE: results.goalsManual (id->määrä) ja
// results.dirtiestTeamsManual (koodit) voittavat automatiikan eikä fetch koskaan
// ylikirjoita niitä. Pisteet päivittyvät vasta kun lopputulos on selvä:
// maali lasketaan vasta ottelun päätyttyä, sikajengi vasta koko lohkovaiheen jälkeen.

// Maalit pelaaja-id:llä, vain PÄÄTTYNEISTÄ otteluista, rankkarikisat (so) pois.
export function computeGoalCounts(timelines, finishedIds) {
  const by = {};
  for (const id in (timelines || {})) {
    if (finishedIds && !finishedIds.has(id)) continue;
    for (const g of ((timelines[id] || {}).goals || [])) {
      if (g.so || g.og || !g.id) continue;   // rankkarikisa- ja omat maalit eivät ole maalintekijämaaleja
      by[g.id] = (by[g.id] || 0) + 1;
    }
  }
  return by;
}

// Sikajengi: lohkovaiheen korttipistein eniten kerännyt joukkue (tasatilanteessa
// kaikki kärkitiimit). Painot cardPoints { y, r2, r }.
export function computeDirtiest(timelines, groupIds, cardPoints) {
  const cp = cardPoints || { y: 1, r2: 2, r: 3 };
  const set = new Set(groupIds);
  const by = {};
  for (const id in (timelines || {})) {
    if (!set.has(id)) continue;
    for (const c of ((timelines[id] || {}).cards || [])) {
      if (!c.team) continue;
      by[c.team] = (by[c.team] || 0) + (cp[c.type] || 0);
    }
  }
  let max = 0;
  for (const t in by) if (by[t] > max) max = by[t];
  if (max <= 0) return [];
  return Object.keys(by).filter((t) => by[t] === max).sort();
}

// Päivitä results.goals (id->maalit) ja results.dirtiestTeams automaattisesti.
// Käsin-override: results.goalsManual / results.dirtiestTeamsManual. Palauttaa
// 1 jos jompikumpi muuttui, muuten 0.
export function updateDerived(tournament, results) {
  const before = JSON.stringify([results.goals || {}, results.dirtiestTeams || []]);
  // Maalintekijä: päättyneet lohko-ottelut + päättyneet pudotuspelit.
  const finished = new Set([
    ...Object.keys(results.matches || {}),
    ...(tournament.knockout || []).filter((e) => e.score).map((e) => e.id),
  ]);
  const autoGoals = computeGoalCounts(results.timelines, finished);
  results.goals = { ...autoGoals, ...(results.goalsManual || {}) };
  // Sikajengi: vasta kun KOKO lohkovaihe on pelattu JA jokaisen ottelun timeline
  // on haettu (muuten kärki voisi ratketa puutteellisesta korttidatasta).
  const groupIds = tournament.matches.map((m) => m.id);
  const groupComplete = tournament.matches.every((m) =>
    (results.matches || {})[m.id] && (results.timelines || {})[m.id]);
  const cp = tournament.scoring && tournament.scoring.sikajengi && tournament.scoring.sikajengi.cardPoints;
  const manual = results.dirtiestTeamsManual;
  results.dirtiestTeams = (manual && manual.length) ? manual.slice()
    : (groupComplete ? computeDirtiest(results.timelines, groupIds, cp) : []);
  return before === JSON.stringify([results.goals, results.dirtiestTeams]) ? 0 : 1;
}

// Live-tila: hakee ja päivittää vain jos ottelu on parhaillaan käynnissä (kickoff…+200 min).
const LIVE_WINDOW_MIN = 200; // kattaa pitkätkin lisäajat + rankkarit reilulla marginaalilla
async function runLive(tournament, tPath) {
  const now = Date.now();
  const live = [...tournament.matches, ...(tournament.knockout || [])].some((m) => {
    if (!m.kickoff) return false;
    const k = new Date(m.kickoff).getTime();
    return now >= k && now <= k + LIVE_WINDOW_MIN * 60000;
  });
  if (!live) {
    // Ikkunan ulkopuolella: jos live-kentässä tai pudotuspeleissä on jäänteitä
    // (ottelu päättyi ikkunan reunalla ilman uutta hakua), tee YKSI selvityshaku
    // joka finalisoi ne FIFA:n totuudella — ei sokeaa tyhjennystä.
    // Rikkinäinen results.json kaataa ajon ÄÄNEEN (readResults) — verkkovirhe
    // selvityshaussa sen sijaan vain lokitetaan ja yritetään seuraavalla syklillä.
    const rPath = path.join(dir, "results.json");
    const results = await readResults(rPath);
    const koLive = (tournament.knockout || []).some((e) => e.liveScore);
    if (Object.keys(results.live).length || koLive) {
      try {
        const fifa = fetchFifaMatches();
        const byPair = indexFifa(fifa);
        const n = applyResults(byPair, tournament, results);
        const koChanged = updateKnockout(fifa, tournament);
        const tlN = updateTimelines(byPair, fifa, tournament, results);
        const dN = updateDerived(tournament, results);
        if (n || tlN || dN) await writeJson(rPath, results);
        if (koChanged) await writeJson(tPath, tournament);
        console.log(`Selvityshaku ikkunan ulkopuolella: ${n} muutosta, ${tlN} timeline` +
          (koChanged ? ", pudotuspelit päivitetty" : "") + ".");
        return;
      } catch (e) { console.error("Selvityshaku epäonnistui:", e.message); }
    }
    console.log("Ei käynnissä olevia otteluita – ei API-kutsua."); return;
  }

  // KOKO turnauksen kalenteri (yksi kutsu, count=104) — ei päivärajattua ikkunaa.
  // Aiemmin haettiin vain tämä + seuraava päivä, jolloin updateKnockout ei nähnyt
  // kauempana olevia otteluita: puolivälierän ratkettua FIFA täytti välierän parin
  // heti, mutta se oli ikkunan ulkopuolella (3 pv päässä) → pari päivittyi vasta
  // kerran vuorokaudessa ajettavassa all-moodissa ja sivulla luki "W99 – W100".
  // Leveä ikkuna ei maksa lisäkutsuja: päättyneiden timelinet ovat jo lopullisia
  // (timelinesFinal) eikä niitä haeta uudelleen.
  const fifa = fetchFifaMatches();

  const rPath = path.join(dir, "results.json");
  const results = await readResults(rPath);

  const byPair = indexFifa(fifa);
  const n = applyResults(byPair, tournament, results);
  const koChanged = updateKnockout(fifa, tournament);
  const tlN = updateTimelines(byPair, fifa, tournament, results);
  const dN = updateDerived(tournament, results);

  if (n || tlN || dN) await writeJson(rPath, results);
  if (koChanged) await writeJson(tPath, tournament);
  console.log(`Live (${fifa.length} ottelua ikkunassa): ${n} lohkotulosta, ${tlN} timeline, ${dN ? "johdetut päivitetty" : "ei johdettujen muutosta"}` +
    (koChanged ? ", pudotuspelit päivitetty" : "") + ".");
}

async function main() {
  const tPath = path.join(dir, "tournament.json");
  const tournament = JSON.parse(await readFile(tPath, "utf-8"));

  if (mode === "live") { await runLive(tournament, tPath); return; }

  const fifa = fetchFifaMatches();
  const byPair = indexFifa(fifa);
  console.log(`FIFA: ${fifa.length} ottelua haettu, ${Object.keys(byPair).length} lohko-ottelua indeksoitu`);

  let schedUpdated = 0, unmatched = [];

  if (mode === "schedule" || mode === "all") {
    for (const m of tournament.matches) {
      const f = byPair[pairKey(m.group, m.home, m.away)];
      if (!f) { unmatched.push(m.id + " " + m.home + "-" + m.away); continue; }
      m.kickoff = f.Date;        // UTC tietokantaan; sivu näyttää Suomen ajan
      delete m.timeLabel;        // label lasketaan sivulla kickoffista
      m.fifaId = f.IdMatch;
      m.matchNumber = f.MatchNumber;
      m.stadium = f.Stadium?.Name?.[0]?.Description || null;
      m.city = f.Stadium?.CityName?.[0]?.Description || null;
      if (f.Attendance) m.attendance = f.Attendance;   // yleisömäärä (samasta kalenterihausta, ei lisäkutsua)
      m.url = matchUrl(f.IdStage, f.IdMatch);
      schedUpdated++;
    }
    tournament.matches.sort((a, b) => (a.kickoff || "").localeCompare(b.kickoff || ""));
    // Maiden koko nimet (koodi -> nimi) tooltippejä varten
    const teamNames = {};
    for (const fm of fifa) {
      for (const side of [fm.Home, fm.Away]) {
        const code = side?.Abbreviation, name = side?.TeamName?.[0]?.Description;
        if (code && name && tournament.teams.includes(code)) teamNames[code] = name;
      }
    }
    tournament.teamNames = teamNames;

    // Pudotuspeliottelut: template-nimet (PlaceHolder) kunnes parit tiedossa,
    // päivittyvät oikeiksi + tuloksiksi joka haulla. feedA/feedB = syöttävien
    // otteluiden numerot ("W74"-placeholderista) — kaavion puu, joka säilytetään
    // vanhasta datasta jos FIFA ei enää tarjoa placeholderia.
    const W = (s) => { const m = /^W(\d+)$/.exec(String(s || "")); return m ? Number(m[1]) : null; };
    warnUnknownStages(fifa);
    const oldByNum = {};
    for (const e of tournament.knockout || []) oldByNum[e.matchNumber] = e;
    const knockout = [];
    for (const fm of fifa) {
      const rd = KO_ROUNDS[fm.StageName?.[0]?.Description];
      if (!rd) continue;
      const st = String(fm.MatchStatus);
      const old = oldByNum[fm.MatchNumber];
      // Sama API-välähdyksen suoja kuin updateKnockoutissa: tunnettu pari ja
      // kirjattu lopputulos säilyvät vanhasta entrystä ellei FIFA eksplisiittisesti
      // sano ettei ottelu ole päättynyt.
      let home = fm.Home?.Abbreviation || fm.PlaceHolderA || "?";
      let away = fm.Away?.Abbreviation || fm.PlaceHolderB || "?";
      let real = !!(fm.Home?.Abbreviation && fm.Away?.Abbreviation);
      if (old?.real && !real) { home = old.home; away = old.away; real = true; }
      const hasScore = fm.HomeTeamScore != null && fm.AwayTeamScore != null && st !== "1";
      const finished = hasScore && st === "0";
      let score = finished ? `${fm.HomeTeamScore}-${fm.AwayTeamScore}` : null;
      if (score == null && old?.score != null && !EXPLICIT_NOT_FINISHED.includes(st)) score = old.score;
      knockout.push({
        feedA: W(fm.PlaceHolderA) ?? old?.feedA ?? null,
        feedB: W(fm.PlaceHolderB) ?? old?.feedB ?? null,
        id: "KO" + fm.MatchNumber, round: rd.key, roundLabel: rd.label, order: rd.order,
        home, away, real,
        score,
        liveScore: hasScore && !finished ? `${fm.HomeTeamScore}-${fm.AwayTeamScore}` : null,
        kickoff: fm.Date, stadium: fm.Stadium?.Name?.[0]?.Description || null,
        city: fm.Stadium?.CityName?.[0]?.Description || null,
        attendance: fm.Attendance || old?.attendance || null,
        fifaId: fm.IdMatch, matchNumber: fm.MatchNumber, url: matchUrl(fm.IdStage, fm.IdMatch),
        // channels on käsin ylläpidettyä dataa (site.mjs leipoo sen sivulle) eikä
        // tule FIFA:lta -> kanna se vanhasta entrystä, muutoin rebuild pyyhkii sen.
        ...(old?.channels ? { channels: old.channels } : {}),
      });
    }
    knockout.sort((a, b) => a.order - b.order || (a.kickoff || "").localeCompare(b.kickoff || ""));
    tournament.knockout = knockout;
    await writeJson(tPath, tournament);
    console.log(`Otteluohjelma päivitetty: ${schedUpdated}/${tournament.matches.length} ottelua` +
      (unmatched.length ? `, EI löytynyt: ${unmatched.join(", ")}` : ""));
  }

  if (mode === "results" || mode === "all") {
    const rPath = path.join(dir, "results.json");
    const results = await readResults(rPath);
    const resWritten = applyResults(byPair, tournament, results);
    const tlWritten = updateTimelines(byPair, fifa, tournament, results);   // backfill: valmiit ottelut joilta timeline puuttuu
    updateDerived(tournament, results);   // maalintekijä + sikajengi (käsin-override säilyy)
    await writeJson(rPath, results);
    if (mode === "results") { // all-tilassa knockout päivittyy jo schedule-blokissa
      if (updateKnockout(fifa, tournament)) await writeJson(tPath, tournament);
    }
    console.log(`Tulokset päivitetty: ${resWritten} lohkotulosta, ${tlWritten} timeline (maalit+kortit). Maalintekijä+sikajengi automaattisesti; cup-jatkoonpääsijät syötetään käsin.`);
  }
}

// Aja main vain suoraan käynnistettynä (testit importtaavat funktiot ilman sivuvaikutuksia)
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url.toLowerCase() === invoked.toLowerCase()) {
  main().catch((e) => { console.error("Virhe:", e.message); process.exit(1); });
}
