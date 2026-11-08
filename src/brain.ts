// Strategy. Shared by the live bot and the simulator.
//
// Our own implementation of the design that K-13 (ScrabbleBot tournament #1
// winner) publishes in aryamehr2k/k13-scrabblebot docs/HOW-IT-WORKS.md. That
// repo has no license, so no code is copied from it.
//
// 1. Unseen pool: full bag, minus auctioned letters, minus our start tiles.
// 2. Letter value (points): Monte Carlo. Sample future tiles F from the
//    pool. value(L) = mean[best(rack+L+F) - best(rack+F)]. All comparisons
//    use the same futures (common random numbers), so the noise cancels.
// 3. Coin price lambda (points per coin): bisection, so that the bids on all
//    auctions left spend the balance plus expected word income. Early, coins
//    are scarce and lambda is high. Late, lambda falls and bids rise.
// 4. Bid: maximize P(win) * value - lambda * E[price] over 0..balance. The
//    rival price model uses the prices paid in this match.
// 5. Play/hold: play a word only if
//    reward * (1 + coinBonus * lambda) + E[best(rest+F)] - E[best(rack+F)]
//    is at least playMargin.
// 6. Endgame: no future tiles on the second-to-last auction. On the last
//    auction, bid 0 (a tile won there cannot be played) and play the best
//    split of the full rack.
//
// Not done yet (K-13 has these): per-opponent bid models mined from the
// public archive, a rival-denial term in the bid, hidden-tile inference
// from opponent words, and a two-stage (quick, then refined) live bid.

import { rackToCounts } from "./sim/dictionary.js";
import { Rng } from "./sim/rng.js";
import { DEFAULT_BAG, letterValue } from "./sim/rules.js";
import { bestSplit, keyReward, keyWord, splitScore, take, wordsIn } from "./words.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface BrainParams {
  samples: number; // Monte Carlo futures per decision
  horizon: number; // max future tiles in one future
  beam: number; // bestSplit beam width
  lambdaLetters: number; // pool letters sampled to estimate future spend
  lambdaMin: number; // floor for lambda (points per coin)
  incomeFrac: number; // part of expected word reward counted as spendable
  coinBonus: number; // a reward is also coins: extra value per point, times lambda
  playMargin: number; // play when play beats hold by this many points
  playCands: number; // words considered per play decision
  priceWindow: number; // recent auction prices in the price model
  priorN: number; // prior price samples when the match has fewer prices
}

export const DEFAULT_PARAMS: BrainParams = {
  samples: 24,
  horizon: 4,
  beam: 6,
  lambdaLetters: 4,
  lambdaMin: 0.2,
  incomeFrac: 0.5,
  coinBonus: 0.32,
  playMargin: 2.7,
  playCands: 6,
  priceWindow: 30,
  priorN: 8,
};

// Trained params from best-params.json override the defaults. Keys that
// are not in BrainParams are ignored.
function loadParams(): BrainParams {
  try {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "best-params.json",
    );
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number>;
    const p = { ...DEFAULT_PARAMS };
    for (const k of Object.keys(p) as (keyof BrainParams)[]) {
      if (typeof raw[k] === "number") p[k] = raw[k];
    }
    return p;
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

export const TRAINED_PARAMS: BrainParams = loadParams();

// One closed auction of the current match.
export interface AuctionSeen {
  letter: string;
  winner: "me" | "other" | null;
  paid: number;
}

export interface BrainInput {
  rack: ReadonlyMap<string, number>;
  letter: string;
  bagRemaining: number; // tiles left in the bag after this one
  isLastAuction: boolean;
  balance: number;
  auctionType?: "Vickrey" | "FirstPrice";
  seats?: number; // bots in the match (default 6)
  history?: readonly AuctionSeen[]; // closed auctions of this match, in order
  myWords?: readonly string[]; // words we played in this match
}

export interface Decision {
  words: string[];
  bid: number;
}

const LAMBDA_MAX = 50;
const MAX_WORDS_PER_TURN = 3;

const idx = (c: string) => c.charCodeAt(0) - 65;

// Letters that can still come up: the bag, plus rivals' hidden start tiles.
function unseenPool(input: BrainInput, rc: number[]): number[] {
  const n = new Array<number>(26).fill(0);
  for (const [l, c] of DEFAULT_BAG) n[idx(l)] = c;
  n[idx(input.letter)]!--;
  // Our start tiles = rack + letters we played - letters we won.
  const start = [...rc];
  for (const w of input.myWords ?? []) for (const c of w) start[idx(c)]!++;
  for (const h of input.history ?? []) {
    n[idx(h.letter)]!--;
    if (h.winner === "me") start[idx(h.letter)]!--;
  }
  const pool: number[] = [];
  for (let i = 0; i < 26; i++) {
    const left = n[i]! - Math.max(0, start[i]!);
    for (let k = 0; k < left; k++) pool.push(i);
  }
  return pool;
}

// Expected number of tiles we will still win and be able to play.
function futureTiles(input: BrainInput, p: BrainParams): number {
  const usable = input.bagRemaining - 1; // the last tile cannot be played
  if (usable <= 0) return 0;
  const hist = input.history ?? [];
  const mine = hist.filter((h) => h.winner === "me").length;
  const share = (mine + 1) / (hist.length + (input.seats ?? 6));
  return Math.min(p.horizon, Math.round(usable * share));
}

function sampleFutures(pool: number[], k: number, n: number, rng: Rng): number[][] {
  if (k === 0 || pool.length === 0) return [[]];
  const out: number[][] = [];
  const a = [...pool];
  const m = Math.min(k, a.length);
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < m; i++) {
      const j = rng.int(i, a.length - 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    out.push(a.slice(0, m));
  }
  return out;
}

// Mean best split of rack + each future.
function meanBest(rc: number[], futures: number[][], beam: number): number {
  let sum = 0;
  for (const f of futures) {
    for (const l of f) rc[l]!++;
    sum += splitScore(rc, beam);
    for (const l of f) rc[l]!--;
  }
  return sum / futures.length;
}

// Samples of the highest rival bid for `letter`, from prices paid in this
// match, shifted by the difference in letter value. When a rival won, the
// price is the second-highest bid, so add 1 as a rough correction.
function priceSamples(letter: string, input: BrainInput, p: BrainParams): number[] {
  const v = letterValue(letter);
  const xs: number[] = [];
  for (const h of (input.history ?? []).slice(-p.priceWindow)) {
    if (h.winner === null) {
      xs.push(0);
      continue;
    }
    const x = h.paid - letterValue(h.letter) + v + (h.winner === "other" ? 1 : 0);
    xs.push(Math.max(1, x));
  }
  for (let i = 0; xs.length < p.priorN; i++) xs.push(v + 1 + (i % 5));
  return xs;
}

// Win probability and expected payment per auction for bid b.
function outcome(b: number, xs: number[], firstPrice: boolean) {
  let pWin = 0;
  let spend = 0;
  for (const x of xs) {
    const w = x < b ? 1 : x === b ? 0.5 : 0;
    if (w === 0) continue;
    pWin += w;
    spend += w * (firstPrice ? b : Math.max(1, x));
  }
  return { pWin: pWin / xs.length, spend: spend / xs.length };
}

function bestBid(
  value: number,
  lambda: number,
  xs: number[],
  balance: number,
  firstPrice: boolean,
): number {
  if (value <= 0 || balance <= 0) return 0;
  // Second price: the truthful bid is optimal.
  if (!firstPrice) return Math.min(balance, Math.floor(value / lambda));
  let best = 0;
  let bestU = 0;
  for (let b = 1; b <= balance; b++) {
    const o = outcome(b, xs, true);
    const u = o.pWin * value - lambda * o.spend;
    if (u > bestU) {
      bestU = u;
      best = b;
    }
  }
  return best;
}

interface Item {
  value: number;
  xs: number[];
}

// Lambda at which the expected spend on the auctions left equals budget.
function solveLambda(
  items: Item[],
  auctionsLeft: number,
  budget: number,
  balance: number,
  firstPrice: boolean,
  p: BrainParams,
): number {
  const spendAt = (lambda: number) => {
    let s = 0;
    for (const it of items) {
      const b = bestBid(it.value, lambda, it.xs, balance, firstPrice);
      s += outcome(b, it.xs, firstPrice).spend;
    }
    return (auctionsLeft * s) / items.length;
  };
  if (spendAt(p.lambdaMin) <= budget) return p.lambdaMin;
  if (spendAt(LAMBDA_MAX) > budget) return LAMBDA_MAX;
  let lo = Math.log(p.lambdaMin);
  let hi = Math.log(LAMBDA_MAX);
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2;
    if (spendAt(Math.exp(mid)) > budget) lo = mid;
    else hi = mid;
  }
  return Math.exp(hi);
}

function seedOf(input: BrainInput, rc: number[]): number {
  let h = 2166136261;
  const mix = (n: number) => {
    h ^= n;
    h = Math.imul(h, 16777619);
  };
  for (const c of rc) mix(c);
  mix(idx(input.letter));
  mix(input.bagRemaining);
  mix(input.balance);
  return h >>> 0;
}

export function decide(input: BrainInput, p: BrainParams = DEFAULT_PARAMS): Decision {
  const rc = rackToCounts(input.rack);

  if (input.isLastAuction) {
    return { words: bestSplit(rc, p.beam).keys.map(keyWord), bid: 0 };
  }

  const rng = new Rng(seedOf(input, rc));
  const pool = unseenPool(input, rc);
  const futures = sampleFutures(pool, futureTiles(input, p), p.samples, rng);
  const firstPrice = input.auctionType === "FirstPrice";
  const L = idx(input.letter);
  const xs0 = priceSamples(input.letter, input, p);

  // Pool letters that stand in for the auctions still to come.
  const others: { l: number; xs: number[] }[] = [];
  for (let i = 0; i < p.lambdaLetters && pool.length > 0; i++) {
    const l = pool[rng.int(0, pool.length - 1)]!;
    others.push({ l, xs: priceSamples(String.fromCharCode(65 + l), input, p) });
  }

  const valueOf = (l: number, hold: number) => {
    rc[l]!++;
    const v = meanBest(rc, futures, p.beam) - hold;
    rc[l]!--;
    return v;
  };

  const evaluate = (balance: number) => {
    const hold = meanBest(rc, futures, p.beam);
    const value = valueOf(L, hold);
    const items: Item[] = [
      { value, xs: xs0 },
      ...others.map((o) => ({ value: valueOf(o.l, hold), xs: o.xs })),
    ];
    const budget = balance + p.incomeFrac * hold;
    const lambda = solveLambda(items, input.bagRemaining, budget, balance, firstPrice, p);
    return { hold, value, lambda };
  };

  let balance = input.balance;
  let st = evaluate(balance);
  const words: string[] = [];

  for (let n = 0; n < MAX_WORDS_PER_TURN; n++) {
    const cands = wordsIn(rc)
      .sort((a, b) => keyReward(b) - keyReward(a))
      .slice(0, p.playCands);
    let best = -1;
    let bestGain = -Infinity;
    for (const k of cands) {
      take(rc, k);
      const play = keyReward(k) * (1 + p.coinBonus * st.lambda) + meanBest(rc, futures, p.beam);
      take(rc, k, -1);
      if (play - st.hold > bestGain) {
        bestGain = play - st.hold;
        best = k;
      }
    }
    if (best < 0 || bestGain < p.playMargin) break;
    take(rc, best);
    words.push(keyWord(best));
    balance += keyReward(best);
    st = evaluate(balance);
  }

  return { words, bid: bestBid(st.value, st.lambda, xs0, balance, firstPrice) };
}
