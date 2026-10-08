import { Box, Text, useInput } from "ink";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { applyToSave, publishSave } from "../commands/publish-apply.ts";
import { pullDecisions, type PullResult } from "../commands/pull.ts";
import { readAiLooks } from "../ai-looks.ts";
import { seriesEnvFor } from "../commands/common.ts";
import { defaultSavesDir } from "../paths.ts";
import { cycleOf, cycleSaves, seriesFiles } from "../race-cycle.ts";
import type { Shell } from "./app.tsx";
import { Field, Hints, List, Panel, useListKeys } from "./components.tsx";
import { ago, C, fit, gameDate, moneyShort, S } from "./theme.ts";

interface ScreenProps { shell: Shell; active: boolean; height: number; width: number }

const SECTION_ICONS: Record<string, string> = {
  "HQ orders": S.hq, Parts: S.part, "Pit crews": S.crew, Sponsors: S.sponsor, "Contract renewals": S.contract, "Transfer window": S.window,
  "Rule votes": S.vote, "Engine programmes": S.engine, "Next season's suppliers": S.engine, "Equalize the field": S.gear, Overview: S.cloud,
};

export function Cockpit(props: ScreenProps) {
  const [pull, setPull] = useState<PullResult | null>(null);
  if (pull) return <PullReview {...props} pull={pull} back={() => setPull(null)} />;
  return <Status {...props} openPull={setPull} />;
}

function Status({ shell, active, height, width, openPull }: ScreenProps & { openPull: (p: PullResult) => void }) {
  const { series, save, state, site } = shell;
  const cycle = state ? cycleOf(state.championship, state.gameDate) : null;
  const names = series && cycle ? cycleSaves(series.prefix, cycle.lastRound, cycle.nextRound) : null;
  const siteDate = site?.snapshot?.game_date ?? null;
  const published = !!siteDate && !!save?.gameTime && siteDate.slice(0, 10) === save.gameTime.slice(0, 10);

  const publish = async () => {
    if (!series || !save) return;
    const lines: string[] = [];
    const dry = await shell.heavy("Reading the save", () => publishSave(save.path, series.cfg, { dryRun: true, leagueFile: series.file }, (l) => lines.push(l)));
    if (!dry) return;
    shell.modal({
      kind: "confirm", title: `${S.push} Publish "${save.shown}" to series "${series.id}"?`, yes: "publish",
      lines: [...lines, "", `Members will see game date ${gameDate(dry.state.gameDate)}${siteDate ? ` (the site has ${gameDate(siteDate)})` : ""}.`],
      onYes: async () => {
        shell.log(`Publishing ${save.shown}…`);
        const r = await shell.heavy("Publishing", () => publishSave(save.path, series.cfg, { leagueFile: series.file }, (l) => shell.log(l)));
        if (r) { shell.log(`${S.check} published snapshot #${r.snapshotId}`, "ok"); shell.refreshSite(); }
      },
    });
  };

  const startPull = async () => {
    if (!series) return;
    shell.log(`Pulling members' decisions for series "${series.id}"…`);
    const r = await shell.heavy("Pulling members' decisions", () => pullDecisions(seriesEnvFor(series.cfg, series.file), { aiLooks: readAiLooks(series.cfg, series.file) }, (l) => shell.log(l, "dim")));
    if (r) openPull(r);
  };

  useInput((input) => {
    if (input === "p") void publish();
    if (input === "u") void startPull();
    if (input === "r") { shell.refreshSite(); shell.rescanSaves(); }
    if (input === "s") shell.go("saves");
  }, { isActive: active });

  const half = Math.floor((width - 1) / 2);
  // Rows: the cycle line (1), the save/website panels (6), steps/queued (up to 10), key hints (1);
  // the member table gets what's left, if that's enough for it.
  const lowerRows = Math.max(4, Math.min(10, height - 8));
  const tableRows = height - 8 - lowerRows;
  const members = state?.teams.filter((t) => t.member) ?? [];
  const steps = cycle && names ? stepsFor(cycle.current, names, cycle.nextRound, published, save?.name) : [];
  // As many steps as fit, from the one before the first undone step.
  const fitSteps = lowerRows - 3;
  const firstOpen = Math.max(0, steps.findIndex((x) => !x.done));
  const from = Math.max(0, Math.min(firstOpen - 1, steps.length - fitSteps));
  const visibleSteps = steps.map((s, i) => ({ s, i })).slice(from, from + fitSteps);
  const queued = (site?.sections ?? []).filter((x) => x.title !== "Overview");
  const fitQueued = lowerRows - 4;
  const shownQueued = queued.length > fitQueued ? [...queued.filter((x) => x.count), ...queued.filter((x) => !x.count)].slice(0, fitQueued) : queued;

  return (
    <Box flexDirection="column" height={height}>
      {/* Where we are */}
      <Box flexShrink={0}>
        {cycle ? (
          <Text>
            <Text bold color={cycle.current === "after" ? C.accent : undefined} inverse={cycle.current === "after"}> A · After race {cycle.lastRound}{cycle.last ? ` (${cycle.last.circuit})` : ""} </Text>
            <Text color={C.dim}> {S.arrow} </Text>
            <Text bold color={cycle.current === "before" ? C.accent : undefined} inverse={cycle.current === "before"}> B · Before race {cycle.nextRound}{cycle.next ? ` (${cycle.next.circuit}, ${gameDate(cycle.next.date)})` : ""} </Text>
            <Text color={C.dim}> {S.arrow} {S.flag} Race {cycle.nextRound}</Text>
          </Text>
        ) : <Text color={shell.stateError ? C.bad : C.dim}>{shell.stateError ? `${S.cross} ${shell.stateError}` : save ? `${S.clock} Reading ${save.shown}…` : "Pick a save (s)."}</Text>}
      </Box>

      <Box flexShrink={0}>
        <Panel title="This save" icon={S.save} width={half}>
          <Field label="File">{save?.name ?? "—"}</Field>
          <Field label="Game date">{gameDate(save?.gameTime)}{save ? <Text color={C.dim}> · saved {ago(save.modified)}</Text> : null}</Field>
          <Field label="Checkpoint">{cycle ? (cycle.current === "after" ? `A, after race ${cycle.lastRound}` : `B, before race ${cycle.nextRound}`) : "—"}</Field>
        </Panel>
        <Panel title="Website" icon={S.cloud} width={width - half} right={shell.siteLoading ? <Text color={C.dim}>{S.refresh}</Text> : null}>
          {shell.siteError ? <Text color={C.bad} wrap="truncate-end">{S.cross} {shell.siteError}</Text> : site?.snapshot ? (
            <>
              <Field label="Snapshot">#{site.snapshot.id} · game date {gameDate(site.snapshot.game_date)}</Field>
              <Field label="Published">{ago(site.snapshot.created_at)}</Field>
              <Field label="vs this save">{published ? <Text color={C.ok}>{S.check} shows this save's date</Text> : <Text color={C.warn}>{S.warn} different game date</Text>}</Field>
            </>
          ) : <Text color={C.dim}>{shell.siteLoading ? "Loading…" : "Nothing published yet."}</Text>}
        </Panel>
      </Box>

      <Box flexShrink={0}>
        <Panel title={`Steps · checkpoint ${cycle?.current === "before" ? "B" : "A"}`} icon={S.flag} width={half} height={lowerRows}>
          {visibleSteps.map(({ s, i }) => (
            <Text key={i} wrap="truncate-end" color={s.done ? C.dim : undefined}>
              <Text color={s.done ? C.ok : s.key ? C.accent2 : C.dim}>{s.done ? S.check : s.key ? `[${s.key}]` : `${i + 1}.`}</Text> {s.text}
            </Text>
          ))}
        </Panel>
        <Panel title="Members' queued decisions" icon={S.pull} width={width - half} height={lowerRows} right={<Text color={C.dim}>live, read-only</Text>}>
          {site ? shownQueued.map((sec) => (
            <Text key={sec.title} wrap="truncate-end">
              {SECTION_ICONS[sec.title] ?? S.dot} {fit(sec.title, 24)} <Text bold color={sec.count ? C.accent2 : C.dim}>{sec.count}</Text>
              <Text color={C.dim}> {sec.lines.find((l) => /WARNING|still open/.test(l)) ? `${S.warn} ${sec.lines.find((l) => /WARNING|still open/.test(l))}` : ""}</Text>
            </Text>
          )) : <Text color={C.dim}>{shell.siteLoading ? "Loading…" : "—"}</Text>}
          {site && <Text color={C.dim}>{site.changes} changes would be applied</Text>}
        </Panel>
      </Box>

      {tableRows >= 5 && <Panel title="Member teams" icon={S.team} grow>
        <Text color={C.dim} wrap="truncate-end">{fit("Team", 24)} {fit("Member", 18)} {fit("Budget", 9, "right")} {fit("Pos", 4, "right")}  {fit("HQ", 12)} {fit("Design", 16)} {fit("Sponsors", 9)}</Text>
        {members.map((t) => {
          const pos = state!.championship.standings.teams.find((x) => x.teamID === t.teamID)?.position;
          const building = t.hq.filter((b) => b.state === "BuildingInProgress" || b.state === "Upgrading").length;
          const design = t.design?.current;
          return (
            <Text key={t.name} wrap="truncate-end">
              {fit(t.name, 24)} {fit(t.member ?? "", 18)} <Text color={C.money}>{fit(moneyShort(t.budget), 9, "right")}</Text> {fit(pos ? `P${pos}` : "—", 4, "right")}  {fit(building ? `${building} building` : "—", 12)} {fit(design ? `${design.type} ${gameDate(design.end).slice(0, 6)}` : "—", 16)} {fit(`${t.sponsors?.length ?? 0}/6`, 9)}
            </Text>
          );
        })}
        {!members.length && <Text color={C.dim}>{state ? "No member teams in this save's championship." : "—"}</Text>}
      </Panel>}
      {tableRows < 5 && <Box flexGrow={1} />}
      <Hints items={[["p", "publish this save"], ["u", "pull & review"], ["r", "refresh"], ["s", "pick save"]]} />
    </Box>
  );
}

/** The race guide's steps for a checkpoint, with the cockpit's keys where it can do them. */
function stepsFor(cp: "after" | "before", names: { post: string; pre: string }, nextRound: number, published: boolean, current?: string) {
  // The guide's names, unless the selected save is named differently: then that's the one to use.
  const here = (guide: string) => (current && current !== guide ? current : guide);
  if (cp === "after") {
    const post = here(names.post);
    return [
      { text: `Save in MM as "${post}"`, done: true },
      { text: "Publish it", key: "p", done: published },
      { text: "Transfer window (optional, on the site)" },
      { text: "Tell the members they can act" },
      { text: "Pull their decisions and review", key: "u" },
      { text: `Apply them to "${post}" (from the review)` },
      { text: `In MM: load the (league) save, advance to race ${nextRound}, save as "${names.pre}"` },
    ];
  }
  const pre = here(names.pre);
  return [
    { text: `Save in MM as "${pre}"`, done: true },
    { text: "Publish it", key: "p", done: published },
    { text: "Tell the members their new parts are in" },
    { text: "Pull their decisions and review", key: "u" },
    { text: `Apply them to "${pre}" (from the review)` },
    { text: `In MM: load the (league) save and race; then save as R${nextRound} Post` },
  ];
}

/** The pulled decisions by area, then apply them to a new save and mark them applied. */
function PullReview({ shell, active, height, width, pull, back }: ScreenProps & { pull: PullResult; back: () => void }) {
  // The overview only names the series (shown in the title).
  const sections = pull.sections.filter((s) => s.title !== "Overview" || s.lines.length > 1);
  const [sel] = useListKeys(sections.length, active);
  const [applied, setApplied] = useState<string | null>(null);
  const ops = new Map<string, number>();
  for (const c of pull.set.changes) ops.set(c.op, (ops.get(c.op) ?? 0) + 1);
  const { series, save, site } = shell;

  const apply = () => {
    if (!series || !save) return;
    const siteDate = site?.snapshot?.game_date;
    const go = () => askName();
    if (siteDate && save.gameTime && siteDate.slice(0, 10) !== save.gameTime.slice(0, 10)) {
      shell.modal({
        kind: "confirm", danger: true, title: `${S.warn} This isn't the save the website shows`,
        lines: [`The site's snapshot has game date ${gameDate(siteDate)}; "${save.shown}" is at ${gameDate(save.gameTime)}.`,
          "Always apply to the save you published: design options, parts and prices come from it.", "Apply to this save anyway?"],
        yes: "apply anyway", onYes: go,
      });
    } else go();
  };

  const askName = () => {
    const shown = `${save!.name} (league)`;
    shell.modal({
      kind: "input", title: `${S.apply} Name of the new save`, value: shown,
      lines: ["MM's load menu shows this name; the file is Save<name>.sav in the saves folder. Your save is never overwritten."],
      validate: (v) => {
        if (!v) return "Give it a name";
        if (v === save!.name) return "That's the save you're applying to";
        if (existsSync(join(defaultSavesDir(), `Save${v}.sav`))) return `"Save${v}.sav" already exists; pick another name`;
        return null;
      },
      onSubmit: (v) => confirmApply(v),
    });
  };

  const confirmApply = (name: string) => {
    const out = join(defaultSavesDir(), `Save${name}.sav`);
    const changesFile = seriesFiles({ id: series!.id, name: series!.name }).changes;
    shell.modal({
      kind: "confirm", title: `${S.apply} Apply ${pull.set.changes.length} changes?`, yes: "apply",
      lines: [`From   ${save!.name}`, `To     Save${name}.sav  (shown as "${name}")`, `What   ${pull.set.description}`, `Also writes ${changesFile} (the change set, for the record).`],
      onYes: async () => {
        writeFileSync(changesFile, JSON.stringify(pull.set, null, 2));
        shell.log(`wrote ${changesFile}`);
        const written = await shell.heavy("Applying to a new save", () => applyToSave(save!.path, pull.set, { out, name }, (l) => shell.log(l)));
        if (!written) return;
        shell.log(`${S.check} wrote ${written}`, "ok");
        setApplied(name);
        shell.rescanSaves();
        shell.modal({
          kind: "confirm", title: "Mark these decisions as applied on the site?", yes: "mark applied",
          lines: ["Yes: they won't come back in the next pull (members' orders show as done).",
            "No: the next pull includes them again, e.g. if you want to redo this apply."],
          onYes: async () => {
            const ok = await shell.heavy("Marking as applied", () => pull.markApplied((l) => shell.log(l, "ok")).then(() => true));
            if (ok) {
              shell.refreshSite();
              shell.modal({ kind: "info", tone: "ok", title: `${S.check} Done`, lines: [`In MM, load "${name}".`, "Then follow the next step in the race cycle."] });
            }
          },
          onNo: () => shell.log("Not marked as applied: the next pull includes these decisions again.", "warn"),
        });
      },
    });
  };

  useInput((input, key) => {
    if (key.escape || input === "b") back();
    if (input === "a" && !applied) apply();
    if (input === "w" && series) {
      const file = seriesFiles({ id: series.id, name: series.name }).changes;
      writeFileSync(file, JSON.stringify(pull.set, null, 2));
      shell.log(`wrote ${file} (${pull.set.changes.length} changes)`, "ok");
    }
  }, { isActive: active });

  const cur = sections[sel];
  return (
    <Box flexDirection="column" height={height}>
      <Text bold>{S.pull} Members' decisions <Text color={C.dim}>· series "{series?.id}" · {pull.set.description}</Text></Text>
      {applied && <Text color={C.ok}>{S.check} Applied to "{applied}"</Text>}
      <Box flexGrow={1}>
        <Panel title="Areas" width={32}>
          <List items={sections} selected={sel} height={height - 8}
            render={(s, on) => <Text bold={on}>{SECTION_ICONS[s.title] ?? S.dot} {fit(s.title, 20)} <Text color={s.count ? C.accent2 : C.dim}>{s.count}</Text></Text>} />
        </Panel>
        <Panel title={cur?.title ?? ""} grow>
          {(cur?.lines ?? []).slice(0, height - 8).map((l, i) => (
            <Text key={i} wrap="truncate-end" color={/WARNING|still open/.test(l) ? C.warn : undefined}>{l}</Text>
          ))}
          {cur && cur.lines.length > height - 8 && <Text color={C.dim}>… {cur.lines.length - (height - 8)} more (full list in the log)</Text>}
        </Panel>
      </Box>
      <Panel title={`${pull.set.changes.length} changes to the save`} icon={S.apply}>
        <Text wrap="wrap" color={C.dim}>{[...ops].map(([op, n]) => `${op} ${n}`).join(" · ") || "nothing to apply"}</Text>
      </Panel>
      <Hints items={[["↑↓", "area"], ["a", `apply to "${save?.name ?? "—"}"`, !!applied], ["w", "write changes file only"], ["Esc", "back"]]} />
    </Box>
  );
}
