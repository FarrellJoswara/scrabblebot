// Runs many matches and prints stats per player.
//
//   npm run sim -- --matches 2000 --lineup baseline,pool,pool,pool,pool,pool
//
// Options:
//   --matches N     number of matches (default 1000)
//   --seed N        base seed (default 1). Match i uses seed + i.
//   --auction T     Vickrey | FirstPrice (default Vickrey)
//   --lineup L      comma list: babbler, baseline, pool, cheapskate, value, aggressive
//   --p K=V,...     override babbler params, e.g. --p a=3,c=1.5
//
// Sim names are grouped by strategy in the output.

import { runMatch, type AuctionType } from "./engine.js";
import { buildLineup } from "./players.js";
import { Rng } from "./rng.js";
import { DEFAULT_PARAMS, type BrainParams } from "../brain.js";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

interface Acc {
  n: number;
  place: number;
  place2: number;
  wins: number;
  score: number;
  score2: number;
  lost: number;
  rejected: number;
}

const matches = Number(arg("matches", "1000"));
const seed = Number(arg("seed", "1"));
const auctionType = arg("auction", "Vickrey") as AuctionType;
const tokens = arg("lineup", "babbler,pool,pool,pool,pool,pool").split(",");
const params: BrainParams = { ...DEFAULT_PARAMS };
for (const kv of arg("p", "").split(",").filter(Boolean)) {
  const [k, v] = kv.split("=");
  if (!(k! in params)) throw new Error(`Unknown param: ${k}`);
  (params as unknown as Record<string, number>)[k!] = Number(v);
}

const stats = new Map<string, Acc>();
const t0 = Date.now();
for (let m = 0; m < matches; m++) {
  const players = buildLineup(tokens, new Rng(seed * 7919 + m), params);
  const res = runMatch(players, { seed: seed + m, auctionType });
  res.seats.forEach((s, i) => {
    const p = players[i]!;
    const key = p.kind === "sim" ? `sim:${p.strategy}` : p.name;
    const a =
      stats.get(key) ??
      { n: 0, place: 0, place2: 0, wins: 0, score: 0, score2: 0, lost: 0, rejected: 0 };
    a.n++;
    a.place += s.place;
    a.place2 += s.place * s.place;
    a.wins += s.place === 1 ? 1 : 0;
    a.score += s.score;
    a.score2 += s.score * s.score;
    a.lost += s.lettersLeft;
    a.rejected += s.rejected;
    stats.set(key, a);
  });
}

// Mean and 95% half-width.
function ci(sum: number, sum2: number, n: number): string {
  const mean = sum / n;
  const sd = Math.sqrt(Math.max(sum2 / n - mean * mean, 0));
  return `${mean.toFixed(2)} ±${((1.96 * sd) / Math.sqrt(n)).toFixed(2)}`;
}

console.log(
  `${matches} matches, ${auctionType}, lineup ${tokens.join(",")}, ${Date.now() - t0}ms\n`,
);
const rows = [...stats.entries()].sort((a, b) => a[1].place / a[1].n - b[1].place / b[1].n);
console.table(
  Object.fromEntries(
    rows.map(([k, a]) => [
      k,
      {
        seats: a.n,
        "avg place": ci(a.place, a.place2, a.n),
        "win %": ((100 * a.wins) / a.n).toFixed(1),
        "avg score": ci(a.score, a.score2, a.n),
        "tiles lost": (a.lost / a.n).toFixed(2),
        rejected: (a.rejected / a.n).toFixed(2),
      },
    ]),
  ),
);
