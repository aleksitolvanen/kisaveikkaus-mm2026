// Yhdistää data/<tid>/{tournament,predictions,results}.json yhdeksi data.json:ksi
// repon juureen. Sivusto pollaa tätä rawsta:
//   https://raw.githubusercontent.com/aleksitolvanen/kisaveikkaus-mm2026/main/data.json
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const tid = process.argv[2] || "mm2026";
const dir = path.join("data", tid);
const rd = async (f) => JSON.parse(await readFile(path.join(dir, f), "utf-8"));
const [tournament, predictions, results] = await Promise.all([
  rd("tournament.json"), rd("predictions.json"), rd("results.json"),
]);

await writeFile("data.json", JSON.stringify({ tournament, predictions, results }), "utf-8");
console.log(`data.json kirjoitettu (${tid}): ${Object.keys(predictions).length} veikkaajaa, ` +
  `${Object.keys(results.matches || {}).length} tulosta`);
