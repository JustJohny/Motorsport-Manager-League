import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import { useState, useSyncExternalStore } from "react";
import type { Shell } from "./app.tsx";
import { argv, COMMANDS, commandLine, filesFor, missing, type CommandSpec, type Field, type Values } from "./commands.ts";
import { Hints } from "./components.tsx";
import { ago, C, fit, gameDate, S } from "./theme.ts";

interface ScreenProps { shell: Shell; active: boolean; height: number; width: number }

interface Run {
  command: string;
  lines: string[];
  status: "running" | "ok" | "failed" | "stopped";
  code?: number | null;
  started: Date;
  ended?: Date;
}

// The running command and the forms outlive the screen: switching to another screen and back keeps
// both, and a command keeps running meanwhile. The child is stopped when the TUI exits.
const store = { cmd: 0, stopping: false, run: null as Run | null, child: null as ChildProcess | null, values: {} as Record<string, Values>, subs: new Set<() => void>() };
const emit = () => { for (const f of store.subs) f(); };
const subscribe = (f: () => void) => { store.subs.add(f); return () => { store.subs.delete(f); }; };
process.on("exit", () => store.child?.kill());

const tsxBin = () => {
  const local = join(process.cwd(), "node_modules", ".bin", "tsx");
  return existsSync(local) ? { cmd: local, pre: [] as string[] } : { cmd: "npx", pre: ["tsx"] };
};

/** Every CLI command as a form; runs `src/cli.ts` as a child process and streams its output. */
export function Launcher({ shell, active, height, width }: ScreenProps) {
  const [cmdSel, setCmdSelState] = useState(store.cmd);
  const setCmdSel = (f: (n: number) => number) => setCmdSelState((n) => (store.cmd = f(n)));
  const [focus, setFocus] = useState<"list" | "form">("list");
  const [fieldSel, setFieldSel] = useState(0);
  const ctx = { series: shell.series, save: shell.save };
  const values = useSyncExternalStore(subscribe, () => store.values);
  const run = useSyncExternalStore(subscribe, () => store.run);
  const setValues = (f: (all: Record<string, Values>) => Record<string, Values>) => { store.values = f(store.values); emit(); };
  const setRun = (f: Run | null | ((cur: Run | null) => Run | null)) => { store.run = typeof f === "function" ? f(store.run) : f; emit(); };
  const [outScroll, setOutScroll] = useState(0);
  const child = { get current() { return store.child; }, set current(c: ChildProcess | null) { store.child = c; } };
  const spec = COMMANDS[cmdSel];
  const v: Values = values[spec.name] ?? spec.defaults(ctx);
  const field = spec.fields[Math.min(fieldSel, spec.fields.length - 1)];

  const set = (key: string, val: string | boolean) => setValues((all) => ({ ...all, [spec.name]: { ...v, [key]: val } }));

  const edit = (f: Field) => {
    if (f.kind === "flag") return set(f.key, !v[f.key]);
    if (f.kind === "save") {
      return shell.modal({
        kind: "pick", title: `${S.save} ${f.label}`, selected: String(v[f.key] ?? ""),
        items: shell.saves.map((s) => ({ label: s.name, value: s.path, hint: `${gameDate(s.gameTime)} · ${ago(s.modified)}` })),
        onPick: (p) => set(f.key, p),
      });
    }
    if (f.kind === "file") {
      const files = filesFor(f.pattern);
      if (!files.length) return shell.modal({ kind: "info", tone: "warn", title: `No ${f.label.toLowerCase()} found`, lines: [`Nothing in the toolkit folder matches ${f.pattern}.`] });
      return shell.modal({
        kind: "pick", title: f.label, selected: String(v[f.key] ?? ""),
        items: files.map((x) => ({ label: x.name, value: x.name, hint: ago(x.modified) })),
        onPick: (name) => set(f.key, name),
      });
    }
    shell.modal({
      kind: "input", title: f.label, value: String(v[f.key] ?? ""), lines: f.help ? [f.help] : undefined,
      validate: (s) => (f.kind === "number" && s && !/^\d+$/.test(s) ? "A whole number" : null),
      onSubmit: (s) => set(f.key, s),
    });
  };

  const start = (s: CommandSpec, vals: Values) => {
    const args = argv(s, vals);
    const line = commandLine(s, vals);
    const { cmd, pre } = tsxBin();
    shell.log(`$ ${line}`, "dim");
    const r: Run = { command: line, lines: [], status: "running", started: new Date() };
    setRun(r); setOutScroll(0);
    const p = spawn(cmd, [...pre, "src/cli.ts", ...args], { cwd: process.cwd(), env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    child.current = p;
    const lines: string[] = [];
    let partial = "";
    const take = (chunk: Buffer) => {
      const text = partial + chunk.toString("utf8");
      const parts = text.split("\n");
      partial = parts.pop() ?? "";
      const fresh = parts.filter((l) => !/^npm notice/.test(l));
      lines.push(...fresh);
      for (const l of fresh) shell.log(l);
      setRun((cur) => (cur && cur.started === r.started ? { ...cur, lines: [...lines] } : cur));
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.on("close", (code, signal) => {
      if (partial) { lines.push(partial); shell.log(partial); }
      child.current = null;
      // tsx passes the signal on as exit code 143, so remember that Esc asked for it.
      const status: Run["status"] = signal || store.stopping ? "stopped" : code === 0 ? "ok" : "failed";
      store.stopping = false;
      shell.log(`${status === "ok" ? S.check : S.cross} ${s.name} ${status === "ok" ? "finished" : status === "stopped" ? "stopped" : `failed (exit ${code})`}`, status === "ok" ? "ok" : "bad");
      setRun((cur) => (cur && cur.started === r.started ? { ...cur, lines: [...lines], status, code, ended: new Date() } : cur));
      if (status === "ok" && s.writesSave) shell.rescanSaves();
    });
    p.on("error", (e) => {
      shell.log(`error: ${e.message}`, "bad");
      setRun((cur) => (cur && cur.started === r.started ? { ...cur, lines: [...lines, e.message], status: "failed", ended: new Date() } : cur));
    });
  };

  const tryRun = () => {
    if (child.current) return shell.modal({ kind: "info", tone: "warn", title: "A command is still running", lines: ["Wait for it, or press Esc to stop it."] });
    const problem = missing(spec, v) ?? spec.check?.(v) ?? null;
    if (problem) return shell.modal({ kind: "info", tone: "bad", title: `${S.cross} Can't run ${spec.name}`, lines: [problem] });
    const warning = spec.confirm?.(v) ?? null;
    if (!warning) return start(spec, v);
    shell.modal({
      kind: "confirm", danger: /DELETE|upload/i.test(warning), title: `Run ${spec.name}?`, yes: "run",
      lines: [commandLine(spec, v), "", warning], onYes: () => start(spec, v),
    });
  };

  useInput((input, key) => {
    if (input === "r") return tryRun();
    if (key.escape && child.current) { store.stopping = true; child.current.kill("SIGTERM"); return; }
    if (key.pageDown) return setOutScroll((x) => Math.max(0, x - 10));
    if (key.pageUp) return setOutScroll((x) => x + 10);
    if (focus === "list") {
      if (key.upArrow) { setCmdSel((n) => Math.max(0, n - 1)); setFieldSel(0); }
      else if (key.downArrow) { setCmdSel((n) => Math.min(COMMANDS.length - 1, n + 1)); setFieldSel(0); }
      else if (key.rightArrow || key.return) setFocus("form");
    } else {
      if (key.upArrow) setFieldSel((n) => Math.max(0, n - 1));
      else if (key.downArrow) setFieldSel((n) => Math.min(spec.fields.length - 1, n + 1));
      else if (key.leftArrow) setFocus("list");
      else if (key.return || input === " ") edit(field);
      else if (input === "d") setValues((all) => ({ ...all, [spec.name]: spec.defaults(ctx) }));
      else if ((key.backspace || key.delete) && field.kind !== "flag" && !field.required) set(field.key, "");
    }
  }, { isActive: active });

  const listW = 16;
  const formW = width - listW - 1;
  const outH = Math.max(4, height - spec.fields.length - 9);
  const shownValue = (f: Field) => {
    const val = v[f.key];
    if (f.kind === "flag") return val ? `${S.check} yes` : "no";
    if (val === "" || val == null) return f.required ? "— required —" : "—";
    if (f.kind === "save") return shell.saves.find((s) => s.path === val)?.name ?? String(val);
    if (f.kind === "newSave") return `Save${val}.sav`;
    return String(val);
  };
  const outLines = run?.lines ?? [];
  const outFrom = Math.max(0, outLines.length - outH - outScroll);

  return (
    <Box flexDirection="column" height={height}>
      <Box flexGrow={1}>
        <Box flexDirection="column" width={listW} flexShrink={0} borderStyle="round" borderColor={focus === "list" && active ? C.focus : C.border} paddingX={1}>
          {COMMANDS.map((c, i) => (
            <Text key={c.name} inverse={i === cmdSel && focus === "list"} bold={i === cmdSel} color={i === cmdSel ? C.accent : undefined} wrap="truncate-end">
              {c.confirm ? S.warn : " "} {c.name}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" width={formW}>
          <Box flexDirection="column" borderStyle="round" borderColor={focus === "form" && active ? C.focus : C.border} paddingX={1} flexShrink={0}>
            <Text bold wrap="truncate-end">{S.gear} {spec.name} <Text color={C.dim} bold={false}>· {spec.summary}</Text></Text>
            {spec.fields.map((f, i) => (
              <Text key={f.key} wrap="truncate-end" inverse={focus === "form" && i === fieldSel}>
                <Text color={C.dim}>{fit(f.label, 30)}</Text>
                <Text color={v[f.key] === "" && f.required ? C.bad : f.kind === "flag" && v[f.key] ? C.ok : undefined}>{shownValue(f)}</Text>
              </Text>
            ))}
            <Text color={C.dim} wrap="truncate-end">{focus === "form" && field.help ? `${S.pointer} ${field.help}` : " "}</Text>
            <Text wrap="truncate-end"><Text color={C.accent2}>$ </Text>{commandLine(spec, v)}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={C.border} paddingX={1} overflow="hidden">
            <Text wrap="truncate-end">
              <Text bold>{S.log} Output</Text>
              {run && <Text color={run.status === "running" ? C.warn : run.status === "ok" ? C.ok : C.bad}>  {run.status === "running" ? `${S.clock} running…` : run.status === "ok" ? `${S.check} done` : run.status === "stopped" ? "stopped" : `${S.cross} exit ${run.code}`}</Text>}
              {run?.ended && <Text color={C.dim}> in {((run.ended.getTime() - run.started.getTime()) / 1000).toFixed(1)} s</Text>}
              {outScroll > 0 && <Text color={C.dim}> · scrolled up {outScroll} (PgDn)</Text>}
            </Text>
            {run ? outLines.slice(outFrom, outFrom + outH).map((l, i) => (
              <Text key={i} wrap="truncate-end" color={/WARNING/.test(l) ? C.warn : /^error|Error:/.test(l) ? C.bad : undefined}>{l}</Text>
            )) : <Text color={C.dim}>Pick a command, set its fields, press r.</Text>}
          </Box>
        </Box>
      </Box>
      <Hints items={focus === "list"
        ? [["↑↓", "command"], ["→/Enter", "edit fields"], ["r", "run"], ["PgUp/PgDn", "output"], ["Esc", "stop"]]
        : [["↑↓", "field"], ["Enter", "change"], ["d", "defaults"], ["←", "commands"], ["r", "run"], ["Esc", "stop"]]} />
    </Box>
  );
}
