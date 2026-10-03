#!/usr/bin/env -S npx tsx
// The toolkit's terminal UI: `npm run tui` in the toolkit folder (where the league-*.json files are).
import { render } from "ink";
import { App } from "./app.tsx";

if (!process.stdin.isTTY) {
  console.error("The TUI needs an interactive terminal. For scripts, use the CLI: npx tsx src/cli.ts");
  process.exit(1);
}

const app = render(<App />, { alternateScreen: true, exitOnCtrlC: true });
await app.waitUntilExit();
