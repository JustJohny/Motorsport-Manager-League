import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { createDemoStore } from "./demo-transfers"
import { useLeague } from "./league"
import { DEFAULT_SETTINGS, type LeagueSettings } from "./rules"
import { demoMode, supabase } from "./supabase"
import type { Person } from "./types"

export interface TransferWindow {
  id: number
  snapshot_id: number
  opens_at: string
  closes_at: string
  status: "open" | "applied"
}

export interface Auction {
  id: number
  window_id: number
  person_guid: string
  person: Person
  kind: "Driver" | "Engineer" | "Mechanic"
  from_team: string | null
  min_wage: number
  buyout: number
  opened_by: string
  leading_team: string | null
  leading_wage: number | null
  leading_years: number | null
  bid_count: number
  updated_at: string
}

/** A bid of the member's own team (only those, and the organizer's view, include who is replaced). */
export interface OwnBid {
  id: number
  auction_id: number
  team: string
  yearly_wage: number
  years: number
  replacing_guid: string
  replacing_name: string
  cost: number
  created_at: string
}

export interface PublicBid {
  id: number
  auction_id: number
  team: string
  yearly_wage: number
  years: number
  created_at: string
}

interface Transfers {
  settings: LeagueSettings
  transferWindow: TransferWindow | null
  /** Bidding is possible right now. */
  isOpen: boolean
  auctions: Auction[]
  myBids: OwnBid[]
  /** My leading bid per auction id. */
  myLeading: Map<number, OwnBid>
  /** What my leading bids commit from the budget. */
  committed: number
  reload: () => Promise<void>
  openAuction: (personGuid: string) => Promise<number>
  placeBid: (auctionId: number, wage: number, years: number, replacing: string) => Promise<void>
  bidHistory: (auctionId: number) => Promise<PublicBid[]>
  openWindow: (closesAt: Date) => Promise<void>
  setDeadline: (closesAt: Date) => Promise<void>
}

const TransfersContext = createContext<Transfers | null>(null)

export function useTransfers() {
  const ctx = useContext(TransfersContext)
  if (!ctx) throw new Error("useTransfers outside TransfersProvider")
  return ctx
}

/** Ticks every `ms` so countdowns re-render. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

/** Every bid on an auction, newest first, without who each team would release. */
async function bidHistory(auctionId: number) {
  return (await check(supabase!.from("bid_history").select("*").eq("auction_id", auctionId).order("created_at", { ascending: false }))) as PublicBid[]
}

export function TransfersProvider({ children }: { children: ReactNode }) {
  const { me, league } = useLeague()
  const [demo] = useState(() => (demoMode ? createDemoStore(league) : null))
  const [settings, setSettings] = useState<LeagueSettings>(DEFAULT_SETTINGS)
  const [transferWindow, setTransferWindow] = useState<TransferWindow | null>(null)
  const [auctions, setAuctions] = useState<Auction[]>([])
  const [myBids, setMyBids] = useState<OwnBid[]>([])
  const now = useNow(5000)

  const reload = useCallback(async () => {
    if (demo) {
      setTransferWindow(demo.window && { ...demo.window })
      setAuctions(demo.auctions())
      setMyBids(demo.bidsOf(me.team))
      return
    }
    const sb = supabase!
    const [s, windows] = await Promise.all([
      check(sb.from("league_settings").select("*").maybeSingle()),
      check(sb.from("transfer_windows").select("*").order("id", { ascending: false }).limit(1)),
    ])
    if (s) setSettings(s as LeagueSettings)
    const w = ((windows ?? [])[0] as TransferWindow | undefined) ?? null
    setTransferWindow(w)
    if (!w) return setAuctions([]), setMyBids([])
    const list = (await check(sb.from("auctions").select("*").eq("window_id", w.id).order("created_at"))) as Auction[]
    setAuctions(list)
    const ids = list.map((a) => a.id)
    setMyBids(ids.length
      ? ((await check(sb.from("bids").select("*").in("auction_id", ids).eq("team", me.team).order("created_at"))) as OwnBid[])
      : [])
  }, [me.team, demo])

  useEffect(() => {
    void reload()
    if (demo) return
    // Live: any change to auctions or windows reloads (cheap: one window's worth of rows).
    const channel = supabase!
      .channel("transfers")
      .on("postgres_changes", { event: "*", schema: "public", table: "auctions" }, () => void reload())
      .on("postgres_changes", { event: "*", schema: "public", table: "transfer_windows" }, () => void reload())
      .subscribe()
    return () => void supabase!.removeChannel(channel)
  }, [reload, demo])

  const myLeading = useMemo(() => {
    const m = new Map<number, OwnBid>()
    for (const a of auctions) {
      if (a.leading_team !== me.team) continue
      const bid = myBids.filter((b) => b.auction_id === a.id).at(-1)
      if (bid) m.set(a.id, bid)
    }
    return m
  }, [auctions, myBids, me.team])
  const committed = [...myLeading.values()].reduce((s, b) => s + Number(b.cost), 0)

  const value: Transfers = {
    settings,
    transferWindow,
    isOpen: !!transferWindow && transferWindow.status === "open" && Date.parse(transferWindow.closes_at) > now,
    auctions,
    myBids,
    myLeading,
    committed,
    reload,
    openAuction: async (guid) => {
      if (demo) { const id = demo.openAuction(me, guid); await reload(); return id }
      const id = (await check(supabase!.rpc("open_auction", { person_guid: guid }))) as number
      await reload()
      return id
    },
    placeBid: async (auctionId, wage, years, replacing) => {
      if (demo) return demo.placeBid(me, auctionId, wage, years, replacing), reload()
      await check(supabase!.rpc("place_bid", { auction_id: auctionId, yearly_wage: wage, years, replacing_guid: replacing }))
      await reload()
    },
    bidHistory: demo ? async (id) => demo.history(id) : bidHistory,
    openWindow: async (closesAt) => {
      if (demo) return demo.openWindow(closesAt), reload()
      await check(supabase!.rpc("open_window", { closes_at: closesAt.toISOString() }))
      await reload()
    },
    setDeadline: async (closesAt) => {
      if (demo) return demo.setDeadline(closesAt), reload()
      await check(supabase!.rpc("set_window_deadline", { closes_at: closesAt.toISOString() }))
      await reload()
    },
  }
  return <TransfersContext.Provider value={value}>{children}</TransfersContext.Provider>
}

/** "2d 4h", "3h 12m", "4m 10s". */
export function fmtCountdown(ms: number) {
  if (ms <= 0) return "closed"
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}
