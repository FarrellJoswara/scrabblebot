// Player registry for the simulator. Add new strategies here.

import { loadLexicon } from "./dictionary.js";
import type { BotPlayer, Player, SimPlayer, SimStrategy, View } from "./engine.js";
import type { Rng } from "./rng.js";
import { chooseWord, decideBid } from "../strategy.js";
import { decide, DEFAULT_PARAMS, TRAINED_PARAMS, type BrainParams } from "../brain.js";

// The six sim bots on the live server. A lobby that times out is padded
// with a random subset of these.
export const SIM_POOL: readonly [string, SimStrategy][] = [
  ["Cheapo-sim", "Cheapskate"],
  ["Valor-sim", "ValueBidder"],
  ["Brutus-sim", "Aggressive"],
  ["Hagrid-sim", "ValueBidder"],
  ["Maverick-sim", "Aggressive"],
  ["Snippet-sim", "Cheapskate"],
];

export function sim(name: string, strategy: SimStrategy): SimPlayer {
  return { kind: "sim", name, strategy };
}

// The current live strategy in src/strategy.ts. It bids when the auction
// opens and plays a word each time its rack changes, until none is left.
export function baseline(name = "baseline"): BotPlayer {
  // Same array each call: strategy.ts caches its Trie by array reference.
  const dictionary = loadLexicon().byLength;
  return {
    kind: "bot",
    name,
    act(view: View) {
      const rack = new Map(view.rack);
      const bid = decideBid({
        letter: view.letter,
        myBalance: view.balance,
        myRack: new Map(rack),
      });
      const words: string[] = [];
      for (;;) {
        const w = chooseWord({ myRack: rack, dictionary });
        if (!w) break;
        words.push(w);
        for (const c of w) {
          const n = rack.get(c)! - 1;
          if (n === 0) rack.delete(c);
          else rack.set(c, n);
        }
      }
      return { words, bid };
    },
  };
}

// The new strategy in src/brain.ts.  Defaults to TRAINED_PARAMS (from
// best-params.json) so `npm run sim` automatically benchmarks the trained bot.
export function babbler(params: BrainParams = TRAINED_PARAMS, name = "babbler"): BotPlayer {
  return {
    kind: "bot",
    name,
    act: (view: View) =>
      decide(
        {
          ...view,
          seats: view.standings.length,
          history: view.history.map((h) => ({
            letter: h.letter,
            winner: h.winner === null ? null : h.winner === view.seat ? "me" : "other",
            paid: h.paid,
          })),
          myWords: view.plays.filter((p) => p.seat === view.seat).map((p) => p.word),
        },
        params,
      ),
  };
}

// Builds a lineup from tokens. "pool" takes a sim from SIM_POOL that is not
// used yet in this lineup.
export function buildLineup(
  tokens: string[],
  rng: Rng,
  params: BrainParams = DEFAULT_PARAMS,
): Player[] {
  const pool = [...SIM_POOL];
  rng.shuffle(pool);
  return tokens.map((t, i) => {
    switch (t) {
      case "baseline":
        return baseline();
      case "babbler":
        return babbler(params);
      case "ref":
        return babbler(DEFAULT_PARAMS, `ref-${i}`);
      case "pool": {
        const next = pool.shift();
        if (!next) throw new Error("Sim pool is empty");
        return sim(next[0], next[1]);
      }
      case "cheapskate":
        return sim(`cheapskate-${i}`, "Cheapskate");
      case "value":
        return sim(`value-${i}`, "ValueBidder");
      case "aggressive":
        return sim(`aggressive-${i}`, "Aggressive");
      default:
        throw new Error(`Unknown player: ${t}`);
    }
  });
}
