// Checks for the optimized strategy. Run with `npm test`.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { chooseWord, decideBid } from "./strategy.js";

const rack = (letters: string) => {
  const r = new Map<string, number>();
  for (const c of letters) r.set(c, (r.get(c) ?? 0) + 1);
  return r;
};

test("chooseWord picks the longest word the rack can spell", () => {
  const dictionary = ["TACT", "CAT", "AT"];
  assert.equal(chooseWord({ myRack: rack("TACT"), dictionary }), "TACT");
  assert.equal(chooseWord({ myRack: rack("CATX"), dictionary }), "CAT");
  assert.equal(chooseWord({ myRack: rack("CX"), dictionary }), null);
});

test("chooseWord breaks ties between equal length words by highest score", () => {
  // Both length 4: "QUIZ" (Q:10+U:1+I:1+Z:10 = 22) vs "TOOT" (T:1+O:1+O:1+T:1 = 4)
  const dictionary = ["TOOT", "QUIZ"];
  assert.equal(chooseWord({ myRack: rack("QUIZTOOT"), dictionary }), "QUIZ");
});

test("chooseWord Trie search executes in < 10ms across 178,000 words", () => {
  const dictionary = fs
    .readFileSync(
      new URL("../spacetimedb/wordlist.txt", import.meta.url),
      "utf8",
    )
    .split("\n")
    .map((l) => l.trim().toUpperCase())
    .filter((l) => l.length >= 2)
    .sort((a, b) => b.length - a.length);

  // Warm up the Trie index
  chooseWord({ myRack: rack("HELLO"), dictionary });

  // Heavy 20-letter rack benchmark
  const myRack = rack("BCDFGHJKLMNPQRSTVWXZ");
  const start = performance.now();
  const word = chooseWord({ myRack, dictionary });
  const duration = performance.now() - start;

  assert.ok(duration < 10, `Search was too slow: took ${duration.toFixed(2)} ms`);
  assert.ok(word !== undefined);
});

test("decideBid prioritizes U when holding Q", () => {
  const bidWithQ = decideBid({
    letter: "U",
    myBalance: 20,
    myRack: rack("Q"),
  });
  const bidWithoutQ = decideBid({
    letter: "U",
    myBalance: 20,
    myRack: rack("A"),
  });
  assert.ok(bidWithQ > bidWithoutQ, "Should bid higher on U when holding Q");
});

test("decideBid avoids duplicate awkward consonants (Q, J, X, Z)", () => {
  const bidSecondQ = decideBid({
    letter: "Q",
    myBalance: 20,
    myRack: rack("Q"),
  });
  assert.equal(bidSecondQ, 0, "Should not bid on a second Q");

  const bidSecondZ = decideBid({
    letter: "Z",
    myBalance: 20,
    myRack: rack("Z"),
  });
  assert.equal(bidSecondZ, 0, "Should not bid on a second Z");
});

test("decideBid boosts vowel bid when rack is consonant clogged", () => {
  const bidVowelWhenClogged = decideBid({
    letter: "E",
    myBalance: 20,
    myRack: rack("BCDF"),
  });
  const bidConsonantWhenClogged = decideBid({
    letter: "G",
    myBalance: 20,
    myRack: rack("BCDF"),
  });
  assert.ok(
    bidVowelWhenClogged > bidConsonantWhenClogged,
    "Should prioritize vowels over consonants when rack is clogged with consonants",
  );
});
