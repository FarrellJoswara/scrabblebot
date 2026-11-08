// Parameter optimizer for brain.ts using (1+λ)-CMA-ES self-play.
//
// Usage:
//   npm run train                        # 500 iterations, 200 matches each
//   npm run train -- --iters 200 --eval 100
//   npm run train -- --lineup babbler,pool,pool,pool,pool,pool
//
// Output: best-params.json (loaded by brain.ts at runtime).
//
// How it works:
//   We treat the 7 BrainParams numbers as a point in R^7 and search for the
//   point that maximises win rate against a fixed pool of sim bots.
//   CMA-ES is a derivative-free optimiser well-suited for noisy, low-dim
//   functions like this. Each iteration we sample λ=8 candidates, run `eval`
//   matches per candidate, rank them by average placement, and update the
//   distribution mean and covariance toward the winners.

import { runMatch } from "./sim/engine.js";
import { buildLineup } from "./sim/players.js";
import { Rng } from "./sim/rng.js";
import { DEFAULT_PARAMS, type BrainParams } from "./brain.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── CLI args ────────────────────────────────────────────────────────────────

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const ITERS   = Number(arg("iters",  "100"));
const EVAL    = Number(arg("eval",   "50"));    // matches per candidate
const LAMBDA  = Number(arg("lambda", "6"));     // offspring per generation
const MU      = Math.max(1, Math.floor(LAMBDA / 2));
const LINEUP  = arg("lineup", "babbler,ref,ref,pool,pool,pool").split(",");
const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "best-params.json",
);

// ─── Param encoding / decoding ───────────────────────────────────────────────

// Tuned params. The others (samples, beam, ...) trade speed for accuracy
// and keep their defaults.
const PARAM_KEYS: (keyof BrainParams)[] = [
  "horizon", "lambdaMin", "incomeFrac", "coinBonus", "playMargin",
];
const DIM = PARAM_KEYS.length;
const INT_KEYS = new Set<keyof BrainParams>(["horizon"]);

// Hard bounds: keep params in sane ranges.
const BOUNDS: Partial<Record<keyof BrainParams, [number, number]>> = {
  horizon:    [0, 8],
  lambdaMin:  [0.05, 1],
  incomeFrac: [0, 1],
  coinBonus:  [0, 1],
  playMargin: [0, 10],
};

function encode(p: BrainParams): number[] {
  return PARAM_KEYS.map((k) => p[k] as number);
}

function decode(v: number[]): BrainParams {
  const p = { ...DEFAULT_PARAMS } as Record<string, number>;
  for (let i = 0; i < DIM; i++) {
    const k = PARAM_KEYS[i]!;
    const [lo, hi] = BOUNDS[k]!;
    // Clamp to bounds and round integers.
    let val = Math.max(lo, Math.min(hi, v[i]!));
    if (INT_KEYS.has(k)) val = Math.round(val);
    p[k] = val;
  }
  return p as unknown as BrainParams;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

// Lower is better: returns average placement (1 = won, 2 = second, ...).
// Using placement rather than raw score makes the metric opponent-agnostic.
function evaluate(params: BrainParams, matches: number, baseSeed: number): { score: number; place: number; avgScore: number } {
  let totalPlace = 0;
  let totalScore = 0;
  for (let m = 0; m < matches; m++) {
    const rng = new Rng(baseSeed * 7919 + m);
    const players = buildLineup(LINEUP, rng, params);
    const res = runMatch(players, { seed: baseSeed + m });
    // Our bot is always seat 0.
    totalPlace += res.seats[0]!.place;
    totalScore += res.seats[0]!.score;
  }
  const avgPlace = totalPlace / matches;
  const avgScore = totalScore / matches;
  // Minimize score: lower avg place is primary, higher points is tiebreaker.
  return { score: avgPlace - 0.001 * avgScore, place: avgPlace, avgScore };
}

// ─── Minimal (1+λ)-CMA-ES ────────────────────────────────────────────────────
// Reference: Hansen (2016) "The CMA Evolution Strategy: A Tutorial".
// We use the simplest μ/λ variant without cumulation for clarity.

function randn(rng: Rng): number {
  // Box-Muller.
  const u = Math.max(1e-15, rng.next());
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function matMulVec(L: number[][], v: number[]): number[] {
  // L is lower-triangular (Cholesky factor of C).
  return L.map((row) => row.reduce((s, lij, j) => s + lij * v[j]!, 0));
}

// Cholesky decomposition: C = L L^T.
function cholesky(C: number[][]): number[][] {
  const n = C.length;
  const L = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = C[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      L[i]![j] = j === i ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j]![j]!;
    }
  }
  return L;
}

function identity(n: number): number[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
}

function scaleMatrix(M: number[][], s: number): number[][] {
  return M.map((row) => row.map((x) => x * s));
}

function addMatrices(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((x, j) => x + B[i]![j]!));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const rng = new Rng(42);

  let mean = encode(DEFAULT_PARAMS);
  let sigma = 1.5;                       // global step size
  let C = identity(DIM);                 // covariance matrix
  const cc  = 4 / (DIM + 4);            // cumulation for C
  const c1  = 2 / (DIM + 1.3) ** 2;    // rank-1 learning rate
  const cmu = Math.min(1 - c1, 2 * (MU - 2 + 1 / MU) / (DIM + 2) ** 2);
  const chiN = Math.sqrt(DIM) * (1 - 1 / (4 * DIM) + 1 / (21 * DIM ** 2));
  let pc = new Array<number>(DIM).fill(0);  // evolution path

  // Evaluate the starting point.
  const baselineEval = evaluate(decode(mean), EVAL, rng.int(1, 999999));
  let bestScore = baselineEval.score;
  let bestPlace = baselineEval.place;
  let bestAvgScore = baselineEval.avgScore;
  let bestParams = decode(mean);

  console.log(
    `Training ${ITERS} iters × ${LAMBDA} candidates × ${EVAL} matches = ` +
    `${ITERS * LAMBDA * EVAL} total matches`,
  );
  console.log(`Lineup: ${LINEUP.join(", ")}`);
  console.log(`Baseline: place ${bestPlace.toFixed(2)}, score ${bestAvgScore.toFixed(1)} (fit: ${bestScore.toFixed(3)})\n`);

  for (let iter = 0; iter < ITERS; iter++) {
    const L = cholesky(C);

    // Sample λ offspring.
    const offspring: { z: number[]; y: number[]; v: number[]; score: number; place: number; avgScore: number }[] = [];
    for (let k = 0; k < LAMBDA; k++) {
      const z = Array.from({ length: DIM }, () => randn(rng));
      const y = matMulVec(L, z);
      const v = mean.map((m, i) => m + sigma * y[i]!);
      const baseSeed = rng.int(1, 999999);
      const evalRes = evaluate(decode(v), EVAL, baseSeed);
      offspring.push({ z, y, v, score: evalRes.score, place: evalRes.place, avgScore: evalRes.avgScore });
    }

    // Rank by score (lower avg place = better).
    offspring.sort((a, b) => a.score - b.score);

    // Log progress.
    const best = offspring[0]!;
    if (best.score < bestScore) {
      bestScore = best.score;
      bestPlace = best.place;
      bestAvgScore = best.avgScore;
      bestParams = decode(best.v);
      fs.writeFileSync(OUT_PATH, JSON.stringify(bestParams, null, 2));
      console.log(
        `Iter ${iter + 1}: new best -> place ${bestPlace.toFixed(2)}, score ${bestAvgScore.toFixed(1)} (fit ${bestScore.toFixed(3)})`,
      );
    } else if ((iter + 1) % 10 === 0) {
      console.log(
        `Iter ${iter + 1}: best so far place ${bestPlace.toFixed(2)} (fit ${bestScore.toFixed(3)}), ` +
        `gen best place ${best.place.toFixed(2)}`,
      );
    }

    // Update mean toward top μ offspring.
    const winners = offspring.slice(0, MU);
    // Equal weights.
    const wt = 1 / MU;
    const newMean = new Array<number>(DIM).fill(0);
    for (const w of winners) {
      for (let i = 0; i < DIM; i++) newMean[i]! += wt * w.v[i]!;
    }

    // Step direction in y-space.
    const dy = newMean.map((m, i) => m - mean[i]!);
    const yz = winners.reduce(
      (acc, w) => acc.map((a, i) => a + wt * w.z[i]!),
      new Array<number>(DIM).fill(0),
    );

    // Cumulation path.
    const hth = Math.sqrt(cc * (2 - cc) * MU);
    pc = pc.map((p, i) => (1 - cc) * p + hth * yz[i]!);

    // Rank-1 and rank-μ update of C.
    const pc_outer: number[][] = Array.from({ length: DIM }, (_, i) =>
      Array.from({ length: DIM }, (_, j) => pc[i]! * pc[j]!),
    );
    const mu_outer: number[][] = winners.reduce(
      (acc, w) => {
        const yy: number[][] = Array.from({ length: DIM }, (_, i) =>
          Array.from({ length: DIM }, (_, j) => w.y[i]! * w.y[j]!),
        );
        return addMatrices(acc, scaleMatrix(yy, wt));
      },
      Array.from({ length: DIM }, () => new Array<number>(DIM).fill(0)),
    );

    C = addMatrices(
      scaleMatrix(C, 1 - c1 - cmu),
      addMatrices(scaleMatrix(pc_outer, c1), scaleMatrix(mu_outer, cmu)),
    );

    // Step size adaptation (cumulative path length control).
    const pathLen = Math.sqrt(pc.reduce((s, v) => s + v * v, 0));
    sigma *= Math.exp((pathLen / chiN - 1) * cc / 2);
    sigma = Math.max(1e-4, Math.min(10, sigma));  // guard against explosion

    mean = newMean;
  }

  console.log(`\nDone. Best avg place: ${bestScore.toFixed(3)}`);
  console.log("Best params:", JSON.stringify(bestParams, null, 2));
  console.log(`Saved to ${OUT_PATH}`);
}

main().catch(console.error);
