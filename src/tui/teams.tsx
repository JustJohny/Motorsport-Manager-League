import { Box, Text } from "ink";
import { useMemo } from "react";
import type { Obj } from "../graph.ts";
import type { Save } from "../model.ts";
import type { SeriesEntry } from "./data.ts";
import { C, S } from "./theme.ts";

export interface TeamRow { t: Obj; id: number; name: string; champ: string; member: string | null; player: boolean }

/** Every team of a save that races in a championship, with its league member if any. */
export function useTeamRows(save: Save, series: SeriesEntry | undefined): TeamRow[] {
  return useMemo(() => {
    const members = new Map((series?.cfg.members ?? []).map((m) => [m.team, m.member]));
    const player = save.data.player?.mPlayerTeam;
    return save.teams().filter((t) => t.championship).map((t) => ({
      t, id: t.teamID as number, name: t.name as string, champ: save.championshipName(save.championship(t)),
      member: members.get(t.name as string) ?? null, player: save.g.same(player, t),
    }));
  }, [save, series]);
}

/** Teams under championship headings; the window keeps the selection in view. */
export function TeamList({ rows, sel, height, width, focused, marks }: {
  rows: TeamRow[]; sel: number; height: number; width: number; focused: boolean;
  /** Extra marker per team id (e.g. pending edits). */
  marks?: Map<number, string>;
}) {
  const lines: { text: string; head?: boolean; row?: TeamRow; index?: number }[] = [];
  rows.forEach((r, i) => {
    if (i === 0 || rows[i - 1].champ !== r.champ) lines.push({ text: r.champ, head: true });
    lines.push({ text: r.name, row: r, index: i });
  });
  const selLine = lines.findIndex((l) => l.index === sel);
  const start = Math.max(0, Math.min(selLine - Math.floor(height / 2), lines.length - height));
  return (
    <Box flexDirection="column" width={width} flexShrink={0} borderStyle="round" borderColor={focused ? C.focus : C.border} paddingX={1} overflow="hidden">
      {lines.slice(start, start + height).map((l, i) => l.head ? (
        <Text key={i} color={C.accent2} bold wrap="truncate-end">{l.text}</Text>
      ) : (
        <Text key={i} wrap="truncate-end" inverse={l.index === sel && focused} bold={l.index === sel} color={l.row!.member ? C.accent : undefined}>
          {l.index === sel ? S.pointer : " "} {l.row!.player ? S.star : l.row!.member ? S.dot : " "} {l.text}{marks?.get(l.row!.id) ? <Text color={C.warn}> {marks.get(l.row!.id)}</Text> : null}
        </Text>
      ))}
      {!lines.length && <Text color={C.dim}>No team matches.</Text>}
    </Box>
  );
}
