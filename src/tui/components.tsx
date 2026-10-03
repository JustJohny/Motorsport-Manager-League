import { Box, Text, useInput } from "ink";
import { useState, type ReactNode } from "react";
import { C, S } from "./theme.ts";

/** A bordered panel with a title line, like a card on the site. */
export function Panel({ title, icon, right, children, focused, grow, width, height }: {
  title: string; icon?: string; right?: ReactNode; children?: ReactNode; focused?: boolean; grow?: boolean; width?: number | string; height?: number;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? C.focus : C.border} paddingX={1}
      flexGrow={grow ? 1 : 0} flexShrink={grow ? 1 : 0} width={width} height={height} overflow="hidden">
      <Box justifyContent="space-between" height={1} flexShrink={0}>
        <Box flexShrink={1}><Text bold color={focused ? C.accent : undefined} wrap="truncate-end">{icon ? `${icon} ` : ""}{title}</Text></Box>
        {right && <Box flexShrink={0} marginLeft={1}>{right}</Box>}
      </Box>
      {children}
    </Box>
  );
}

/** "[p] Publish" style hint. */
export function Key({ k, label, disabled }: { k: string; label: string; disabled?: boolean }) {
  return (
    <Text dimColor={disabled}>
      <Text color={disabled ? C.dim : C.accent2} bold>{k}</Text> {label}
    </Text>
  );
}

export function Hints({ items }: { items: [string, string, boolean?][] }) {
  return (
    <Box columnGap={2} flexWrap="wrap">
      {items.map(([k, label, disabled]) => <Key key={k + label} k={k} label={label} disabled={disabled} />)}
    </Box>
  );
}

/** A label/value pair. */
export function Field({ label, children, width = 14 }: { label: string; children: ReactNode; width?: number }) {
  return (
    <Box>
      <Box width={width} flexShrink={0}><Text color={C.dim}>{label}</Text></Box>
      <Box flexGrow={1}><Text wrap="truncate-end">{children}</Text></Box>
    </Box>
  );
}

/**
 * A scrolling list: `selected` is controlled; the window follows it. Rows render themselves so
 * screens can lay out columns.
 */
export function List<T>({ items, selected, height, render, empty = "Nothing here." }: {
  items: T[]; selected: number; height: number; render: (item: T, active: boolean, index: number) => ReactNode; empty?: string;
}) {
  if (!items.length) return <Text color={C.dim}>{empty}</Text>;
  const h = Math.max(1, height);
  const start = Math.min(Math.max(0, selected - Math.floor(h / 2)), Math.max(0, items.length - h));
  const shown = items.slice(start, start + h);
  return (
    <Box flexDirection="column">
      {shown.map((it, i) => (
        <Box key={start + i}>
          <Text color={start + i === selected ? C.accent : C.dim}>{start + i === selected ? S.pointer : " "} </Text>
          <Box flexGrow={1}>{render(it, start + i === selected, start + i)}</Box>
        </Box>
      ))}
      {items.length > h && <Text color={C.dim}>{start > 0 ? S.up : " "} {selected + 1}/{items.length} {start + h < items.length ? S.down : " "}</Text>}
    </Box>
  );
}

/** Up/down/page/home/end over a list of `count` items. */
export function useListKeys(count: number, active: boolean, page = 10) {
  const [sel, setSel] = useState(0);
  const clamp = (n: number) => Math.max(0, Math.min(count - 1, n));
  useInput((_input, key) => {
    if (key.upArrow) setSel((s) => clamp(s - 1));
    else if (key.downArrow) setSel((s) => clamp(s + 1));
    else if (key.pageUp) setSel((s) => clamp(s - page));
    else if (key.pageDown) setSel((s) => clamp(s + page));
    else if (key.home) setSel(0);
    else if (key.end) setSel(clamp(count - 1));
  }, { isActive: active });
  return [Math.min(sel, Math.max(0, count - 1)), setSel] as const;
}

/** A one-line text field. Enter submits, Esc cancels. */
export function TextInput({ value, onChange, onSubmit, onCancel, placeholder }: {
  value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; onCancel: () => void; placeholder?: string;
}) {
  useInput((input, key) => {
    if (key.return) onSubmit(value);
    else if (key.escape) onCancel();
    else if (key.backspace || key.delete) onChange(value.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && !key.tab && !key.upArrow && !key.downArrow) onChange(value + input);
  });
  return (
    <Box borderStyle="single" borderColor={C.accent2} paddingX={1}>
      <Text>{value || <Text color={C.dim}>{placeholder}</Text>}<Text inverse> </Text></Text>
    </Box>
  );
}

export type ModalSpec =
  | { kind: "confirm"; title: string; lines?: ReactNode[]; yes?: string; danger?: boolean; onYes: () => void; onNo?: () => void }
  | { kind: "input"; title: string; lines?: ReactNode[]; value: string; placeholder?: string; validate?: (v: string) => string | null; onSubmit: (v: string) => void; onCancel?: () => void }
  | { kind: "info"; title: string; lines: ReactNode[]; tone?: "ok" | "bad" | "warn"; onClose?: () => void }
  | { kind: "busy"; title: string; lines?: ReactNode[] };

/** A dialog drawn over the screen: confirm (y/n), text input, a message, or "working". */
export function Modal({ spec, close, width }: { spec: ModalSpec; close: () => void; width: number }) {
  const [value, setValue] = useState(spec.kind === "input" ? spec.value : "");
  const [error, setError] = useState<string | null>(null);
  useInput((input, key) => {
    if (spec.kind === "confirm") {
      if (input === "y" || input === "Y") { close(); spec.onYes(); }
      else if (input === "n" || input === "N" || key.escape) { close(); spec.onNo?.(); }
    } else if (spec.kind === "info") {
      if (key.return || key.escape || input === " ") { close(); spec.onClose?.(); }
    }
  }, { isActive: spec.kind === "confirm" || spec.kind === "info" });
  const tone = spec.kind === "info" ? spec.tone : spec.kind === "confirm" && spec.danger ? "bad" : undefined;
  const color = tone === "bad" ? C.bad : tone === "warn" ? C.warn : tone === "ok" ? C.ok : C.accent;
  return (
    <Box flexDirection="column" borderStyle="double" borderColor={color} paddingX={2} paddingY={1} width={width}>
      <Text bold color={color}>{spec.title}</Text>
      {(spec.kind !== "input" || spec.lines) && (spec.lines ?? []).map((l, i) => <Box key={i}>{typeof l === "string" ? <Text wrap="wrap">{l}</Text> : l}</Box>)}
      {spec.kind === "input" && (
        <>
          <TextInput value={value} placeholder={spec.placeholder} onChange={(v) => { setValue(v); setError(null); }}
            onCancel={() => { close(); spec.onCancel?.(); }}
            onSubmit={(v) => {
              const err = spec.validate?.(v.trim()) ?? null;
              if (err) return setError(err);
              close(); spec.onSubmit(v.trim());
            }} />
          {error && <Text color={C.bad}>{S.cross} {error}</Text>}
          <Hints items={[["Enter", "OK"], ["Esc", "cancel"]]} />
        </>
      )}
      {spec.kind === "confirm" && <Box marginTop={1}><Hints items={[["y", spec.yes ?? "yes"], ["n", "no"]]} /></Box>}
      {spec.kind === "info" && <Box marginTop={1}><Hints items={[["Enter", "close"]]} /></Box>}
      {spec.kind === "busy" && <Box marginTop={1}><Text color={C.dim}>{S.clock} Working… the screen updates when it's done.</Text></Box>}
    </Box>
  );
}
