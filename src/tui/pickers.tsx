import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Shell } from "./app.tsx";
import { Field, Hints, List, Panel, useListKeys } from "./components.tsx";
import { savesOf, seriesSaves } from "./data.ts";
import { ago, C, fit, gameDate, S } from "./theme.ts";

interface ScreenProps { shell: Shell; active: boolean; height: number; width: number }

/** The Wine saves folder, newest first; this series' saves unless `a` shows all. */
export function SavePicker({ shell, active, height, width }: ScreenProps) {
  const [all, setAll] = useState(false);
  const items = all ? shell.saves : savesOf(shell.saves, shell.series);
  const [sel, setSel] = useListKeys(items.length, active, Math.max(1, height - 6));
  useInput((input, key) => {
    if (key.return && items[sel]) { shell.selectSave(items[sel].path); shell.go("cockpit"); }
    if (input === "a") { setAll((x) => !x); setSel(0); }
    if (input === "r") shell.rescanSaves();
  }, { isActive: active });
  const nameW = Math.max(20, width - 46);
  return (
    <Box flexDirection="column" height={height}>
      <Text bold wrap="truncate-end">{S.save} Saves <Text color={C.dim}>{all ? "· all"
        : seriesSaves(shell.saves, shell.series).length ? `· series "${shell.series?.name ?? "—"}" (names starting "${shell.series?.prefix}")`
        : `· all (no save is named "${shell.series?.prefix} R…" yet, as the race guide names them)`}</Text></Text>
      <Text color={C.dim}>{"  "}{fit("Save", nameW)} {fit("Game date", 12)} {fit("Saved", 12)} {fit("Size", 8, "right")}</Text>
      <List items={items} selected={sel} height={height - 4} empty={all ? "No saves in the Wine saves folder." : "No saves for this series yet: press a to show all."}
        render={(s, on) => (
          <Text color={s.path === shell.save?.path ? C.accent2 : undefined} bold={on}>
            {fit((s.path === shell.save?.path ? `${S.dot} ` : "") + s.name, nameW)} {fit(gameDate(s.gameTime), 12)} {fit(ago(s.modified), 12)} {fit(`${(s.size / 1e6).toFixed(1)} MB`, 8, "right")}
          </Text>
        )} />
      <Box flexGrow={1} />
      <Hints items={[["↑↓", "move"], ["Enter", "use this save"], ["a", all ? "series only" : "show all"], ["r", "rescan folder"]]} />
    </Box>
  );
}

/** League files (`league-<series>.json`) in the toolkit folder. */
export function SeriesPicker({ shell, active, height }: ScreenProps) {
  const items = shell.allSeries;
  const [sel] = useListKeys(items.length, active);
  useInput((_input, key) => {
    if (key.return && items[sel]) { shell.selectSeries(sel); shell.go("cockpit"); }
  }, { isActive: active });
  const cur = items[sel];
  return (
    <Box flexDirection="column" height={height}>
      <Text bold>{S.series} Series</Text>
      <Box columnGap={2}>
        <Box flexDirection="column" width={34}>
          <List items={items} selected={sel} height={height - 4} empty="No league-*.json files in the toolkit folder."
            render={(s) => <Text color={s.file === shell.series?.file ? C.accent2 : undefined}>{s.file === shell.series?.file ? `${S.dot} ` : ""}{s.name} <Text color={C.dim}>({s.id})</Text></Text>} />
        </Box>
        {cur && (
          <Panel title={cur.name} icon={S.series} grow>
            <Field label="League file">{cur.file}</Field>
            <Field label="Series id">{cur.id}</Field>
            <Field label="Save names">{cur.prefix} R1 Post, {cur.prefix} R2 Pre, …</Field>
            <Field label="Saves">{String(seriesSaves(shell.saves, cur).length)} named for this series</Field>
            <Text color={C.dim}>Members</Text>
            {cur.cfg.members.map((m) => (
              <Text key={m.member} wrap="truncate-end">  {S.team} {fit(m.member, 26)} {m.team}{m.organizer ? <Text color={C.accent2}> organizer</Text> : null}{!m.discord ? <Text color={C.warn}> {S.warn} no Discord</Text> : null}</Text>
            ))}
          </Panel>
        )}
      </Box>
      <Box flexGrow={1} />
      <Hints items={[["↑↓", "move"], ["Enter", "use this series"]]} />
    </Box>
  );
}
