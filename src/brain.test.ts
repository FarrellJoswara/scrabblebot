import test from "node:test";
import assert from "node:assert/strict";
import { decide, DEFAULT_PARAMS, type BrainInput } from "./brain.js";

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

test("decide flushes full rack when bag < flushAt", () => {
  const input = makeInput({
    rack: new Map([["C", 1], ["A", 1], ["T", 1], ["S", 1]]),
    bagRemaining: 1, // < flushAt (default 2)
  });
  const d = decide(input);
  assert.ok(d.words.length > 0, "should play words in endgame");
  assert.ok(d.words.includes("CATS") || d.words.includes("ACTS"), "should find best split");
});

test("decide respects budgetFrac cap on bids", () => {
  const input = makeInput({
    balance: 10,
    letter: "Q", // high value letter
  });
  const p = { ...DEFAULT_PARAMS, budgetFrac: 0.2, a: 10, b: 5, c: 5 };
  const d = decide(input, p);
  // Cap is floor(10 * 0.2) = 2
  assert.ok(d.bid <= 2, `bid ${d.bid} should be <= budgetCap of 2`);
});

test("decide bids 0 on last auction", () => {
  const input = makeInput({ isLastAuction: true });
  const d = decide(input);
  assert.equal(d.bid, 0, "should not bid on last auction");
});

test("decide triggers rack pressure when rack size >= maxRack", () => {
  // Fill rack with 10 letters that contain a playable word
  const rack = new Map<string, number>([
    ["C", 1], ["A", 1], ["T", 1], // spells CAT (length 3, normally held in mid-game)
    ["B", 1], ["D", 1], ["F", 1], ["G", 1], ["H", 1], ["J", 1], ["K", 1],
  ]);
  const input = makeInput({
    rack,
    bagRemaining: 50, // midgame where normal threshold is 7
  });
  const p = { ...DEFAULT_PARAMS, maxRack: 9, playLen: 7 };
  const d = decide(input, p);
  assert.ok(d.words.length > 0, "should play a word under rack pressure even if < playLen");
});

test("decide boosts bid on U when holding Q", () => {
  const rackWithQ = new Map([["Q", 1], ["B", 1], ["T", 1]]);
  const rackWithoutQ = new Map([["B", 1], ["D", 1], ["T", 1]]);

  const d1 = decide(makeInput({ rack: rackWithQ, letter: "U" }));
  const d2 = decide(makeInput({ rack: rackWithoutQ, letter: "U" }));
  assert.ok(d1.bid > d2.bid, `Bid with Q (${d1.bid}) should be higher than without Q (${d2.bid})`);
});

test("decide penalizes bid on duplicate awkward consonants", () => {
  const rackWithZ = new Map([["Z", 1], ["A", 1], ["T", 1]]);
  const rackNormal = new Map([["C", 1], ["A", 1], ["T", 1]]);

  const dWithZ = decide(makeInput({ rack: rackWithZ, letter: "J" }));
  const dNormal = decide(makeInput({ rack: rackNormal, letter: "J" }));
  assert.ok(dNormal.bid >= dWithZ.bid, `Bid on J with Z already (${dWithZ.bid}) should be <= bid on J without Z (${dNormal.bid})`);
});
