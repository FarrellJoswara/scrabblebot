import test from "node:test";
import assert from "node:assert/strict";
import { decide, DEFAULT_PARAMS, type BrainInput } from "./brain.js";
import { findBestPlayable, rackToCounts } from "./sim/dictionary.js";
import { Rng } from "./sim/rng.js";
import { bestSplit, keyWord, wordsIn } from "./words.js";

function makeInput(overrides: Partial<BrainInput> = {}): BrainInput {
  return {
    rack: new Map([["C", 1], ["A", 1], ["T", 1]]),
    letter: "S",
    bagRemaining: 50,
    isLastAuction: false,
    balance: 100,
    ...overrides,
  };
}

const STONER = new Map([["S", 1], ["T", 1], ["O", 1], ["N", 1], ["E", 1], ["R", 1]]);

test("last auction: bid 0 and play the full rack", () => {
  const d = decide(makeInput({
    rack: new Map([["C", 1], ["A", 1], ["T", 1], ["S", 1]]),
    bagRemaining: 0,
    isLastAuction: true,
  }));
  assert.equal(d.bid, 0);
  assert.equal(d.words.length, 1);
  assert.equal(d.words[0]!.length, 4);
});

test("bid never exceeds balance", () => {
  for (const balance of [0, 1, 3, 10]) {
    const d = decide(makeInput({ rack: STONER, letter: "Z", balance, bagRemaining: 3 }));
    assert.ok(d.bid >= 0 && d.bid <= balance, `bid ${d.bid}, balance ${balance}`);
  }
});

test("second-to-last auction: value only what the letter completes now", () => {
  // No future tiles. A makes SENATOR (+6); Q and L improve nothing.
  const bid = (letter: string) =>
    decide(makeInput({ rack: STONER, letter, bagRemaining: 1 })).bid;
  assert.ok(bid("A") > 0, `A ${bid("A")}`);
  assert.equal(bid("Q"), 0);
  assert.equal(bid("L"), 0);
});

test("holds STONER early for a longer word", () => {
  assert.deepEqual(decide(makeInput({ rack: STONER, bagRemaining: 50 })).words, []);
});

test("first-price bid is not above the second-price bid", () => {
  const input = makeInput({ rack: STONER, letter: "A" });
  const v = decide({ ...input, auctionType: "Vickrey" });
  const f = decide({ ...input, auctionType: "FirstPrice" });
  assert.ok(f.bid <= v.bid, `first-price ${f.bid}, Vickrey ${v.bid}`);
});

test("decide is deterministic", () => {
  const input = makeInput({ rack: STONER, letter: "D" });
  assert.deepEqual(decide(input), decide(input));
});

test("wordsIn finds the server's longest word", () => {
  const rng = new Rng(7);
  const letters = "AABCDEEEFGHIIKLMNNOOPRRSSTTUVWY";
  for (let n = 0; n < 200; n++) {
    const rack = new Map<string, number>();
    const size = rng.int(2, 10);
    for (let i = 0; i < size; i++) {
      const c = letters[rng.int(0, letters.length - 1)]!;
      rack.set(c, (rack.get(c) ?? 0) + 1);
    }
    const server = findBestPlayable(rack, 2);
    const longest = Math.max(0, ...wordsIn(rackToCounts(rack)).map((k) => keyWord(k).length));
    assert.equal(longest, server?.length ?? 0, [...rack].join());
  }
});

test("bestSplit uses each tile at most once", () => {
  const rc = rackToCounts(STONER);
  const words = bestSplit(rc, DEFAULT_PARAMS.beam).keys.map(keyWord);
  assert.equal(words.join("").length, 6);
});
