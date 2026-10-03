import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Obj } from "../graph.ts";
import { team as teamState } from "../extract.ts";
import { SPONSOR_SLOTS, type TeamState } from "../league-types.ts";
import type { Save } from "../model.ts";
import type { Shell } from "./app.tsx";
import { Field, Hints } from "./components.tsx";
import { loadSave } from "./data.ts";
import { TeamList, useTeamRows, type TeamRow } from "./teams.tsx";
import { C, fit, gameDate, money, moneyShort, S } from "./theme.ts";

interface ScreenProps { shell: Shell; active: boolean; height: number; width: number }

const TABS = ["Overview", "HQ", "Parts", "Staff", "Sponsors"] as const;
type Tab = (typeof TABS)[number];
const TAB_ICONS: Record<Tab, string> = { Overview: S.team, HQ: S.hq, Parts: S.part, Staff: S.crew, Sponsors: S.sponsor };

/** Every team of the selected save by championship, and one team's HQ, parts, staff and sponsors. */
export function Browser({ shell, active, height, width }: ScreenProps) {
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
  const rows = useTeamRows(save, shell.series);
  const [filter, setFilter] = useState("");
  const shown = rows.filter((r) => !filter || `${r.name} ${r.champ}`.toLowerCase().includes(filter.toLowerCase()));
  const [sel, setSel] = useState(() => Math.max(0, shown.findIndex((r) => r.member)));
  const [tab, setTab] = useState<Tab>("Overview");
  const [scroll, setScroll] = useState(0);
  const cur = shown[Math.min(sel, shown.length - 1)];

  const state = useMemo<TeamState | null>(() => {
    if (!cur) return null;
    try { return teamState(save, cur.t, save.g.deref<Obj>(cur.t.championship), cur.member); } catch { return null; }
  }, [save, cur?.t]);

  useInput((input, key) => {
    const move = (n: number) => { setSel((s) => Math.max(0, Math.min(shown.length - 1, s + n))); setScroll(0); };
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.home) move(-1e9);
    else if (key.end) move(1e9);
    else if (key.leftArrow || key.rightArrow) {
      const i = TABS.indexOf(tab) + (key.rightArrow ? 1 : -1);
      setTab(TABS[(i + TABS.length) % TABS.length]); setScroll(0);
    } else if (key.pageDown) setScroll((s) => s + 10);
    else if (key.pageUp) setScroll((s) => Math.max(0, s - 10));
    else if (input === "/") {
      shell.modal({ kind: "input", title: "Filter teams", value: filter, placeholder: "team or championship, empty for all",
        onSubmit: (v) => { setFilter(v); setSel(0); } });
    } else if (input === "m") {
      const i = shown.findIndex((r, j) => j > sel && r.member);
      const k = i >= 0 ? i : shown.findIndex((r) => r.member);
      if (k >= 0) { setSel(k); setScroll(0); }
    }
  }, { isActive: active });

  const listW = 34;
  const listH = height - 4; // the box borders, the title line and the key hints
  return (
    <Box flexDirection="column" height={height}>
      <Text wrap="truncate-end">
        <Text bold>{S.team} Save browser</Text>
        <Text color={C.dim}> · {shell.save?.shown} · {gameDate(save.now)} · {rows.length} teams{filter ? ` · filter "${filter}" (${shown.length})` : ""}</Text>
      </Text>
      <Box flexGrow={1}>
        <TeamList rows={shown} sel={sel} height={listH} width={listW} focused={false} />
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={active ? C.focus : C.border} paddingX={1} overflow="hidden">
          <Box columnGap={2} flexShrink={0}>
            {TABS.map((t) => <Text key={t} bold={t === tab} inverse={t === tab} color={t === tab ? C.accent : C.dim}> {TAB_ICONS[t]} {t} </Text>)}
          </Box>
          {cur && state ? (
            <Detail tab={tab} row={cur} state={state} save={save} scroll={scroll} height={height - 6} width={width - listW - 4} />
          ) : <Text color={C.dim}>—</Text>}
        </Box>
      </Box>
      <Hints items={[["↑↓", "team"], ["←→", "tab"], ["PgUp/PgDn", "scroll"], ["m", "next member team"], ["/", "filter"]]} />
    </Box>
  );
}

/** Scrollable lines for one tab. */
function Detail({ tab, row, state, save, scroll, height, width }: { tab: Tab; row: TeamRow; state: TeamState; save: Save; scroll: number; height: number; width: number }) {
  const lines = detailLines(tab, row, state, save, width);
  const max = Math.max(0, lines.length - height);
  const from = Math.min(scroll, max);
  return (
    <Box flexDirection="column">
      {lines.slice(from, from + height).map((l, i) => <Box key={i}>{l}</Box>)}
      {lines.length > height && <Text color={C.dim}>{from > 0 ? S.up : " "} {from + 1}–{Math.min(lines.length, from + height)} of {lines.length} {from < max ? S.down : " "}</Text>}
    </Box>
  );
}

function detailLines(tab: Tab, row: TeamRow, t: TeamState, save: Save, width: number): ReactNode[] {
  const head = (s: string) => <Text color={C.accent2} bold>{s}</Text>;
  switch (tab) {
    case "Overview": {
      const raw = row.t;
      const nat = raw.nationality ? save.g.deref<Obj>(raw.nationality)?.mCountryKey : null;
      const ch = save.g.deref<Obj>(raw.championship);
      const st = save.g.list<Obj>(save.g.deref<Obj>(ch.standings)?.mTeams ?? []).find((e) => save.g.same(e.mEntity, raw));
      return [
        <Field label="Team">{t.name} <Text color={C.dim}>({String(raw.mShortName ?? "")} · id {t.teamID})</Text></Field>,
        <Field label="Championship">{row.champ}</Field>,
        <Field label="Managed by">{row.player ? "the career team (in game)" : row.member ? `${row.member} (league member)` : "MM's AI"}</Field>,
        <Field label="Nationality">{nat ?? "—"}</Field>,
        <Field label="Budget"><Text color={C.money}>{money(t.budget)}</Text></Field>,
        <Field label="Standings">{st ? `P${st.mCurrentPosition}` : "—"}</Field>,
        <Field label="Reputation">{String(t.reputation ?? "—")}</Field>,
        <Field label="Marketability">{t.marketability == null ? "—" : `${Math.round(t.marketability * 100)}%`}</Field>,
        <Field label="Fans">{t.fanBase == null ? "—" : Math.round(t.fanBase).toLocaleString("en-US")}</Field>,
        <Field label="Engine">{t.engine?.name ?? "—"}</Field>,
        <Field label="HQ">{`${t.hq.filter((b) => b.level > 0).length} of ${t.hq.length} buildings`}</Field>,
        <Field label="Design">{t.design?.current ? `${t.design.current.type}, done ${gameDate(t.design.current.end)}` : "none running"}</Field>,
        <Field label="Sponsors">{`${t.sponsors?.length ?? 0} of 6 slots`}</Field>,
      ];
    }
    case "HQ":
      return [
        <Text color={C.dim}>{fit("Building", 30)} {fit("Level", 7)} {fit("State", 20)} {fit("Done", 12)}</Text>,
        ...[...t.hq].sort((a, b) => b.level - a.level || a.name.localeCompare(b.name)).map((b) => (
          <Text wrap="truncate-end" color={b.level === 0 && b.state === "NotBuilt" ? C.dim : undefined}>
            {fit(b.name, 30)} {fit(b.level ? `${b.level}/${b.maxLevel}` : "—", 7)} {fit(b.state === "Constructed" ? "built" : b.state === "NotBuilt" ? "not built" : b.state === "BuildingInProgress" ? "being built" : "upgrading", 20)} {fit(b.state === "BuildingInProgress" || b.state === "Upgrading" ? gameDate(b.progressEnd) : "", 12)}
          </Text>
        )),
      ];
    case "Parts": {
      const out: ReactNode[] = [];
      for (const [type, parts] of Object.entries(t.parts)) {
        out.push(head(`${type} (${parts.length})`));
        out.push(<Text color={C.dim}>  {fit("Part", 12)} {fit("Lvl", 4)} {fit("Stat", 7, "right")} {fit("+Perf", 7, "right")} {fit("Rel.", 6, "right")} {fit("Cond.", 6, "right")} {fit("Car", 6)}</Text>);
        for (const p of [...parts].sort((a, b) => (a.fittedToCar ?? 9) - (b.fittedToCar ?? 9))) {
          out.push(
            <Text wrap="truncate-end" color={p.fittedToCar != null ? undefined : C.dim}>
              {"  "}{fit(p.name, 12)} {fit(String(p.level), 4)} {fit((p.stat ?? 0).toFixed(1), 7, "right")} {fit((p.performance ?? 0).toFixed(1), 7, "right")} {fit(p.reliability == null ? "—" : `${Math.round(p.reliability * 100)}%`, 6, "right")} {fit(p.condition == null ? "—" : `${Math.round(p.condition * 100)}%`, 6, "right")} {fit(p.fittedToCar != null ? `car ${p.fittedToCar + 1}` : "", 6)}
            </Text>,
          );
        }
      }
      return out.length ? out : [<Text color={C.dim}>No parts.</Text>];
    }
    case "Staff": {
      const statLine = (s: Record<string, number | null>) => Object.entries(s).map(([k, v]) => `${k.slice(0, 4)} ${v == null ? "—" : Math.round(v * 10) / 10}`).join("  ");
      return t.staff.flatMap((s) => [
        <Text wrap="truncate-end">
          <Text color={C.accent2}>{fit(s.job === "EngineerLead" ? "Engineer" : s.job, 9)}</Text> {fit(s.person?.name ?? "vacant", 24)}
          <Text color={C.dim}> {s.person ? `${moneyShort(s.person.contract.yearlyWages)}/yr to ${gameDate(s.person.contract.end)}` : ""}</Text>
        </Text>,
        ...(s.person ? [<Text wrap="truncate-end" color={C.dim}>{"          "}{statLine(s.person.stats).slice(0, Math.max(10, width - 12))}</Text>] : []),
      ]);
    }
    case "Sponsors": {
      const sp = t.sponsorship;
      if (!sp) return [<Text color={C.dim}>No sponsor data.</Text>];
      const out: ReactNode[] = [head("On the car")];
      for (let slot = 0; slot < 6; slot++) {
        const d = sp.deals.find((x) => x.slot === slot);
        out.push(
          <Text wrap="truncate-end">
            {fit(SPONSOR_SLOTS[slot], 11)} {d ? <>{fit(d.sponsor, 24)} {S.star.repeat(d.prestige)}<Text color={C.dim}> {d.bonus ? `${moneyShort(d.bonus)} for P${d.bonusTarget}` : `${moneyShort(d.perRace)}/race`} · {d.left}/{d.length} months</Text></> : <Text color={C.dim}>empty</Text>}
          </Text>,
        );
      }
      out.push(head(`Offers (${sp.offers.length})`));
      for (const o of sp.offers) {
        out.push(
          <Text wrap="truncate-end">
            {fit(SPONSOR_SLOTS[o.slot], 11)} {fit(o.sponsor, 24)} {S.star.repeat(o.prestige)}
            <Text color={C.dim}> {moneyShort(o.upfront)} upfront · {o.bonus ? `${moneyShort(o.bonus)} for P${o.bonusTarget}` : `${moneyShort(o.perRace)}/race`} · {o.length} months · lapses in {o.daysLeft} d</Text>
          </Text>,
        );
      }
      return out;
    }
  }
}
