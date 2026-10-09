import { Check, Clock, ImageUp, Loader2, Scaling, Sticker, Trash2, Undo2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useLeague } from "@/lib/league"
import { STICKER_SCALE, stickerSpots, stickerUrl, useStickers, type StickerRow, type StickerSpot } from "@/lib/stickers"

// A checkerboard from two linear gradients: a repeating conic gradient garbled the page on some
// Android GPUs (Brave on a phone, 2026-10-09).
const CHECKER = {
  backgroundImage: "linear-gradient(45deg, var(--muted) 25%, transparent 25%, transparent 75%, var(--muted) 75%),"
    + " linear-gradient(45deg, var(--muted) 25%, transparent 25%, transparent 75%, var(--muted) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
}

/** A sticker image in MM's 2:1 decal shape at its size (cut off at the edges above 100 %), on a checkerboard so transparency shows. */
function Decal({ row, scale }: { row?: StickerRow; scale?: number }) {
  const size = `${(scale ?? row?.scale ?? 1) * 100}%`
  return (
    <div className="flex aspect-[2/1] w-full items-center justify-center overflow-hidden rounded-md border" style={CHECKER}>
      {row ? <img src={stickerUrl(row.path)} alt={row.sponsor_name} className="max-w-none shrink-0 object-contain" style={{ width: size, height: size }} /> : <span className="text-xs text-muted-foreground">Blank</span>}
    </div>
  )
}

/** The sticker's size; saved shortly after the slider stops, without a new approval. */
function ScaleSlider({ row, onScale }: { row: StickerRow; onScale: (scale: number) => Promise<void> }) {
  const saved = row.scale ?? 1
  const [value, setValue] = useState(saved)
  useEffect(() => setValue(saved), [saved])
  useEffect(() => {
    if (value === saved) return
    const t = setTimeout(() => void onScale(value), 400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return (
    <div className="flex flex-col gap-1.5">
      <Decal row={row} scale={value} />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Scaling className="size-3.5 shrink-0" /> Size
        <input type="range" min={STICKER_SCALE.min} max={STICKER_SCALE.max} step={0.05} value={value}
          onChange={(e) => setValue(Number(e.target.value))} className="flex-1 accent-primary" aria-label={`Size of ${row.sponsor_name}`} />
        <span className="w-9 text-right tabular-nums">{Math.round(value * 100)}%</span>
      </label>
    </div>
  )
}

/**
 * The team's car stickers: a sponsor name and logo on each of MM's six decal spots. They only
 * decorate the car (the league game patch puts them on it); MM's sponsor deals pay but don't show.
 */
export function StickersPanel({ team, own }: { team: string; own: boolean }) {
  const { me, league } = useLeague()
  const s = useStickers(team, me.team)
  const spots = stickerSpots(league.snapshot.championship.game)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        What's painted on the car, in game and on the site. Stickers don't earn money or affect the game; your sponsor deals pay but don't show
        on the car. Each upload is fitted to MM's 2:1 decal shape (a PNG with a transparent background works best) and goes on the car once the
        organizer approves it. An empty spot stays blank. Each spot can cover several places on the car. The size can be changed any time
        without a new approval; above 100 % the sticker is cut off at the spot's edges.
      </p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {spots.map((spot, slot) => (
          <SpotCard key={slot} spot={spot} slot={slot} own={own} onError={setError}
            approved={s.rows.find((r) => r.slot === slot && r.status === "approved")}
            pending={s.rows.find((r) => r.slot === slot && r.status === "pending")}
            rejected={s.rows.filter((r) => r.slot === slot && r.status === "rejected").at(-1)}
            actions={s} />
        ))}
      </div>
    </div>
  )
}

function SpotCard({ spot, slot, own, approved, pending, rejected, actions, onError }: {
  spot: StickerSpot; slot: number; own: boolean; approved?: StickerRow; pending?: StickerRow; rejected?: StickerRow
  actions: ReturnType<typeof useStickers>; onError: (e: string | null) => void
}) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); onError(null)
    try { await fn() } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><Sticker className="size-4 text-muted-foreground" /> {spot.name}</CardTitle>
        <CardDescription>
          {approved ? approved.sponsor_name : "No sticker"}
          {spot.alsoOn.length > 0 && <span className="block text-xs">Also on the {spot.alsoOn.join(", ")}</span>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {own && approved ? <ScaleSlider row={approved} onScale={(v) => run(() => actions.setScale(approved.id, v))} /> : <Decal row={approved} />}
        {own && approved && !pending && (
          <Button size="sm" variant="ghost" className="self-start" disabled={busy} onClick={() => void run(() => actions.remove(slot))}><Trash2 /> Take off</Button>
        )}
        {pending && (
          <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-2">
            <span className="flex items-center gap-1.5 text-xs"><Clock className="size-3.5" /> Waiting for approval: <b>{pending.sponsor_name}</b></span>
            {own ? <ScaleSlider row={pending} onScale={(v) => run(() => actions.setScale(pending.id, v))} /> : <Decal row={pending} />}
            {own && <Button size="sm" variant="ghost" className="self-start" disabled={busy} onClick={() => void run(() => actions.withdraw(pending.id))}><Undo2 /> Withdraw</Button>}
          </div>
        )}
        {rejected && !pending && own && (
          <span className="text-xs text-destructive">Last upload ({rejected.sponsor_name}) rejected{rejected.note ? `: ${rejected.note}` : ""}</span>
        )}
        {own && (
          <div className="flex flex-col gap-1.5">
            <Input placeholder="Sponsor name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            <input ref={file} type="file" accept="image/png,image/webp,image/jpeg" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(async () => { await actions.submit(slot, name, f); setName("") }) }} />
            <Button size="sm" variant="outline" disabled={busy || !name.trim()} onClick={() => file.current?.click()}>
              {busy ? <Loader2 className="animate-spin" /> : <ImageUp />} {approved || pending ? "Upload a new one" : "Upload sticker"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The organizer's queue of uploaded stickers. */
export function StickerReviewCard() {
  const { me } = useLeague()
  const s = useStickers(null, me.team)
  const [busy, setBusy] = useState<number | null>(null)
  const pending = s.rows.filter((r) => r.status === "pending")
  const spots = stickerSpots(useLeague().league.snapshot.championship.game)
  const review = async (id: number, approve: boolean) => {
    setBusy(id)
    try { await s.review(id, approve, approve ? undefined : window.prompt("Why (shown to the team)?") ?? undefined) } finally { setBusy(null) }
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Sticker className="size-4" /> Car stickers to approve <Badge variant="secondary">{pending.length}</Badge></CardTitle>
        <CardDescription>Approved stickers go on the cars after <code>mmsave stickers --league … --game …</code> (needs the league game patch).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pending.length === 0 && <span className="text-sm text-muted-foreground">Nothing waiting.</span>}
        {pending.map((r) => (
          <div key={r.id} className="flex flex-col gap-1.5 rounded-md border p-2 text-sm">
            <span><b>{r.team}</b> · {spots[r.slot].name} · {r.sponsor_name}</span>
            <Decal row={r} />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy != null} onClick={() => void review(r.id, true)}>{busy === r.id ? <Loader2 className="animate-spin" /> : <Check />} Approve</Button>
              <Button size="sm" variant="outline" disabled={busy != null} onClick={() => void review(r.id, false)}><X /> Reject</Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
