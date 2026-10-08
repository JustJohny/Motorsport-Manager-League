// Demo mode's stand-in for the auction backend: the same rules, kept in memory.
import { bidCost, buyout, DEFAULT_SETTINGS, minWage, nextMinBid } from "./rules"
import type { Auction, OwnBid, PublicBid, TransferWindow } from "./transfers"
import type { League } from "./league"
import type { LeagueMemberRow, Person } from "./types"

const JOB_FOR: Record<string, string> = { Driver: "Driver", Engineer: "EngineerLead", Mechanic: "Mechanic" }

export function createDemoStore(league: League) {
  const s = DEFAULT_SETTINGS
  const date = league.snapshot.gameDate
  // Newest first, like the database query. An earlier, applied window gives the history something to show.
  const windows: TransferWindow[] = [
    { id: 2, snapshot_id: 0, opens_at: new Date().toISOString(), closes_at: new Date(Date.now() + 2 * 86400_000).toISOString(), status: "open" },
    { id: 1, snapshot_id: 0, opens_at: new Date(Date.now() - 30 * 86400_000).toISOString(), closes_at: new Date(Date.now() - 27 * 86400_000).toISOString(), status: "applied" },
  ]
  const auctions: Auction[] = []
  const bids: OwnBid[] = []
  let ids = 1

  const staffOf = (team: string) => league.snapshot.teams.find((t) => t.name === team)?.staff ?? []
  const aiTeamOf = (guid: string) => league.snapshot.teams.find((t) => !t.member && t.staff.some((s) => s.person?.guid === guid))?.name ?? null
  const findPerson = (guid: string): Person | undefined =>
    league.freeAgents.find((p) => p.guid === guid) ?? league.snapshot.teams.flatMap((t) => t.staff).find((s) => s.person?.guid === guid)?.person ?? undefined

  const store = {
    windows: () => windows.map((w) => ({ ...w })),
    auctions: (windowId = windows[0]?.id) => auctions.filter((a) => a.window_id === windowId).map((a) => ({ ...a })),
    bidsOf: (team: string) => bids.filter((b) => b.team === team),
    history: (auctionId: number): PublicBid[] => bids.filter((b) => b.auction_id === auctionId).reverse(),
    // No `mmsave pull` in demo mode: opening a window marks the previous one applied.
    openWindow(closesAt: Date) {
      for (const w of windows) w.status = "applied"
      windows.unshift({ id: windows[0].id + 1, snapshot_id: 0, opens_at: new Date().toISOString(), closes_at: closesAt.toISOString(), status: "open" })
    },
    setDeadline(closesAt: Date) { if (windows[0]?.status === "open") windows[0].closes_at = closesAt.toISOString() },
    openAuction(me: LeagueMemberRow, guid: string, windowId?: number) {
      const existing = auctions.find((a) => a.person_guid === guid && a.window_id === windows[0].id)
      if (existing) return existing.id
      const person = findPerson(guid)
      if (!person) throw new Error("Unknown person")
      const from = aiTeamOf(guid)
      if (!from && !league.freeAgents.includes(person)) throw new Error(`${person.name} is under contract at a member team`)
      const a: Auction = {
        id: ids++, window_id: windowId ?? windows[0].id, person_guid: guid, person, kind: person.kind as Auction["kind"], from_team: from,
        min_wage: minWage(person, s), buyout: from ? buyout(person, date, s) : 0, opened_by: me.team,
        leading_team: null, leading_wage: null, leading_years: null, bid_count: 0, updated_at: new Date().toISOString(),
      }
      auctions.push(a)
      return a.id
    },
    /** Like the nominate RPC: a refused opening bid leaves no auction behind. */
    nominate(me: LeagueMemberRow, guid: string, wage: number, years: number, replacing: string) {
      const before = auctions.length
      const id = store.openAuction(me, guid)
      try { store.placeBid(me, id, wage, years, replacing) } catch (e) { auctions.length = before; throw e }
    },
    placeBid(me: LeagueMemberRow, auctionId: number, wage: number, years: number, replacing: string) {
      const a = auctions.find((x) => x.id === auctionId)!
      if (a.leading_team === me.team) throw new Error("You are already the highest bidder")
      const min = nextMinBid(a.min_wage, a.leading_wage, s)
      if (wage < min) throw new Error(`The minimum bid is $${min.toLocaleString()}`)
      const out = staffOf(me.team).find((x) => x.person?.guid === replacing && x.job === JOB_FOR[a.kind])?.person
      if (!out) throw new Error(`Choose a ${a.kind.toLowerCase()} from your team to replace`)
      const leading = auctions.filter((x) => x.leading_team === me.team && x.id !== a.id)
        .map((x) => bids.filter((b) => b.auction_id === x.id && b.team === me.team).at(-1)!)
      if (leading.some((b) => b.replacing_guid === replacing)) throw new Error(`${out.name} is already being replaced by another auction you lead`)
      const cost = bidCost(wage, a.buyout, out.contract.yearlyWages, date, s).total
      const budget = league.privateTeams[me.team]?.budget ?? 0
      const committed = leading.reduce((sum, b) => sum + b.cost, 0)
      if (committed + cost > budget) throw new Error(`Not enough budget: this bid needs $${cost.toLocaleString()} and your leading bids already commit $${committed.toLocaleString()} of $${budget.toLocaleString()}`)
      bids.push({ id: ids++, auction_id: a.id, team: me.team, yearly_wage: wage, years, replacing_guid: replacing, replacing_name: out.name, cost, created_at: new Date().toISOString() })
      Object.assign(a, { leading_team: me.team, leading_wage: wage, leading_years: years, bid_count: a.bid_count + 1, updated_at: new Date().toISOString() })
    },
  }

  // Seed: rivals have opened a few auctions and bid on them, in the running and the past window.
  const rival = league.snapshot.teams.find((t) => t.member && t.name !== league.members.find((m) => m.role === "organizer")?.team)
  if (rival) {
    const rivalMe: LeagueMemberRow = { discord_username: "rival", member: rival.member!, team: rival.name, role: "member" }
    const picks = [...league.freeAgents].filter((p) => p.kind === "Driver").sort((x, y) => (y.potential ?? 0) - (x.potential ?? 0)).slice(0, 2)
    const mech = league.freeAgents.find((p) => p.kind === "Mechanic")
    const drivers = staffOf(rival.name).filter((x) => x.job === "Driver" && x.person).map((x) => x.person!)
    picks.forEach((p, i) => {
      const id = store.openAuction(rivalMe, p.guid)
      try { store.placeBid(rivalMe, id, minWage(p, s), 2, drivers[i].guid) } catch { /* budget: leave unbid */ }
    })
    if (mech) store.openAuction(rivalMe, mech.guid)
    // Window #1 (applied): one signing and one auction nobody bid on.
    const past = league.freeAgents.filter((p) => p.kind === "Engineer").slice(0, 2)
    const eng = staffOf(rival.name).find((x) => x.job === "EngineerLead")?.person
    past.forEach((p, i) => {
      const id = store.openAuction(rivalMe, p.guid, 1)
      const a = auctions.find((x) => x.id === id)!
      if (i === 0 && eng) Object.assign(a, { leading_team: rival.name, leading_wage: a.min_wage + 20_000, leading_years: 2, bid_count: 3 })
    })
  }
  return store
}
