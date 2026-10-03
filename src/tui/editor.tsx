import { join } from "node:path";
import { existsSync } from "node:fs";
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { applyChanges, type Change } from "../apply.ts";
import { person as personState, team as teamState } from "../extract.ts";
import type { Obj } from "../graph.ts";
import { SPONSOR_SLOTS, type TeamState } from "../league-types.ts";
import { Save, type PartType } from "../model.ts";
import { defaultSavesDir } from "../paths.ts";
import { compareSaves } from "../save-compare.ts";
import type { Shell } from "./app.tsx";
import { Hints } from "./components.tsx";
import { loadSave } from "./data.ts";
import { TeamList, useTeamRows, type TeamRow } from "./teams.tsx";
import { C, fit, gameDate, money, moneyShort, S } from "./theme.ts";

interface ScreenProps { shell: Shell; active: boolean; height: number; width: number }

const TABS = ["Overview", "HQ", "Staff", "Parts", "Sponsors"] as const;
type Tab = (typeof TABS)[number];

/** One queued edit: the toolkit change it becomes, what it touches (for markers), and a label. */
interface Pending { change: Change; teamID: number; target: string; label: string }

// Pending edits survive switching screens; they belong to one save file.
const store = { path: "", items: [] as Pending[], subs: new Set<() => void>() };
const emit = () => { for (const f of store.subs) f(); };
const subscribe = (f: () => void) => { store.subs.add(f); return () => { store.subs.delete(f); }; };
const setItems = (items: Pending[]) => { store.items = items; emit(); };

interface Row {
  key: string;
  cells: ReactNode;
  /** [key, label, run]; the first runs on Enter too. */
  actions: [string, string, () => void][];
}

/** Edit the selected save: every edit is a toolkit change, previewed and then written to a new save. */
export function Editor({ shell, active, height, width }: ScreenProps) {
  const [save, setSave] = useState<Save | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = shell.save;
  useEffect(() => {
    setSave(null); setError(null);
    if (!file) return;
    const t = setTimeout(() => { try { setSave(loadSave(file.path, file.modified)); } catch (e) { setError((e as Error).message); } }, 60);
    return () => clearTimeout(t);
  }, [file?.path, file?.modified.getTime()]);
  if (!file) return <Text color={C.dim}>Pick a save first (2).</Text>;
  if (error) return <Text color={C.bad}>{S.cross} {error}</Text>;
  if (!save) return <Text color={C.dim}>{S.clock} Reading {file.shown}…</Text>;
  return <Loaded key={file.path} shell={shell} save={save} active={active} height={height} width={width} />;
}

function Loaded({ shell, save, active, height, width }: ScreenProps & { save: Save }) {
  const file = shell.save!;
  const items = useSyncExternalStore(subscribe, () => store.items);
  // Edits queued on another save don't apply to this one.
  useEffect(() => { if (store.path !== file.path) { store.path = file.path; setItems([]); } }, [file.path]);

  const rows = useTeamRows(save, shell.series);
  const [filter, setFilter] = useState("");
  const shown = rows.filter((r) => !filter || `${r.name} ${r.champ}`.toLowerCase().includes(filter.toLowerCase()));
  const [sel, setSel] = useState(() => Math.max(0, shown.findIndex((r) => r.member)));
  const [focus, setFocus] = useState<"teams" | "rows">("teams");
  const [tab, setTab] = useState<Tab>("Overview");
  const [rowSel, setRowSel] = useState(0);
  const cur = shown[Math.min(sel, shown.length - 1)];
  const state = useMemo<TeamState | null>(() => {
    if (!cur) return null;
    try { return teamState(save, cur.t, save.g.deref<Obj>(cur.t.championship), cur.member); } catch { return null; }
  }, [save, cur?.t]);
  const freeAgents = useMemo(() => save.people().filter((p) => save.isFreeAgent(p)).map((p) => personState(save, p)), [save]);

  const add = (p: Omit<Pending, "teamID">) => { setItems([...store.items, { ...p, teamID: cur!.id }]); shell.log(`${S.pointer} queued: ${cur!.name}: ${p.label}`); };
  const pendingFor = (target: string) => items.filter((i) => i.teamID === cur?.id && i.target === target).map((i) => i.label);
  const ask = (title: string, value: string, onSubmit: (v: string) => void, opts: { lines?: string[]; validate?: (v: string) => string | null } = {}) =>
    shell.modal({ kind: "input", title, value, lines: opts.lines, validate: opts.validate, onSubmit });

  const tabRows: Row[] = cur && state ? rowsFor(tab, cur, state, save, freeAgents, { add, ask, shell, items }) : [];
  const row = tabRows[Math.min(rowSel, tabRows.length - 1)];

  const write = async () => {
    if (!items.length) return shell.modal({ kind: "info", tone: "warn", title: "Nothing to write", lines: ["Queue some edits first."] });
    const changes = items.map((i) => i.change);
    const r = await shell.heavy("Applying the edits to a fresh copy", () => {
      const fresh = Save.load(file.path);
      const log = applyChanges(fresh, { changes });
      return { fresh, log, cmp: compareSaves(save, fresh) };
    });
    if (!r) return;
    for (const l of r.log) shell.log(`  ${l}`, "dim");
    const lines: string[] = [];
    for (const t of r.cmp.teams) for (const c of t.changes) lines.push(`${t.name} · ${c.area}: ${c.text}`);
    const shownLines = lines.slice(0, 16);
    if (lines.length > shownLines.length) shownLines.push(`… ${lines.length - shownLines.length} more (all in the log)`);
    for (const l of lines) shell.log(`  ${l}`);
    shell.modal({
      kind: "confirm", title: `${S.apply} ${items.length} edit${items.length > 1 ? "s" : ""}: this is what changes`, yes: "choose a name and write",
      lines: [...(shownLines.length ? shownLines : ["(no change the per-team comparison shows: names of people, countries… see the log)"]), "", "Your save stays as it is; this writes a new one."],
      onYes: () => ask(`${S.save} Name of the new save`, `${file.name} (edited)`, (name) => {
        void shell.heavy("Writing the new save", () => {
          r.fresh.file.header.saveInfo.name = name;
          r.fresh.file.header.saveInfo.isAutoSave = false;
          const out = join(defaultSavesDir(), `Save${name}.sav`);
          r.fresh.write(out);
          return out;
        }).then((out) => {
          if (!out) return;
          shell.log(`${S.check} wrote ${out}`, "ok");
          setItems([]);
          shell.rescanSaves();
          shell.modal({ kind: "info", tone: "ok", title: `${S.check} Written`, lines: [`Save${name}.sav is in the saves folder ("${name}" in MM's load menu).`, "Pick it on the Saves screen (2) to keep working on it."] });
        });
      }, {
        lines: ["MM's load menu shows this name; the file is Save<name>.sav in the saves folder."],
        validate: (v) => (!v ? "Give it a name" : v === file.name ? "That's the save you're editing" : existsSync(join(defaultSavesDir(), `Save${v}.sav`)) ? `"Save${v}.sav" already exists` : null),
      }),
    });
  };

  useInput((input, key) => {
    if (input === "w") return void write();
    if (input === "u" && items.length) { shell.log(`undone: ${items.at(-1)!.label}`, "warn"); return setItems(items.slice(0, -1)); }
    if (focus === "teams") {
      if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(shown.length - 1, s + 1));
      else if (key.return || key.rightArrow) { setFocus("rows"); setRowSel(0); }
      else if (input === "/") shell.modal({ kind: "input", title: "Filter teams", value: filter, placeholder: "team or championship", onSubmit: (v) => { setFilter(v); setSel(0); } });
      else if (input === "m") {
        const i = shown.findIndex((r, j) => j > sel && r.member);
        const k = i >= 0 ? i : shown.findIndex((r) => r.member);
        if (k >= 0) setSel(k);
      }
    } else {
      if (key.escape) setFocus("teams");
      else if (key.upArrow) setRowSel((n) => Math.max(0, n - 1));
      else if (key.downArrow) setRowSel((n) => Math.min(tabRows.length - 1, n + 1));
      else if (key.leftArrow || key.rightArrow) {
        const i = TABS.indexOf(tab) + (key.rightArrow ? 1 : -1);
        setTab(TABS[(i + TABS.length) % TABS.length]); setRowSel(0);
      } else if (row) {
        const a = key.return ? row.actions[0] : row.actions.find(([k]) => k === input);
        a?.[2]();
      }
    }
  }, { isActive: active });

  const listW = 34;
  const pendH = Math.min(8, Math.max(3, items.length + 3)); // borders, title, one line per edit
  const bodyH = height - 2 - pendH;
  const rowsH = bodyH - 3;
  const start = Math.max(0, Math.min(rowSel - Math.floor(rowsH / 2), tabRows.length - rowsH));
  const marks = new Map<number, string>();
  for (const i of items) marks.set(i.teamID, `✎${items.filter((x) => x.teamID === i.teamID).length}`);

  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        <Text bold>{S.part} Editor</Text>
        <Text color={C.dim}> · {file.shown} · {gameDate(save.now)} · edits become toolkit changes, previewed, then written to a new save</Text>
      </Text>
      <Box height={bodyH}>
        <TeamList rows={shown} sel={sel} height={bodyH - 2} width={listW} focused={active && focus === "teams"} marks={marks} />
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={active && focus === "rows" ? C.focus : C.border} paddingX={1} overflow="hidden">
          <Box columnGap={2} flexShrink={0}>
            {TABS.map((t) => <Text key={t} inverse={t === tab} bold={t === tab} color={t === tab ? C.accent : C.dim}> {t} </Text>)}
          </Box>
          {tabRows.slice(start, start + rowsH).map((r, i) => {
            const on = focus === "rows" && start + i === rowSel;
            const pend = pendingFor(r.key);
            return (
              <Text key={r.key} wrap="truncate-end" inverse={on}>
                {on ? S.pointer : " "} {r.cells}{pend.length ? <Text color={C.warn}>  ✎ {pend.join("; ")}</Text> : null}
              </Text>
            );
          })}
          {!tabRows.length && <Text color={C.dim}>Nothing to edit here.</Text>}
          <Box flexGrow={1} />
          <Text color={C.dim} wrap="truncate-end">{focus === "rows" && row ? row.actions.map(([k, l], i) => `${i === 0 ? "Enter/" : ""}${k} ${l}`).join("   ") : "Enter: edit this team"}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" height={pendH} borderStyle="round" borderColor={items.length ? C.warn : C.border} paddingX={1} overflow="hidden">
        <Text bold color={items.length ? C.warn : C.dim}>✎ Pending edits ({items.length}){items.length ? <Text color={C.dim} bold={false}>  w preview & write · u undo last</Text> : null}</Text>
        {items.slice(-(pendH - 3)).map((i, k) => (
          <Text key={k} wrap="truncate-end">{rows.find((r) => r.id === i.teamID)?.name ?? i.teamID}: {i.label}</Text>
        ))}
      </Box>
      <Hints items={focus === "teams"
        ? [["↑↓", "team"], ["Enter", "edit"], ["m", "next member"], ["/", "filter"], ["w", "write"], ["u", "undo"]]
        : [["↑↓", "row"], ["←→", "tab"], ["Enter", "change"], ["Esc", "teams"], ["w", "write"], ["u", "undo"]]} />
    </Box>
  );
}

interface Tools {
  add: (p: Omit<Pending, "teamID">) => void;
  ask: (title: string, value: string, onSubmit: (v: string) => void, opts?: { lines?: string[]; validate?: (v: string) => string | null }) => void;
  shell: Shell;
  items: Pending[];
}

const KIND_OF_JOB: Record<string, string> = { Driver: "Driver", EngineerLead: "Engineer", Mechanic: "Mechanic" };
const avg = (s: Record<string, number | null>) => { const v = Object.values(s).filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };

function rowsFor(tab: Tab, r: TeamRow, t: TeamState, save: Save, freeAgents: ReturnType<typeof personState>[], x: Tools): Row[] {
  const team = r.name;
  const amount = (s: string) => Number(s.replace(/[$,\s_]/g, "").replace(/m$/i, "e6").replace(/k$/i, "e3"));
  switch (tab) {
    case "Overview": {
      const nat = r.t.nationality ? save.g.deref<Obj>(r.t.nationality)?.mCountryKey : "—";
      return [
        { key: "budget", cells: <>{fit("Budget", 18)}<Text color={C.money}>{money(t.budget)}</Text></>, actions: [["b", "set budget", () => x.ask("Budget", String(t.budget ?? 0), (v) => {
          const n = Math.round(amount(v));
          x.add({ target: "budget", label: `budget ${moneyShort(n)}`, change: { op: "setBudget", team: r.id, amount: n, reason: "Editor" } });
        }, { lines: ["A number; 42m, 500k and 42,000,000 work too. The difference shows in MM's finance history."], validate: (v) => (Number.isFinite(amount(v)) ? null : "Not an amount") })]] },
        { key: "name", cells: <>{fit("Name", 18)}{t.name} <Text color={C.dim}>({String(r.t.mShortName ?? "")})</Text></>, actions: [["n", "rename", () => x.ask("Full name", t.name, (full) => x.ask("Short name (standings, timing)", String(r.t.mShortName ?? full), (short) => {
          x.add({ target: "name", label: `name ${full} (${short})`, change: { op: "renameTeam", team: r.id, name: full, shortName: short } });
        }), { validate: (v) => (v ? null : "Give a name") })]] },
        { key: "country", cells: <>{fit("Licence country", 18)}{nat}</>, actions: [["c", "change", () => x.ask("Licence country (a country key, e.g. UK, Italy, UnitedStates)", String(nat ?? ""), (v) => {
          x.add({ target: "country", label: `licence ${v}`, change: { op: "setTeamCountry", team: r.id, nationality: v } });
        })]] },
      ];
    }
    case "HQ":
      return [...t.hq].sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({
        key: `hq:${b.type}`,
        cells: <>{fit(b.name, 30)} {fit(b.level ? `level ${b.level}/${b.maxLevel}` : "not built", 16)}<Text color={C.dim}>{b.state === "BuildingInProgress" || b.state === "Upgrading" ? `building, done ${gameDate(b.progressEnd)}` : ""}</Text></>,
        actions: [["l", "set level", () => x.ask(`${b.name}: level (0 = not built, max ${b.maxLevel})`, String(b.level), (v) => {
          const level = Number(v);
          x.add({ target: `hq:${b.type}`, label: `${b.name} level ${level}`, change: { op: "setBuilding", team: r.id, building: b.type, level } });
        }, { lines: ["Sets the building straight to that level, finished (no construction time, no cost)."], validate: (v) => (/^\d+$/.test(v) && Number(v) <= b.maxLevel ? null : `0 to ${b.maxLevel}`) })]],
      }));
    case "Staff":
      return t.staff.map((s) => {
        const kind = KIND_OF_JOB[s.job] ?? s.job;
        const hireRun = () => {
          const pool = freeAgents.filter((p) => p.kind === kind).sort((a, b) => avg(b.stats) - avg(a.stats));
          if (!pool.length) return x.shell.modal({ kind: "info", tone: "warn", title: `No free agent ${kind.toLowerCase()}s`, lines: ["Nobody to sign."] });
          x.shell.modal({
            kind: "pick", title: `Sign a free agent ${kind.toLowerCase()} for ${team}${s.person ? `, replacing ${s.person.name}` : ""}`,
            items: pool.map((p) => ({ label: p.name, value: p.guid, hint: `avg ${avg(p.stats).toFixed(1)} · born ${p.dateOfBirth.slice(0, 4)} · ${p.nationality ?? ""}` })),
            onPick: (guid) => {
              const p = pool.find((q) => q.guid === guid)!;
              x.add({ target: `staff:${s.slotID}`, label: `sign ${p.name}${s.person ? ` for ${s.person.name}` : ""}`,
                change: s.person ? { op: "hire", team: r.id, person: guid, replacing: s.person.guid } : { op: "hire", team: r.id, person: guid, slotID: s.slotID } });
            },
          });
        };
        const actions: Row["actions"] = [["h", "sign a free agent", hireRun]];
        if (s.person) {
          actions.push(["n", "rename", () => x.ask(`New name for ${s.person!.name} (first and last)`, s.person!.name, (v) => {
            const [first, ...rest] = v.split(" ");
            x.add({ target: `staff:${s.slotID}`, label: `rename ${s.person!.name} → ${v}`, change: { op: "renamePerson", team: r.id, slotID: s.slotID, firstName: first, lastName: rest.join(" ") } });
          }, { validate: (v) => (v.trim().includes(" ") ? null : "First and last name") })]);
        }
        return {
          key: `staff:${s.slotID}`,
          cells: <><Text color={C.accent2}>{fit(kind, 9)}</Text> {fit(s.person?.name ?? "vacant", 26)}<Text color={C.dim}>{s.person ? `avg ${avg(s.person.stats).toFixed(1)} · ${moneyShort(s.person.contract.yearlyWages)}/yr` : ""}</Text></>,
          actions,
        };
      });
    case "Parts":
      return Object.entries(t.parts).flatMap(([type, parts]) => parts.map((p) => ({
        key: `part:${p.guid}`,
        cells: <>{fit(type, 11)} {fit(p.name, 10)} <Text color={C.dim}>lvl {p.level} · {(p.stat ?? 0).toFixed(1)}+{(p.performance ?? 0).toFixed(1)} · rel {p.reliability == null ? "—" : `${Math.round(p.reliability * 100)}%`}</Text> {p.fittedToCar != null ? <Text color={C.ok}>car {p.fittedToCar + 1}</Text> : ""}</>,
        actions: [
          ["f", "fit to a car", () => x.shell.modal({
            kind: "pick", title: `Fit ${p.name} to`, items: [{ label: "Car 1", value: "0" }, { label: "Car 2", value: "1" }],
            onPick: (c) => x.add({ target: `part:${p.guid}`, label: `fit ${p.name} to car ${Number(c) + 1}`, change: { op: "fitPart", team: r.id, type: type as PartType, part: p.guid, car: Number(c) as 0 | 1 } }),
          })],
          ["x", "remove", () => x.shell.modal({
            kind: "confirm", title: `Remove ${type} ${p.name} from ${team}?`, yes: "queue removal", lines: p.fittedToCar != null ? [`It's on car ${p.fittedToCar + 1}: fit another ${type} there too.`] : [],
            onYes: () => x.add({ target: `part:${p.guid}`, label: `remove ${p.name}`, change: { op: "removePart", team: r.id, type: type as PartType, part: p.guid } }),
          })],
        ] as Row["actions"],
      })));
    case "Sponsors": {
      const sp = t.sponsorship;
      if (!sp) return [];
      const deals: Row[] = sp.deals.map((d) => ({
        key: `sponsor:${d.slot}`,
        cells: <>{fit(SPONSOR_SLOTS[d.slot], 11)} {fit(d.sponsor, 24)}<Text color={C.dim}>{d.bonus ? `${moneyShort(d.bonus)} for P${d.bonusTarget}` : `${moneyShort(d.perRace)}/race`} · {d.left}/{d.length} months</Text></>,
        actions: [["x", "drop", () => x.add({ target: `sponsor:${d.slot}`, label: `drop ${d.sponsor}`, change: { op: "dropSponsor", team: r.id, slot: d.slot, sponsorId: d.sponsorId } })]],
      }));
      const offers: Row[] = sp.offers.map((o) => ({
        key: `offer:${o.slot}:${o.sponsorId}`,
        cells: <><Text color={C.dim}>offer </Text>{fit(SPONSOR_SLOTS[o.slot], 11)} {fit(o.sponsor, 24)}<Text color={C.dim}>{moneyShort(o.upfront)} upfront · {o.bonus ? `${moneyShort(o.bonus)} for P${o.bonusTarget}` : `${moneyShort(o.perRace)}/race`} · {o.length} months</Text></>,
        actions: [["s", "sign", () => {
          const taken = sp.deals.some((d) => d.slot === o.slot) && !x.items.some((i) => i.teamID === r.id && i.target === `sponsor:${o.slot}` && i.change.op === "dropSponsor");
          if (taken) return x.shell.modal({ kind: "info", tone: "warn", title: `${SPONSOR_SLOTS[o.slot]} has a sponsor`, lines: ["Drop that deal first (x on it), then sign."] });
          x.add({ target: `sponsor:${o.slot}`, label: `sign ${o.sponsor}${o.upfront ? ` (+${moneyShort(o.upfront)} upfront)` : ""}`, change: { op: "signSponsor", team: r.id, slot: o.slot, sponsorId: o.sponsorId } });
          if (o.upfront) x.add({ target: `sponsor:${o.slot}`, label: `${o.sponsor} upfront payment`, change: { op: "adjustBudget", team: r.id, delta: o.upfront, reason: `${o.sponsor} - Upfront payment` } });
        }]],
      }));
      return [...deals, ...offers];
    }
  }
}
