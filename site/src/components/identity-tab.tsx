import { Check, Hourglass, ImageUp, Loader2, Lock, Paintbrush, Palette, RotateCcw, Save, Search, Shield, TriangleAlert, X } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { CLASH_DISTANCE, colourDistance } from "../../../src/livery-tint.ts"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { LiveryPreview } from "@/components/livery-preview"
import { useLeague } from "@/lib/league"
import { stickerUrl, useStickers } from "@/lib/stickers"
import { LOGO_TYPES, lookColours, useTeamLook, type TeamLogoRow } from "@/lib/team-look"
import { cn } from "@/lib/utils"
import type { LiveryOption, TeamColours } from "@/lib/types"

const FIELDS: { key: keyof TeamColours; label: string; hint: string }[] = [
  { key: "primary", label: "Primary", hint: "Car body, team colour in MM's screens, staff shirts, helmets" },
  { key: "secondary", label: "Secondary", hint: "Second livery colour, staff trousers" },
  { key: "tertiary", label: "Tertiary", hint: "Third livery colour, helmet detail" },
  { key: "trim", label: "Trim", hint: "Pinstripes and edges" },
]

// three.js is big; only the identity tab of an FF20 league loads it.
const LiveryCar3D = lazy(() => import("@/components/livery-car-3d"))

/** MM numbers the Livery Pack's patterns from 1 again; FF20's own designs carry a name. */
const patternName = (l: LiveryOption) => l.name ?? (l.dlc ? `Livery Pack ${l.number}` : `Pattern ${l.number}`)

/** FF20's designs first (the ones teams run, then the rest), then MM's patterns. */
const liveryOrder = (l: LiveryOption) => (l.name ? 0 : 2) - (l.usedBy?.length ? 1 : 0)

const FALLBACK: TeamColours = { primary: "#797979", secondary: "#f3f3f3", tertiary: "#232323", trim: "#f3f3f3" }
const HEX = /^#[0-9a-f]{6}$/i

export function IdentityTab({ team, own }: { team: string; own: boolean }) {
  const { league } = useLeague()
  const tl = useTeamLook()
  const pub = league.snapshot.teams.find((t) => t.name === team)
  const liveries = league.snapshot.championship.liveries
  if (!pub?.look || !liveries?.length) {
    return <Alert><AlertDescription>The latest publish has no livery data yet; it appears after the organizer publishes again.</AlertDescription></Alert>
  }
  const saved = tl.looks.find((r) => r.team === team)
  const isPlayer = pub.isPlayerTeam
  return (
    <LookEditor
      key={`${team}:${saved?.updated_at ?? ""}`}
      team={team}
      own={own}
      editable={own && !isPlayer}
      isPlayer={isPlayer}
      liveries={liveries}
      initialColours={saved ? lookColours(saved) : pub.look.colours ?? FALLBACK}
      initialLivery={saved?.livery_id ?? pub.look.liveryID}
      status={!saved ? "game" : pub.look.colorID === saved.color_id && pub.look.liveryID === saved.livery_id ? "applied" : "waiting"}
    />
  )
}

function LookEditor({ team, own, editable, isPlayer, liveries, initialColours, initialLivery, status }: {
  team: string; own: boolean; editable: boolean; isPlayer: boolean; liveries: LiveryOption[]
  initialColours: TeamColours; initialLivery: number; status: "game" | "applied" | "waiting"
}) {
  const { league, me } = useLeague()
  // Approved stickers; on your own car a pending upload shows in their place, as a preview.
  const stickerRows = useStickers(team, me.team).rows
  const stickers = Array.from({ length: 6 }, (_, slot) => {
    const row = (own ? stickerRows.find((r) => r.slot === slot && r.status === "pending") : undefined)
      ?? stickerRows.find((r) => r.slot === slot && r.status === "approved")
    return row ? stickerUrl(row.path) : null
  })
  const tl = useTeamLook()
  const [colours, setColours] = useState(initialColours)
  const [liveryId, setLiveryId] = useState(initialLivery)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const livery = liveries.find((l) => l.id === liveryId) ?? liveries[0]
  const [query, setQuery] = useState("")
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return liveries
      .filter((l) => !q || patternName(l).toLowerCase().includes(q) || (l.usedBy ?? []).some((t) => t.toLowerCase().includes(q)))
      .sort((a, b) => liveryOrder(a) - liveryOrder(b) || a.id - b.id)
  }, [liveries, query])
  const valid = Object.values(colours).every((c) => HEX.test(c))
  const shownColours = valid ? colours : initialColours
  const dirty = liveryId !== initialLivery || FIELDS.some((f) => colours[f.key].toLowerCase() !== initialColours[f.key].toLowerCase())
  const clashes = valid ? league.snapshot.teams
    .filter((t) => t.name !== team)
    .map((t) => ({ team: t.name, primary: tl.coloursOf(t.name)?.primary }))
    .filter((t) => t.primary && colourDistance(t.primary, colours.primary) < CLASH_DISTANCE) : []
  const logo = tl.approvedLogo(team)

  const save = async () => {
    setBusy(true); setError(null)
    try { await tl.save(Object.fromEntries(Object.entries(colours).map(([k, v]) => [k, v.toLowerCase()])) as unknown as TeamColours, liveryId) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="flex flex-col gap-4">
      {isPlayer && (
        <Alert>
          <Lock />
          <AlertTitle>Set in game</AlertTitle>
          <AlertDescription>The career team's colours, livery and logo are stored with the career itself; change them in MM.</AlertDescription>
        </Alert>
      )}

      <Card size="sm">
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-h-12 items-center rounded-md bg-neutral-900 px-3 py-1.5">
              {logo
                ? <img src={tl.logoUrl(logo)} alt={`${team} logo`} className="h-10 max-w-48 object-contain" />
                : <span className="flex items-center gap-1.5 text-xs text-neutral-400"><Shield className="size-4" /> MM's logo</span>}
            </div>
            <StatusBadge status={status} dirty={dirty} />
          </div>
          {livery.model && livery.texture ? (
            <Suspense fallback={<LiveryPreview livery={livery} colours={shownColours} className="rounded-lg" />}>
              <LiveryCar3D model={livery.model} texture={livery.texture} colours={shownColours} stickers={stickers} />
            </Suspense>
          ) : (
            <LiveryPreview livery={livery} colours={shownColours} className="rounded-lg" />
          )}
          <p className="text-xs text-muted-foreground">
            {livery.model
              ? <>{patternName(livery)}{livery.usedBy?.length ? ` (run by ${livery.usedBy.join(", ")})` : ""} on FIRE Fantasy 20's car, painted the way the game paints it, with the team's stickers{own ? " (pending ones as a preview)" : ""}.</>
              : <>{patternName(livery)}, seen from the side. MM paints it onto the 3D car, so the race view differs in detail.</>}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Section icon={<Palette className="size-4" />} title="Colours" description={editable ? "Pick any colours. MM derives the UI, helmet and sponsor shades from them." : "This team's colours."}>
          <div className="flex flex-col gap-3">
            {FIELDS.map((f) => (
              <ColourField key={f.key} label={f.label} hint={f.hint} value={colours[f.key]} disabled={!editable}
                onChange={(v) => setColours((c) => ({ ...c, [f.key]: v }))} />
            ))}
            {clashes.length > 0 && (
              <Alert className="border-amber-500/40 text-amber-700 dark:text-amber-300">
                <TriangleAlert />
                <AlertTitle>Close to another team</AlertTitle>
                <AlertDescription>
                  The primary colour looks like {clashes.map((c) => c.team).join(", ")}'s on track. It's allowed; viewers may mix the cars up.
                </AlertDescription>
              </Alert>
            )}
          </div>
        </Section>

        <Section icon={<Paintbrush className="size-4" />} title="Livery pattern" description={editable ? "Every pattern MM offers in this championship, in your colours." : "Patterns available in this championship."}>
          {liveries.length > 12 && (
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${liveries.length} liveries by name or team`} className="pl-8" />
            </div>
          )}
          <div className="grid max-h-[28rem] grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-3">
            {shown.map((l) => (
              <button key={l.id} type="button" disabled={!editable} onClick={() => setLiveryId(l.id)}
                className={cn("flex min-w-0 flex-col gap-1 rounded-md p-1 text-left ring-1 ring-border transition",
                  editable && "hover:ring-primary/60", l.id === liveryId && "ring-2 ring-primary")}>
                <LiveryPreview livery={l} colours={shownColours} />
                <span className="flex items-center justify-between gap-1 px-0.5 text-xs">
                  <span className="truncate">{patternName(l)}</span>
                  {l.id === liveryId && <Check className="size-3.5 shrink-0 text-primary" />}
                </span>
                {l.usedBy?.length ? <span className="truncate px-0.5 text-[11px] text-muted-foreground" title={l.usedBy.join(", ")}>{l.usedBy.join(", ")}</span> : null}
              </button>
            ))}
            {!shown.length && <p className="col-span-full py-6 text-center text-sm text-muted-foreground">No livery matches "{query}".</p>}
          </div>
        </Section>
      </div>

      {editable && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 px-4 py-2 text-sm">
          <Button onClick={() => void save()} disabled={!dirty || !valid || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />} Save look
          </Button>
          <Button variant="ghost" disabled={!dirty || busy} onClick={() => { setColours(initialColours); setLiveryId(initialLivery) }}>
            <RotateCcw /> Reset
          </Button>
          <span className="text-xs text-muted-foreground">Change it any time; the organizer applies it before the next race.</span>
          {error && <span className="text-destructive">{error}</span>}
        </div>
      )}

      <LogoSection team={team} editable={editable} />
    </div>
  )
}

function StatusBadge({ status, dirty }: { status: "game" | "applied" | "waiting"; dirty: boolean }) {
  if (dirty) return <Badge variant="outline">Unsaved changes</Badge>
  if (status === "waiting") return <Badge variant="secondary"><Hourglass /> Saved · in game after the next race</Badge>
  if (status === "applied") return <Badge><Check /> In game</Badge>
  return <Badge variant="outline">MM's own look</Badge>
}

function Section({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{icon} {title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function ColourField({ label, hint, value, disabled, onChange }: { label: string; hint: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <div className="flex items-center gap-3">
      <input type="color" aria-label={`${label} colour`} value={HEX.test(value) ? value : "#000000"} disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 disabled:cursor-default" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="truncate text-xs text-muted-foreground" title={hint}>{hint}</span>
      </div>
      <Input value={text} disabled={disabled} className={cn("w-24 font-mono text-xs", !HEX.test(text) && "border-destructive")}
        onChange={(e) => {
          const v = e.target.value.trim()
          setText(v)
          const hex = v.startsWith("#") ? v : `#${v}`
          if (HEX.test(hex)) onChange(hex.toLowerCase())
        }} />
    </div>
  )
}

const LOGO_STATUS: Record<TeamLogoRow["status"], string> = {
  pending: "Waiting for the organizer", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn", replaced: "Replaced",
}

function LogoSection({ team, editable }: { team: string; editable: boolean }) {
  const tl = useTeamLook()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const approved = tl.approvedLogo(team)
  const pending = tl.logos.find((l) => l.team === team && l.status === "pending")
  const rejected = [...tl.logos].reverse().find((l) => l.team === team && l.status === "rejected")
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Section icon={<Shield className="size-4" />} title="Logo"
      description={editable ? "Shown on MM's team screens, standings, hats and shirts. The organizer approves each upload." : "This team's logo."}>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <LogoCard title="In use" logo={approved} empty="MM's own logo" />
          {(pending || editable) && (
            <LogoCard title={pending ? LOGO_STATUS.pending : "Upload"} logo={pending} empty="No upload waiting"
              action={pending && editable && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => tl.withdrawLogo(pending.id))}><X /> Withdraw</Button>
              )} />
          )}
        </div>
        {rejected && !pending && editable && (
          <Alert variant="destructive">
            <AlertTitle>Last upload rejected</AlertTitle>
            <AlertDescription>{rejected.note || "No reason given."}</AlertDescription>
          </Alert>
        )}
        {editable && (
          <div className="flex flex-wrap items-center gap-3">
            <input ref={input} type="file" accept={LOGO_TYPES.join(",")} className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(() => tl.uploadLogo(f)) }} />
            <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
              {busy ? <Loader2 className="animate-spin" /> : <ImageUp />} {pending ? "Replace upload" : "Upload logo"}
            </Button>
            <span className="text-xs text-muted-foreground">PNG with a transparent background works best, about 3:1 wide (MM's is 307×106), up to 1 MB.</span>
          </div>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </Section>
  )
}

function LogoCard({ title, logo, empty, action }: { title: string; logo: TeamLogoRow | undefined; empty: string; action?: ReactNode }) {
  const tl = useTeamLook()
  return (
    <div className="flex flex-col gap-1.5 rounded-md border p-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{title}</span>{action}</div>
      <div className="flex h-20 items-center justify-center rounded bg-neutral-900">
        {logo ? <img src={tl.logoUrl(logo)} alt="" className="max-h-16 max-w-[90%] object-contain" /> : <span className="text-xs text-neutral-400">{empty}</span>}
      </div>
    </div>
  )
}
