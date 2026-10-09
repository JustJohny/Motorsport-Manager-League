import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { circuitTextLines, REAL_CIRCUITS } from "./circuit-names.ts";
import type { Log } from "./commands/common.ts";

/** The league game patch's text file (tools/league-patch, Hooks.OnTextLoaded). */
const TEXT_FILE = "league-text.txt";

/**
 * Put the real circuit names into MM_Data/league-text.txt, keeping every other line. The league game
 * patch applies it as MM loads its texts (restart MM to see it).
 */
export function writeTrackNames(dataDir: string, log: Log) {
  const path = join(dataDir, TEXT_FILE);
  const ours = new Set(Object.keys(REAL_CIRCUITS).map((k) => `~${k}=`));
  const kept = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l && ![...ours].some((p) => l.startsWith(p))) : [];
  const header = "# League toolkit text renames (tools/league-patch): ID=text, or ~old=new for a word in every text.";
  const lines = [...(kept[0]?.startsWith("#") ? [] : [header]), ...kept, ...circuitTextLines()];
  writeFileSync(path, lines.join("\n") + "\n");
  log(`wrote ${Object.keys(REAL_CIRCUITS).length} circuit names into ${path} (needs the league game patch; restart MM)`);
}
