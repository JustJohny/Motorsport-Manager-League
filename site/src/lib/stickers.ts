import { useCallback, useEffect, useState } from "react"
import { demoMode, seriesId, supabase, watchTable } from "./supabase"

export interface StickerRow {
  id: number
  team: string
  slot: number
  sponsor_name: string
  path: string
  status: "pending" | "approved" | "rejected" | "withdrawn" | "replaced" | "removed"
  note: string | null
  created_at: string
  /** Share of the spot, 0.25..1 (migration 027; missing before it). */
  scale?: number
}

export { STICKER_SCALE, stickerSpots, type StickerSpot } from "../../../src/sticker-spots.ts"
/** MM's car decals are 2:1 (FF20's are 2048 x 1024); uploads are padded to this. */
const W = 1024, H = 512
const MAX_BYTES = 2 * 1024 * 1024

// Demo mode keeps uploads as object URLs.
const demoFiles = new Map<string, string>()
let demoRows: StickerRow[] = []

export function stickerUrl(path: string): string {
  if (demoMode) return demoFiles.get(path) ?? ""
  return supabase!.storage.from("team-stickers").getPublicUrl(path).data.publicUrl
}

/** Fit the image inside MM's 2:1 decal on a transparent background, as a PNG. */
async function padToDecal(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => bad(new Error("That file isn't an image the browser can read"))
      i.src = url
    })
    const scale = Math.min(W / img.naturalWidth, H / img.naturalHeight)
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale
    const canvas = document.createElement("canvas")
    canvas.width = W
    canvas.height = H
    canvas.getContext("2d")!.drawImage(img, (W - w) / 2, (H - h) / 2, w, h)
    return await new Promise<Blob>((ok, bad) => canvas.toBlob((b) => (b ? ok(b) : bad(new Error("Couldn't convert the image"))), "image/png"))
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

/**
 * Car stickers (migration 024): approved ones for everyone, plus the team's own pending and rejected
 * ones (the organizer sees every team's). `team` null loads every team's.
 */
export function useStickers(team: string | null, me: string) {
  const [rows, setRows] = useState<StickerRow[]>(demoMode ? demoRows : [])
  const reload = useCallback(async () => {
    if (demoMode) return setRows([...demoRows])
    let q = supabase!.from("team_stickers").select("*").in("status", ["pending", "approved", "rejected"]).order("id")
    if (team) q = q.eq("team", team)
    // Before migration 024 the table doesn't exist: no stickers.
    setRows(((await check(q).catch(() => [])) ?? []) as StickerRow[])
  }, [team])
  useEffect(() => {
    void reload()
    if (demoMode) return
    const ch = watchTable(supabase!.channel(`stickers-${team ?? "all"}`), "team_stickers", () => void reload()).subscribe()
    return () => void supabase!.removeChannel(ch)
  }, [reload, team])

  const demo = (f: (r: StickerRow[]) => StickerRow[]) => { demoRows = f(demoRows); setRows([...demoRows]) }
  return {
    rows,
    submit: async (slot: number, sponsorName: string, file: File) => {
      if (!sponsorName.trim()) throw new Error("Give the sponsor a name")
      if (!file.type.startsWith("image/")) throw new Error("Upload an image (a PNG with a transparent background works best)")
      const blob = await padToDecal(file)
      if (blob.size > MAX_BYTES) throw new Error("The sticker must be 2 MB or smaller")
      const path = `${seriesId() ?? "demo"}/${crypto.randomUUID()}.png`
      if (demoMode) {
        demoFiles.set(path, URL.createObjectURL(blob))
        return demo((rs) => [...rs.map((r) => (r.team === me && r.slot === slot && r.status === "pending" ? { ...r, status: "withdrawn" as const } : r)),
          { id: Date.now(), team: me, slot, sponsor_name: sponsorName.trim(), path, status: "pending", note: null, created_at: new Date().toISOString() }])
      }
      await check(supabase!.storage.from("team-stickers").upload(path, blob, { contentType: "image/png" }))
      await check(supabase!.rpc("submit_sticker", { slot, sponsor_name: sponsorName, path }))
      await reload()
    },
    withdraw: async (id: number) => {
      if (demoMode) return demo((rs) => rs.filter((r) => r.id !== id))
      await check(supabase!.rpc("withdraw_sticker", { sticker_id: id }))
      await reload()
    },
    remove: async (slot: number) => {
      if (demoMode) return demo((rs) => rs.filter((r) => !(r.team === me && r.slot === slot && r.status === "approved")))
      await check(supabase!.rpc("remove_sticker", { slot }))
      await reload()
    },
    setScale: async (id: number, scale: number) => {
      if (demoMode) return demo((rs) => rs.map((r) => (r.id === id ? { ...r, scale } : r)))
      await check(supabase!.rpc("set_sticker_scale", { sticker_id: id, scale }))
      await reload()
    },
    review: async (id: number, approve: boolean, note?: string) => {
      if (demoMode) {
        const r = demoRows.find((x) => x.id === id)
        return demo((rs) => rs.map((x) => (x.id === id ? { ...x, status: approve ? "approved" as const : "rejected" as const, note: note ?? null }
          : approve && r && x.team === r.team && x.slot === r.slot && x.status === "approved" ? { ...x, status: "replaced" as const } : x)))
      }
      await check(supabase!.rpc("review_sticker", { sticker_id: id, approve, note: note ?? null }))
      await reload()
    },
  }
}
