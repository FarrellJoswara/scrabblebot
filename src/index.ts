// ScrabbleBot bot starter.
//
// First run, with a token from the website:
//   On your team's page, click "Generate token", then run
//   `BOT_NAME=<name> BOT_TOKEN=<token> npm start`.
//
// Or with a nonce from the CLI:
//   1. `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. `BOT_NAME=<name> BOT_NONCE=<code> npm start`
//      The bot connects fresh and redeems the nonce.
//
// Either way the bot saves its token to .token-<BOT_NAME>, so later runs
// need only `BOT_NAME=<name> npm start`.
//
// Entering a tournament: `BOT_NAME=<name> TOURNAMENT_ID=<id> npm start`
// registers the bot for that tournament when it connects. Only the bot
// itself can register, so this has to come from the bot's process.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseWord, decideBid } from "./strategy.js";
import { display } from "./display.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const dictionaryPath = path.join(currentDir, "..", "spacetimedb", "wordlist.txt");
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2)
  : [];
DICTIONARY.sort((a, b) => b.length - a.length); // longest first for greedy pick

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const lastWordAttemptByMatch = new Map<string, number>();
const WORD_RETRY_MS = 500;

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function getActiveMatchId(conn: DbConnection): bigint | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") return p.matchId;
  }
  return null;
}

function syncDashboard(conn: DbConnection) {
  const matchId = getActiveMatchId(conn);
  if (matchId !== null) {
    const participant = participantForMatch(conn, matchId);
    const rack = rackForMatch(conn, matchId);
    display.update({
      status: "In Match",
      matchId,
      score: participant?.score ?? 0,
      balance: participant?.balance ?? 0,
      rack,
    });
  } else {
    display.update({
      status: "In Lobby / Waiting",
      matchId: null,
      rack: new Map(),
    });
  }
}

function rackForMatch(
  conn: DbConnection,
  matchId: bigint,
): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// A reducer call fails when the module refuses it, often for an expected
// reason: a word played just after its match ended, a bid that missed the
// auction's window. Log it and keep playing; an uncaught failure would stop
// the bot.
function logFailure(what: string) {
  return (err: unknown) =>
    display.warn(
      `${what} failed: ${err instanceof Error ? err.message : err}`,
    );
}

function tryBid(
  conn: DbConnection,
  auctionId: bigint,
  matchId: bigint,
  letter: string,
) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const amount = decideBid({
    letter,
    myBalance: participant.balance,
    myRack: rackForMatch(conn, matchId),
  });
  if (amount <= 0) return;
  conn.reducers
    .submitBid({ auctionId, amount: BigInt(amount) })
    .catch(logFailure(`bid on auction ${auctionId}`));
  bidsByAuction.add(key);
  display.log(`Bid ${amount} on '${letter}' (match ${matchId})`);
  syncDashboard(conn);
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  // Only matches still being played. The bot keeps its letters from
  // matches that have ended, but can't play them.
  const matches = new Set<bigint>();
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const m = conn.db.matchState.id.find(p.matchId);
    if (m?.status.tag === "Running") matches.add(p.matchId);
  }
  const now = Date.now();
  for (const matchId of matches) {
    const key = String(matchId);
    if (now - (lastWordAttemptByMatch.get(key) ?? 0) < WORD_RETRY_MS) continue;
    lastWordAttemptByMatch.set(key, now);
    const word = chooseWord({
      myRack: rackForMatch(conn, matchId),
      dictionary: DICTIONARY,
    });
    if (!word) continue;
    display.update({ lastWord: word });
    display.log(`Match ${matchId}: played '${word}'`);
    conn.reducers
      .submitWord({ matchId, word })
      .catch(logFailure(`playing '${word}'`));
    syncDashboard(conn);
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  display.log(`Connected (${identity.toHexString().slice(0, 10)}…)`);

  const finishConnect = () => {
    // Resolve our bot id, possibly after claiming a nonce.
    myBotId = resolveMyBotId(conn);
    if (myBotId === null) {
      if (BOT_NONCE) {
        display.log("Claiming credential with nonce…");
        conn.reducers
          .claimCredential({ code: BOT_NONCE })
          .catch(logFailure("claiming the credential"));
        // Wait briefly for the credential to land; check again.
        setTimeout(() => {
          myBotId = resolveMyBotId(conn);
          if (myBotId === null) {
            display.warn("Couldn't claim credential. Bad / expired nonce?");
            process.exit(1);
          }
          const bot = conn.db.bot.id.find(myBotId);
          const actualName = bot?.name ?? BOT_NAME;
          display.update({ botName: actualName, botId: myBotId, status: "Ready" });
          display.log(
            `Claimed credential for bot '${actualName}' (id ${myBotId})`,
          );
          bootstrapActivity(conn);
        }, 1000);
        return;
      } else {
        display.warn("No BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.");
        process.exit(1);
      }
    }

    const bot = conn.db.bot.id.find(myBotId);
    const actualName = bot?.name ?? BOT_NAME;
    display.update({ botName: actualName, botId: myBotId, status: "Ready" });
    display.log(`Acting as bot '${actualName}' (id ${myBotId})`);
    bootstrapActivity(conn);
  };

  // Subscribe in two fast phases to avoid downloading millions of historical auctions.
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      display.log("Core tables synced");

      // Find highest match ID so we only replicate active & recent auctions
      let maxMatchId = 0n;
      for (const m of conn.db.matchState.iter()) {
        if (m.id > maxMatchId) maxMatchId = m.id;
      }
      const minMatchId = maxMatchId > 10n ? maxMatchId - 10n : 0n;

      conn
        .subscriptionBuilder()
        .onApplied(() => {
          display.log("Live auctions synced");
          finishConnect();
        })
        .onError((ctx: ErrorContext) => {
          display.warn(`Auction sync error`);
          finishConnect();
        })
        .subscribe([
          `SELECT * FROM auction WHERE match_id >= ${minMatchId}`,
          `SELECT * FROM auction_result WHERE match_id >= ${minMatchId}`,
        ]);
    })
    .onError((ctx: ErrorContext) => {
      display.warn(`Subscription error`);
    })
    .subscribe([
      "SELECT * FROM bot",
      "SELECT * FROM bot_credential",
      "SELECT * FROM match_state",
      "SELECT * FROM match_participant",
      "SELECT * FROM my_rack",
      "SELECT * FROM lobby",
      "SELECT * FROM lobby_member",
    ]);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => {
    syncDashboard(conn);
    tryPlayWord(conn);
  });
  conn.db.myRack.onUpdate(() => {
    syncDashboard(conn);
    tryPlayWord(conn);
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) {
      myBotId = resolveMyBotId(conn);
      if (myBotId !== null) display.update({ botId: myBotId });
    }
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? (r.winnerBotId === myBotId ? "YOU" : `bot ${r.winnerBotId}`)
        : "no-bid";
    display.log(`Auction ${r.auctionId} '${r.letter}' → ${winner} paid ${r.paid}`);
    syncDashboard(conn);
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        display.log(`Match ${neu.id} ended; rejoining lobby`);
        display.update({ status: "Match Ended", matchId: null });
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobbyMember.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) return;
  display.log("Joining open lobby...");
  display.update({ status: "Joining Lobby" });
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        display.log(`Registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  display.init(BOT_NAME);
  display.log(`Connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      display.warn(`Connect error: ${err.message}`),
    )
    .onDisconnect(() => {
      display.update({ status: "Disconnected" });
      display.warn("Disconnected");
    })
    .build();
}

main();
