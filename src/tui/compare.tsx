import { Box, Text, useInput } from "ink";
import { useMemo, useState, type ReactNode } from "react";
import { diffSaves, pathSegments, type DiffEntry } from "../diff.ts";
import { compareSaves, type ChangeArea, type SaveComparison } from "../save-compare.ts";
import type { Shell } from "./app.tsx";
import { Hints, List, useListKeys } from "./components.tsx";
import { loadSave, type SaveEntry } from "./data.ts";
import { ago, C, fit, gameDate, S } from "./theme.ts";

interface ScreenProps { shell: Shell; active: boolean; height: number; width: number }

interface Result {
  from: SaveEntry;
  to: SaveEntry;
  summary: SaveComparison;
  entries: DiffEntry[];
  truncated: boolean;
  teamNames: string[];
}

const AREA_ICONS: Record<ChangeArea, string> = {
  Team: S.team, Budget: S.money, HQ: S.hq, Parts: S.part, Design: S.part, Staff: S.crew, Sponsors: S.sponsor, Standings: S.flag,
};

/** Compare the selected save with another: what changed per team, or every changed field as a tree. */
export function Compare(props: ScreenProps) {
  const [result, setResult] = useState<Result | null>(null);
  if (result) return <Results {...props} result={result} back={() => setResult(null)} />;
  return <PickOther {...props} onResult={setResult} />;
}

function PickOther({ shell, active, height, width, onResult }: ScreenProps & { onResult: (r: Result) => void }) {
  const others = shell.saves.filter((s) => s.path !== shell.save?.path);
  const [sel] = useListKeys(others.length, active, Math.max(1, height - 6));
  const nameW = Math.max(20, width - 36);

  const run = async (other: SaveEntry) => {
    const a = shell.save!;
    // Older first (game date, then when it was saved), so changes read forward in time.
    const older = (x: SaveEntry, y: SaveEntry) => (x.gameTime ?? "") < (y.gameTime ?? "") || ((x.gameTime ?? "") === (y.gameTime ?? "") && x.modified <= y.modified);
    const [from, to] = older(a, other) ? [a, other] : [other, a];
    const r = await shell.heavy(`Comparing ${from.shown} with ${to.shown}`, () => {
      const sa = loadSave(from.path, from.modified), sb = loadSave(to.path, to.modified);
      const d = diffSaves(sa, sb, { maxDepth: 20, limit: 200_000 });
      return { from, to, summary: compareSaves(sa, sb), entries: d.entries, truncated: d.truncated, teamNames: d.roots };
    });
    if (r) {
      shell.log(`Compared ${from.shown} → ${to.shown}: ${r.summary.teams.length} teams changed, ${r.entries.length}${r.truncated ? "+" : ""} fields`);
      onResult(r);
    }
  };

  useInput((_input, key) => {
    if (key.return && others[sel] && shell.save) void run(others[sel]);
  }, { isActive: active });

  if (!shell.save) return <Text color={C.dim}>Pick a save first (2).</Text>;
  return (
    <Box flexDirection="column" height={height}>
      <Text bold wrap="truncate-end">{S.window} Compare <Text color={C.dim}>· {shell.save.shown} ({gameDate(shell.save.gameTime)}) with…</Text></Text>
      <Text color={C.dim}>{"  "}{fit("Save", nameW)} {fit("Game date", 12)} {fit("Saved", 12)}</Text>
      <List items={others} selected={sel} height={height - 4} empty="No other saves."
        render={(s, on) => <Text bold={on}>{fit(s.name, nameW)} {fit(gameDate(s.gameTime), 12)} {fit(ago(s.modified), 12)}</Text>} />
      <Box flexGrow={1} />
      <Hints items={[["↑↓", "move"], ["Enter", "compare"]]} />
    </Box>
  );
}

function Results({ shell, active, height, width, result, back }: ScreenProps & { result: Result; back: () => void }) {
  const [view, setView] = useState<"summary" | "tree">("summary");
  const [treeRoot, setTreeRoot] = useState<string | null>(null);
  useInput((input, key) => {
    if (input === "s") setView("summary");
    if (input === "t") { setView("tree"); setTreeRoot(null); }
    if (key.escape && view === "summary") back();
  }, { isActive: active });
  const { from, to, summary } = result;
  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        <Text bold>{S.window} {from.shown}</Text><Text color={C.dim}> ({gameDate(summary.a.gameDate)})</Text>
        <Text color={C.accent}> {S.arrow} </Text>
        <Text bold>{to.shown}</Text><Text color={C.dim}> ({gameDate(summary.b.gameDate)})</Text>
      </Text>
      <Box columnGap={2}>
        <Text inverse={view === "summary"} color={view === "summary" ? C.accent : C.dim}> s Per team ({summary.teams.length}) </Text>
        <Text inverse={view === "tree"} color={view === "tree" ? C.accent : C.dim}> t Every field ({result.entries.length}{result.truncated ? "+" : ""}) </Text>
        <Text color={C.dim}>free agents {summary.a.freeAgents} → {summary.b.freeAgents}</Text>
      </Box>
      {view === "summary"
        ? <Summary shell={shell} active={active} height={height - 3} width={width} result={result} openTree={(team) => { setTreeRoot(team); setView("tree"); }} />
        : <Tree active={active} height={height - 3} width={width} result={result} root={treeRoot} back={() => setView("summary")} />}
    </Box>
  );
}

function Summary({ active, height, width, result, openTree }: ScreenProps & { result: Result; openTree: (team: string) => void }) {
  const teams = result.summary.teams;
  const [sel] = useListKeys(teams.length, active, 10);
  const [scroll, setScroll] = useState(0);
  const cur = teams[sel];
  useInput((_input, key) => {
    if (key.pageDown) setScroll((s) => s + 10);
    else if (key.pageUp) setScroll((s) => Math.max(0, s - 10));
    else if ((key.return || key.rightArrow) && cur) openTree(cur.fromName);
    else if (key.upArrow || key.downArrow) setScroll(0);
  }, { isActive: active });
  const listW = 36;
  const bodyH = height - 3;
  const changes = cur?.changes ?? [];
  const from = Math.min(scroll, Math.max(0, changes.length - bodyH));
  return (
    <Box flexDirection="column" height={height}>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={listW} flexShrink={0} borderStyle="round" borderColor={C.border} paddingX={1} overflow="hidden">
          <List items={teams} selected={sel} height={bodyH - 1} empty="No team changed."
            render={(t, on) => <Text bold={on} wrap="truncate-end">{fit(t.name, 24)} <Text color={C.dim}>{t.changes.length}</Text></Text>} />
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={active ? C.focus : C.border} paddingX={1} overflow="hidden">
          {cur && <Text bold wrap="truncate-end">{cur.name} <Text color={C.dim}>· {cur.championship}</Text></Text>}
          {changes.slice(from, from + bodyH - 1).map((c, i) => (
            <Text key={i} wrap="truncate-end" color={c.tone === "up" ? C.ok : c.tone === "down" ? C.bad : undefined}>
              <Text color={C.dim}>{AREA_ICONS[c.area]} {fit(c.area, 10)}</Text>{c.text.slice(0, Math.max(10, width - listW - 18))}
            </Text>
          ))}
          {changes.length > bodyH - 1 && <Text color={C.dim}>{from + 1}–{Math.min(changes.length, from + bodyH - 1)} of {changes.length} (PgUp/PgDn)</Text>}
        </Box>
      </Box>
      <Hints items={[["↑↓", "team"], ["PgUp/PgDn", "scroll"], ["Enter", "this team's fields"], ["t", "every field"], ["Esc", "other save"]]} />
    </Box>
  );
}

/** A diff value is JSON text: show strings with their real characters ("V\u00e9lan" → "Vélan"). */
const shown = (v: string | undefined) => (v ?? "").replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));

interface Node { key: string; name: string; children: Map<string, Node>; count: number; entry?: DiffEntry }

function buildTree(entries: DiffEntry[], teamNames: string[]): Node {
  const root: Node = { key: "", name: "", children: new Map(), count: 0 };
  for (const e of entries) {
    let n = root;
    n.count++;
    for (const seg of pathSegments(e.path, teamNames)) {
      let c = n.children.get(seg);
      if (!c) { c = { key: n.key ? `${n.key}.${seg}` : seg, name: seg, children: new Map(), count: 0 }; n.children.set(seg, c); }
      c.count++;
      n = c;
    }
    n.entry = e;
  }
  return root;
}

/** A node with one child shows as one row ("carManager.partInventory"), as file trees do. */
function compress(n: Node): { label: string; node: Node } {
  let label = n.name, cur = n;
  while (!cur.entry && cur.children.size === 1) {
    cur = [...cur.children.values()][0];
    label += cur.name.startsWith("[") ? cur.name : `.${cur.name}`;
  }
  return { label, node: cur };
}

interface Row { depth: number; label: string; node: Node; parent: string | null }

function Tree({ active, height, width, result, root, back }: { active: boolean; height: number; width: number; result: Result; root: string | null; back: () => void }) {
  const tree = useMemo(() => buildTree(result.entries, result.teamNames), [result]);
  const start = root ? tree.children.get(root) ?? tree : tree;
  const [open, setOpen] = useState<Set<string>>(() => new Set(root ? [start.key] : []));
  const rows: Row[] = [];
  const walk = (n: Node, depth: number, parent: string | null) => {
    const { label, node } = compress(n);
    rows.push({ depth, label, node, parent });
    if (open.has(node.key)) for (const c of node.children.values()) walk(c, depth + 1, node.key);
  };
  if (start === tree) for (const c of tree.children.values()) walk(c, 0, null);
  else walk(start, 0, null);
  const [sel, setSel] = useListKeys(rows.length, active, Math.max(1, height - 4));
  const cur = rows[Math.min(sel, rows.length - 1)];

  useInput((input, key) => {
    if (!cur) return;
    if (key.rightArrow || key.return) {
      if (cur.node.children.size) setOpen((o) => new Set(o).add(cur.node.key));
    } else if (key.leftArrow) {
      if (open.has(cur.node.key)) setOpen((o) => { const n = new Set(o); n.delete(cur.node.key); return n; });
      else if (cur.parent != null) setSel(Math.max(0, rows.findIndex((r) => r.node.key === cur.parent)));
    } else if (input === "c") setOpen(new Set());
    else if (input === "e" && cur.node.children.size) {
      // Expand everything under the selection.
      const all = new Set(open);
      const add = (n: Node) => { all.add(n.key); for (const c of n.children.values()) add(c); };
      add(cur.node);
      setOpen(all);
    } else if (key.escape) back();
  }, { isActive: active });

  const valueW = Math.max(16, Math.floor((width - 40) / 2));
  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={active ? C.focus : C.border} paddingX={1} overflow="hidden">
        {result.truncated && <Text color={C.warn}>{S.warn} Stopped at {result.entries.length} fields; the rest of the save isn't listed.</Text>}
        <List items={rows} selected={sel} height={height - 4 - (result.truncated ? 1 : 0)} empty="No differences."
          render={(r, on): ReactNode => {
            const indent = "  ".repeat(r.depth);
            const e = r.node.entry;
            if (e && !r.node.children.size) {
              return (
                <Text wrap="truncate-end" bold={on}>
                  {indent}  {r.label} <Text color={C.dim}>{e.note ?? ""}</Text>
                  {!e.note && <><Text color={C.bad}>{fit(shown(e.a), valueW)}</Text><Text color={C.dim}> {S.arrow} </Text><Text color={C.ok}>{shown(e.b)}</Text></>}
                </Text>
              );
            }
            return (
              <Text wrap="truncate-end" bold={on}>
                {indent}<Text color={C.accent2}>{open.has(r.node.key) ? S.down : S.pointer}</Text> {r.label} <Text color={C.dim}>({r.node.count})</Text>
              </Text>
            );
          }} />
      </Box>
      <Hints items={[["↑↓", "move"], ["→/Enter", "open"], ["←", "close / up"], ["e", "open all below"], ["c", "close all"], ["Esc", "per team"]]} />
    </Box>
  );
}
