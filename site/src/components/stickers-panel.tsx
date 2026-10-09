import { Check, Clock, ImageUp, Loader2, Sticker, Trash2, Undo2, X } from "lucide-react"
import { useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { useLeague } from "@/lib/league"
import { STICKER_SPOTS, stickerUrl, useStickers, type StickerRow } from "@/lib/stickers"

/** A sticker image in MM's 2:1 decal shape, on a checkerboard so transparency shows. */
function Decal({ row }: { row?: StickerRow }) {
  return (
    <div className="flex aspect-[2/1] w-full items-center justify-center overflow-hidden rounded-md border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
      {row ? <img src={stickerUrl(row.path)} alt={row.sponsor_name} className="h-full w-full object-contain" /> : <span className="text-xs text-muted-foreground">Blank</span>}
    </div>
  )
}

/**
 * The team's car stickers: a sponsor name and logo on each of MM's six decal spots. They only
 * decorate the car (the league game patch puts them on it); MM's sponsor deals pay but don't show.
 */
export function StickersPanel({ team, own }: { team: string; own: boolean }) {
  const { me } = useLeague()
  const s = useStickers(team, me.team)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        What's painted on the car, in game and on the site. Stickers don't earn money or affect the game; your sponsor deals pay but don't show
        on the car. Each upload is fitted to MM's 2:1 decal shape (a PNG with a transparent background works best) and goes on the car once the
        organizer approves it. An empty spot stays blank.
      </p>
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {STICKER_SPOTS.map((label, slot) => (
          <SpotCard key={slot} label={label} slot={slot} own={own} onError={setError}
            approved={s.rows.find((r) => r.slot === slot && r.status === "approved")}
            pending={s.rows.find((r) => r.slot === slot && r.status === "pending")}
            rejected={s.rows.filter((r) => r.slot === slot && r.status === "rejected").at(-1)}
            actions={s} />
        ))}
      </div>
    </div>
  )
}

function SpotCard({ label, slot, own, approved, pending, rejected, actions, onError }: {
  label: string; slot: number; own: boolean; approved?: StickerRow; pending?: StickerRow; rejected?: StickerRow
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
        <CardTitle className="flex items-center gap-2 text-sm"><Sticker className="size-4 text-muted-foreground" /> {label}</CardTitle>
        <CardDescription>{approved ? approved.sponsor_name : "No sticker"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Decal row={approved} />
        {own && approved && !pending && (
          <Button size="sm" variant="ghost" className="self-start" disabled={busy} onClick={() => void run(() => actions.remove(slot))}><Trash2 /> Take off</Button>
        )}
        {pending && (
          <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-2">
            <span className="flex items-center gap-1.5 text-xs"><Clock className="size-3.5" /> Waiting for approval: <b>{pending.sponsor_name}</b></span>
            <Decal row={pending} />
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
            <span><b>{r.team}</b> · {STICKER_SPOTS[r.slot]} · {r.sponsor_name}</span>
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
