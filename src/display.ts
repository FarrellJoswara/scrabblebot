// Clean terminal dashboard for ScrabbleBot to prevent terminal flooding.

export interface DashboardState {
  botName: string;
  botId: bigint | null;
  status: string;
  matchId: bigint | null;
  score: number;
  balance: number;
  rack: Map<string, number>;
  lastWord: string | null;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function padLine(content: string, width: number): string {
  const visibleLen = stripAnsi(content).length;
  const padding = Math.max(0, width - visibleLen);
  return content + " ".repeat(padding);
}

class Dashboard {
  private state: DashboardState = {
    botName: "bot",
    botId: null,
    status: "Connecting...",
    matchId: null,
    score: 0,
    balance: 0,
    rack: new Map(),
    lastWord: null,
  };

  private logs: string[] = [];
  private maxLogs = 8;
  private renderScheduled = false;
  private isTTY = Boolean(process.stdout.isTTY);

  init(botName: string) {
    this.state.botName = botName;
    this.scheduleRender();
  }

  update(partial: Partial<DashboardState>) {
    Object.assign(this.state, partial);
    this.scheduleRender();
  }

  log(msg: string) {
    const time = new Date().toTimeString().split(" ")[0];
    const line = `[${time}] ${msg}`;
    if (!this.isTTY) {
      console.log(line);
      return;
    }
    this.logs.push(line);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.scheduleRender();
  }

  warn(msg: string) {
    this.log(`⚠️ ${msg}`);
  }

  private scheduleRender() {
    if (!this.isTTY || this.renderScheduled) return;
    this.renderScheduled = true;
    setTimeout(() => {
      this.renderScheduled = false;
      this.render();
    }, 40);
  }

  render() {
    if (!this.isTTY) return;

    // Format rack tiles sorted
    const tiles: string[] = [];
    for (const [letter, count] of this.state.rack.entries()) {
      for (let i = 0; i < count; i++) tiles.push(letter);
    }
    tiles.sort();
    const rackStr = tiles.length > 0 ? `[ ${tiles.join(" ")} ]` : "(empty)";

    const idStr = this.state.botId !== null ? String(this.state.botId) : "–";
    const matchStr = this.state.matchId !== null ? `#${this.state.matchId}` : "None";

    const width = 68;
    const border = "─".repeat(width);

    const rows: string[] = [];
    rows.push(`\x1b[1;36m┌${border}┐\x1b[0m`);
    
    // Header
    const title = `  \x1b[1;37mScrabbleBot\x1b[0m \x1b[90m│\x1b[0m Bot: \x1b[1;33m${this.state.botName}\x1b[0m (ID: ${idStr})`;
    rows.push(`\x1b[1;36m│\x1b[0m${padLine(title, width)}\x1b[1;36m│\x1b[0m`);

    const statusLine = `  Status: \x1b[1;32m${this.state.status}\x1b[0m \x1b[90m│\x1b[0m Match: \x1b[1;35m${matchStr}\x1b[0m`;
    rows.push(`\x1b[1;36m│\x1b[0m${padLine(statusLine, width)}\x1b[1;36m│\x1b[0m`);

    rows.push(`\x1b[1;36m├${border}┤\x1b[0m`);

    // Match Stats
    const statsLine = `  Score: \x1b[1;32m${this.state.score}\x1b[0m pts  \x1b[90m│\x1b[0m  Coins: \x1b[1;33m${this.state.balance}\x1b[0m  \x1b[90m│\x1b[0m  Rack: \x1b[1;37m${rackStr}\x1b[0m`;
    rows.push(`\x1b[1;36m│\x1b[0m${padLine(statsLine, width)}\x1b[1;36m│\x1b[0m`);

    const wordLine = `  Last Word: ${this.state.lastWord ? `\x1b[1;32m"${this.state.lastWord}"\x1b[0m` : "\x1b[90m(none yet)\x1b[0m"}`;
    rows.push(`\x1b[1;36m│\x1b[0m${padLine(wordLine, width)}\x1b[1;36m│\x1b[0m`);

    rows.push(`\x1b[1;36m├${border}┤\x1b[0m`);
    rows.push(`\x1b[1;36m│\x1b[0m${padLine("  \x1b[1;37mRecent Activity (latest events):\x1b[0m", width)}\x1b[1;36m│\x1b[0m`);

    // Activity Logs
    for (let i = 0; i < this.maxLogs; i++) {
      const rawLog = this.logs[i] || "";
      const displayLog = rawLog.length > width - 6 ? rawLog.slice(0, width - 9) + "..." : rawLog;
      const formatted = displayLog ? `  \x1b[90m${displayLog}\x1b[0m` : "";
      rows.push(`\x1b[1;36m│\x1b[0m${padLine(formatted, width)}\x1b[1;36m│\x1b[0m`);
    }

    rows.push(`\x1b[1;36m└${border}┘\x1b[0m`);

    // \x1b[H moves cursor to top-left, \x1b[J clears below without screen flicker
    process.stdout.write(`\x1b[H${rows.join("\n")}\x1b[J\n`);
  }
}

export const display = new Dashboard();

