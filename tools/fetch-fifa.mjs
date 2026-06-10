// Hakee oikean otteluohjelman ja live-tulokset FIFA:n virallisesta v3-API:sta
// ja päivittää data/<tid>/tournament.json + results.json. Yhdistää FIFA-ottelut
// meidän otteluihin lohko + joukkuepari -avaimella (otteluiden id:t A1..L6
// säilyvät → veikkaukset pysyvät kohdallaan).
//
//   node tools/fetch-fifa.mjs [tid] --mode schedule|results|all
//
// Lähteet:  api.fifa.com/api/v3 · idCompetition=17 · idSeason=285023 (MM 2026).
// HTTP-kuljetus curl-lapsiprosessina (kuten finnkino).
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

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
// Pudotuspelikierrokset (StageName -> avain/label/järjestys)
const KO_ROUNDS = {
  "Round of 32": { key: "r32", label: "1/16-finaali", order: 1 },
  "Round of 16": { key: "r16", label: "1/8-finaali", order: 2 },
  "Quarter-final": { key: "qf", label: "Puolivälierä", order: 3 },
  "Semi-final": { key: "sf", label: "Välierä", order: 4 },
  "Play-off for third place": { key: "bronze", label: "Pronssiottelu", order: 5 },
  "Final": { key: "final", label: "Finaali", order: 6 },
};
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
  return curlJson(url).Results || [];
}

// Avain: lohkokirjain + aakkostettu joukkuepari (FIFA-koodeilla, kuten datakin)
const groupLetter = (g) => (g || "").replace(/group/i, "").trim().toUpperCase();
const pairKey = (grp, a, b) => `${grp}|${[a, b].sort().join("-")}`;

function indexFifa(matches) {
  const byPair = {};
  for (const m of matches) {
    const grp = groupLetter(m.GroupName?.[0]?.Description);
    const h = m.Home?.Abbreviation, a = m.Away?.Abbreviation;
    if (!grp || !h || !a) continue; // ohita knockout/placeholderit
    byPair[pairKey(grp, h, a)] = m;
  }
  return byPair;
}

// Päivittää lohko-otteluiden tulokset results.matches:iin (vain muuttuneet). Palauttaa muutosten määrän.
function applyResults(byPair, tournament, results) {
  let n = 0;
  for (const m of tournament.matches) {
    const f = byPair[pairKey(m.group, m.home, m.away)];
    if (!f) continue;
    const hs = f.HomeTeamScore, as = f.AwayTeamScore;
    if (hs == null || as == null || String(f.MatchStatus) === "1") continue;
    const fHome = f.Home?.Abbreviation;
    const [H, A] = fHome === m.home ? [hs, as] : [as, hs]; // kohdista koti/vieras koodilla
    const v = `${H}-${A}`;
    if (results.matches[m.id] !== v) { results.matches[m.id] = v; n++; }
  }
  return n;
}

// Päivittää olemassa olevat pudotuspeli-entryt (parit + tulokset) FIFA-datasta. Palauttaa muuttuiko.
function updateKnockout(fifa, tournament) {
  if (!tournament.knockout) return false;
  const byId = {};
  for (const e of tournament.knockout) byId[e.fifaId] = e;
  let changed = false;
  for (const fm of fifa) {
    if (!KO_ROUNDS[fm.StageName?.[0]?.Description]) continue;
    const e = byId[fm.IdMatch];
    if (!e) continue;
    const home = fm.Home?.Abbreviation || fm.PlaceHolderA || "?";
    const away = fm.Away?.Abbreviation || fm.PlaceHolderB || "?";
    const played = fm.HomeTeamScore != null && fm.AwayTeamScore != null && String(fm.MatchStatus) !== "1";
    const score = played ? `${fm.HomeTeamScore}-${fm.AwayTeamScore}` : null;
    const real = !!(fm.Home?.Abbreviation && fm.Away?.Abbreviation);
    if (e.home !== home || e.away !== away || e.score !== score || e.real !== real) {
      e.home = home; e.away = away; e.real = real; e.score = score; changed = true;
    }
  }
  return changed;
}

// Live-tila: hakee ja päivittää vain jos ottelu on parhaillaan käynnissä (kickoff…+170 min).
const LIVE_WINDOW_MIN = 170; // kattaa lisäajan + rankkarit
async function runLive(tournament, tPath) {
  const now = Date.now();
  const live = [...tournament.matches, ...(tournament.knockout || [])].some((m) => {
    if (!m.kickoff) return false;
    const k = new Date(m.kickoff).getTime();
    return now >= k && now <= k + LIVE_WINDOW_MIN * 60000;
  });
  if (!live) { console.log("Ei käynnissä olevia otteluita – ei API-kutsua."); return; }

  const fromIso = new Date(now - LIVE_WINDOW_MIN * 60000).toISOString();
  const toIso = new Date(now + 5 * 60000).toISOString();
  const fifa = fetchFifaMatches(fromIso, toIso);

  const rPath = path.join(dir, "results.json");
  let results;
  try { results = JSON.parse(await readFile(rPath, "utf-8")); }
  catch { results = { matches: {}, dirtiestTeams: [], rounds: {}, goals: {} }; }

  const n = applyResults(indexFifa(fifa), tournament, results);
  const koChanged = updateKnockout(fifa, tournament);

  if (n) await writeFile(rPath, JSON.stringify(results, null, 2) + "\n", "utf-8");
  if (koChanged) await writeFile(tPath, JSON.stringify(tournament, null, 2) + "\n", "utf-8");
  console.log(`Live (${fifa.length} ottelua ikkunassa): ${n} lohkotulosta päivitetty` +
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
    const oldByNum = {};
    for (const e of tournament.knockout || []) oldByNum[e.matchNumber] = e;
    const knockout = [];
    for (const fm of fifa) {
      const rd = KO_ROUNDS[fm.StageName?.[0]?.Description];
      if (!rd) continue;
      const home = fm.Home?.Abbreviation || fm.PlaceHolderA || "?";
      const away = fm.Away?.Abbreviation || fm.PlaceHolderB || "?";
      const played = fm.HomeTeamScore != null && fm.AwayTeamScore != null && String(fm.MatchStatus) !== "1";
      const old = oldByNum[fm.MatchNumber];
      knockout.push({
        feedA: W(fm.PlaceHolderA) ?? old?.feedA ?? null,
        feedB: W(fm.PlaceHolderB) ?? old?.feedB ?? null,
        id: "KO" + fm.MatchNumber, round: rd.key, roundLabel: rd.label, order: rd.order,
        home, away, real: !!(fm.Home?.Abbreviation && fm.Away?.Abbreviation),
        score: played ? `${fm.HomeTeamScore}-${fm.AwayTeamScore}` : null,
        kickoff: fm.Date, stadium: fm.Stadium?.Name?.[0]?.Description || null,
        city: fm.Stadium?.CityName?.[0]?.Description || null,
        fifaId: fm.IdMatch, matchNumber: fm.MatchNumber, url: matchUrl(fm.IdStage, fm.IdMatch),
      });
    }
    knockout.sort((a, b) => a.order - b.order || (a.kickoff || "").localeCompare(b.kickoff || ""));
    tournament.knockout = knockout;
    await writeFile(tPath, JSON.stringify(tournament, null, 2) + "\n", "utf-8");
    console.log(`Otteluohjelma päivitetty: ${schedUpdated}/${tournament.matches.length} ottelua` +
      (unmatched.length ? `, EI löytynyt: ${unmatched.join(", ")}` : ""));
  }

  if (mode === "results" || mode === "all") {
    const rPath = path.join(dir, "results.json");
    let results;
    try { results = JSON.parse(await readFile(rPath, "utf-8")); }
    catch { results = { matches: {}, dirtiestTeams: [], rounds: {}, goals: {} }; }
    const resWritten = applyResults(byPair, tournament, results);
    await writeFile(rPath, JSON.stringify(results, null, 2) + "\n", "utf-8");
    if (mode === "results") { // all-tilassa knockout päivittyy jo schedule-blokissa
      if (updateKnockout(fifa, tournament)) await writeFile(tPath, JSON.stringify(tournament, null, 2) + "\n", "utf-8");
    }
    console.log(`Tulokset päivitetty: ${resWritten} lohkotulosta (sikajengi, cup ja maalit syötetään käsin).`);
  }
}

main().catch((e) => { console.error("Virhe:", e.message); process.exit(1); });
