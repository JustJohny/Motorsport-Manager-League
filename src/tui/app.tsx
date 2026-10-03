import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LeagueState } from "../league-types.ts";
import { Cockpit } from "./cockpit.tsx";
import { Hints, Modal, type ModalSpec } from "./components.tsx";
import { defaultSeries, fetchSite, loadState, readSaves, readSeries, savesOf, seriesSaves, type SaveEntry, type SeriesEntry, type SiteStatus } from "./data.ts";
import { SavePicker, SeriesPicker } from "./pickers.tsx";
import { C, gameDate, S } from "./theme.ts";

export type ScreenId = "cockpit" | "saves" | "series" | "browser" | "launcher" | "editor";

const SCREENS: { id: ScreenId; icon: string; label: string; soon?: string }[] = [
  { id: "cockpit", icon: S.flag, label: "Race cycle" },
  { id: "saves", icon: S.save, label: "Saves" },
  { id: "series", icon: S.series, label: "Series" },
  { id: "browser", icon: S.team, label: "Save browser", soon: "phase 2" },
  { id: "launcher", icon: S.gear, label: "Commands", soon: "phase 3" },
  { id: "editor", icon: S.part, label: "Editor", soon: "phase 4" },
];

export interface LogLine { text: string; tone?: "ok" | "bad" | "warn" | "dim"; at: Date }

/** What every screen gets from the shell. */
export interface Shell {
  series: SeriesEntry | undefined;
  allSeries: SeriesEntry[];
  saves: SaveEntry[];
  save: SaveEntry | undefined;
  state: LeagueState | null;
  stateError: string | null;
  site: SiteStatus | null;
  siteError: string | null;
  siteLoading: boolean;
  log: (text: string, tone?: LogLine["tone"]) => void;
  modal: (m: ModalSpec | null) => void;
  /** Run blocking work (loading or writing a save) behind a "working" dialog. */
  heavy: <T>(title: string, fn: () => T | Promise<T>) => Promise<T | undefined>;
  selectSave: (path: string) => void;
  selectSeries: (index: number) => void;
  rescanSaves: () => void;
  refreshSite: () => void;
  go: (s: ScreenId) => void;
  width: number;
  height: number;
}

export function App() {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [allSeries] = useState(readSeries);
  const [saves, setSaves] = useState(readSaves);
  const [seriesIdx, setSeriesIdx] = useState(() => defaultSeries(allSeries, saves));
  const series = allSeries[seriesIdx];
  const [savePath, setSavePath] = useState<string | undefined>(() => savesOf(saves, series)[0]?.path);
  const save = saves.find((s) => s.path === savePath);
  const [state, setState] = useState<LeagueState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [site, setSite] = useState<SiteStatus | null>(null);
  const [siteError, setSiteError] = useState<string | null>(null);
  const [siteLoading, setSiteLoading] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [modal, setModal] = useState<ModalSpec | null>(null);
  const [screen, setScreen] = useState<ScreenId>("cockpit");
  const [focus, setFocus] = useState<"nav" | "main">("main");
  const [navSel, setNavSel] = useState(0);
  const [logBig, setLogBig] = useState(false);

  const log = useCallback((text: string, tone?: LogLine["tone"]) => {
    const tn = tone ?? (/WARNING/.test(text) ? "warn" : /^error|failed/i.test(text) ? "bad" : undefined);
    setLines((ls) => [...ls.slice(-500), ...text.split("\n").map((t) => ({ text: t, tone: tn, at: new Date() }))]);
  }, []);

  const heavy = useCallback(<T,>(title: string, fn: () => T | Promise<T>) => new Promise<T | undefined>((resolve) => {
    setModal({ kind: "busy", title });
    // Let Ink draw the dialog before the event loop blocks.
    setTimeout(async () => {
      try {
        const out = await fn();
        setModal((m) => (m?.kind === "busy" ? null : m));
        resolve(out);
      } catch (e) {
        log(`error: ${(e as Error).message}`, "bad");
        setModal({ kind: "info", title: `${S.cross} ${title} failed`, tone: "bad", lines: [(e as Error).message] });
        resolve(undefined);
      }
    }, 60);
  }), [log]);

  // The selected save's league view.
  useEffect(() => {
    setState(null); setStateError(null);
    if (!save || !series) return;
    const t = setTimeout(() => {
      try { setState(loadState(save.path, series.cfg)); } catch (e) { setStateError((e as Error).message); }
    }, 60);
    return () => clearTimeout(t);
  }, [save?.path, save?.modified.getTime(), series?.file]);

  const refreshSite = useCallback(() => {
    if (!series) return;
    setSiteLoading(true); setSiteError(null);
    fetchSite(series.cfg, series.file)
      .then((s) => setSite(s))
      .catch((e) => setSiteError((e as Error).message))
      .finally(() => setSiteLoading(false));
  }, [series?.file]);
  useEffect(() => { setSite(null); refreshSite(); }, [refreshSite]);

  const shell: Shell = {
    series, allSeries, saves, save, state, stateError, site, siteError, siteLoading, log,
    modal: setModal, heavy,
    selectSave: (p) => setSavePath(p),
    selectSeries: (i) => { setSeriesIdx(i); setSavePath(savesOf(saves, allSeries[i])[0]?.path); },
    rescanSaves: () => setSaves(readSaves()),
    refreshSite,
    go: (s) => { setScreen(s); setFocus("main"); setNavSel(SCREENS.findIndex((x) => x.id === s)); },
    width: columns, height: rows,
  };

  useInput((input, key) => {
    if (input === "q") return exit();
    if (key.tab) return setFocus((f) => (f === "nav" ? "main" : "nav"));
    if (input === "l") return setLogBig((b) => !b);
    if (/^[1-6]$/.test(input)) {
      const s = SCREENS[Number(input) - 1];
      if (!s.soon) shell.go(s.id);
      return;
    }
    if (focus === "nav") {
      if (key.upArrow) setNavSel((n) => Math.max(0, n - 1));
      if (key.downArrow) setNavSel((n) => Math.min(SCREENS.length - 1, n + 1));
      if (key.return || key.rightArrow) {
        const s = SCREENS[navSel];
        if (!s.soon) shell.go(s.id);
      }
    }
  }, { isActive: !modal });

  const logHeight = logBig ? Math.max(8, rows - 10) : rows < 40 ? 5 : 7;
  const bodyHeight = Math.max(8, rows - 3 - 1 - logHeight);
  const mainWidth = Math.max(40, columns - 24);
  const mainActive = focus === "main" && !modal;

  const body = useMemo(() => {
    const props = { shell, active: mainActive, height: bodyHeight - 2, width: mainWidth - 4 };
    switch (screen) {
      case "cockpit": return <Cockpit {...props} />;
      case "saves": return <SavePicker {...props} />;
      case "series": return <SeriesPicker {...props} />;
      default: return <Text color={C.dim}>Coming in a later phase.</Text>;
    }
  }, [screen, shell, mainActive, bodyHeight, mainWidth]);

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {/* Header */}
      <Box borderStyle="round" borderColor={C.accent} paddingX={1} justifyContent="space-between" height={3} flexShrink={0}>
        <Box flexShrink={1}><Text wrap="truncate-end">
          <Text bold color={C.accent}>{S.flag} MM League Toolkit</Text>
          <Text color={C.dim}>  {S.bar}  </Text>
          <Text color={C.accent2}>{S.series} {series ? `${series.name} (${series.id})` : "no league file"}</Text>
          <Text color={C.dim}>  {S.bar}  </Text>
          <Text>{S.save} {save?.shown ?? "no save"}</Text>
        </Text></Box>
        <Box flexShrink={0} marginLeft={2}><Text>
          <Text color={C.dim}>game date </Text><Text bold>{gameDate(save?.gameTime)}</Text>
          <Text color={C.dim}>  {S.cloud} </Text>
          {siteLoading ? <Text color={C.dim}>…</Text> : siteError ? <Text color={C.bad}>offline</Text>
            : site?.snapshot ? <Text>#{site.snapshot.id} {gameDate(site.snapshot.game_date)}</Text> : <Text color={C.dim}>—</Text>}
        </Text></Box>
      </Box>

      <Box height={bodyHeight} flexShrink={0}>
        {/* Sidebar */}
        <Box flexDirection="column" width={24} flexShrink={0} borderStyle="round" borderColor={focus === "nav" && !modal ? C.focus : C.border} paddingX={1}>
          {SCREENS.map((s, i) => {
            const on = s.id === screen;
            const hl = focus === "nav" && i === navSel;
            return (
              <Text key={s.id} color={s.soon ? C.dim : on ? C.accent : undefined} bold={on} inverse={hl}>
                {i + 1} {s.icon} {s.label}{s.soon ? ` ${S.soon}` : ""}
              </Text>
            );
          })}
          <Box flexGrow={1} />
          <Text color={C.dim}>{S.save} {seriesSaves(saves, series).length} series saves</Text>
          <Text color={C.dim}>{S.team} {series?.cfg.members.length ?? 0} members</Text>
        </Box>
        {/* Main */}
        <Box flexDirection="column" width={mainWidth} borderStyle="round" borderColor={mainActive ? C.focus : C.border} paddingX={1} overflow="hidden">
          {/* The screen stays mounted under a dialog, so it keeps its state (e.g. a pull being reviewed). */}
          {body}
          {modal && (
            <Box position="absolute" top={0} left={0} width={mainWidth - 2} height={bodyHeight - 2} alignItems="center" justifyContent="center">
              <Box backgroundColor="black">
                <Modal spec={modal} close={() => setModal(null)} width={Math.min(90, mainWidth - 6)} />
              </Box>
            </Box>
          )}
        </Box>
      </Box>

      {/* Log */}
      <Box flexDirection="column" height={logHeight} flexShrink={0} borderStyle="round" borderColor={C.border} paddingX={1} overflow="hidden">
        <Text color={C.dim}>{S.log} Log {logBig ? "(l to shrink)" : "(l to expand)"}</Text>
        {lines.slice(-(logHeight - 3)).map((l, i) => (
          <Text key={i} wrap="truncate-end" color={l.tone === "bad" ? C.bad : l.tone === "warn" ? C.warn : l.tone === "ok" ? C.ok : l.tone === "dim" ? C.dim : undefined}>
            <Text color={C.dim}>{l.at.toTimeString().slice(0, 8)} </Text>{l.text}
          </Text>
        ))}
      </Box>

      {/* Footer */}
      <Box paddingX={1} height={1} flexShrink={0}>
        <Hints items={[["Tab", focus === "nav" ? "to screen" : "to menu"], ["1-3", "screens"], ["l", "log"], ["q", "quit"]]} />
      </Box>
    </Box>
  );
}
