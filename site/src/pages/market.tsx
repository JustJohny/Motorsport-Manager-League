import { Gavel, Search } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { BidDialog } from "@/components/bid-dialog"
import { PersonCard } from "@/components/person-card"
import { ageAt, fmtCountry, fmtMoneyShort, fmtNum, statAverage } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { buyout, minWage } from "@/lib/rules"
import { useTransfers } from "@/lib/transfers"
import type { Person } from "@/lib/types"
import { cn } from "@/lib/utils"

type Kind = "Driver" | "Engineer" | "Mechanic"
type Source = "free" | "ai"
type Sort = "avg" | "potential" | "wageAsc" | "age"

const SORTS: Record<Sort, { label: string; fn: (a: Person, b: Person, date: string) => number }> = {
  avg: { label: "Best average", fn: (a, b) => statAverage(b.stats) - statAverage(a.stats) },
  potential: { label: "Highest potential", fn: (a, b) => (b.potential ?? 0) - (a.potential ?? 0) },
  wageAsc: { label: "Cheapest", fn: (a, b) => a.contract.yearlyWages - b.contract.yearlyWages },
  age: { label: "Youngest", fn: (a, b, d) => ageAt(a.dateOfBirth, d) - ageAt(b.dateOfBirth, d) },
}

export function MarketPage() {
  const { league } = useLeague()
  const t = useTransfers()
  const navigate = useNavigate()
  const date = league.snapshot.gameDate
  const [source, setSource] = useState<Source>("free")
  // AI teams' staff can be bought out; member teams' staff can't be bid on.
  const aiStaff = useMemo(
    () => league.snapshot.teams.filter((tm) => !tm.member)
      .flatMap((tm) => tm.staff.filter((s) => s.person && ["Driver", "EngineerLead", "Mechanic"].includes(s.job)).map((s) => s.person!)),
    [league.snapshot.teams],
  )
  const pool = source === "free" ? league.freeAgents : aiStaff
  const [kind, setKind] = useState<Kind>("Driver")
  const [sort, setSort] = useState<Sort>("avg")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string | null>(null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return pool
      .filter((p) => p.kind === kind && (!q || p.name.toLowerCase().includes(q) || fmtCountry(p.nationality).toLowerCase().includes(q)))
      .sort((a, b) => SORTS[sort].fn(a, b, date))
  }, [pool, kind, sort, query, date])
  const auctionFor = (guid: string) => t.auctions.find((a) => a.person_guid === guid)
  const current = list.find((p) => p.guid === selected) ?? list[0]
  const sorts = (Object.keys(SORTS) as Sort[]).filter((s) => s !== "potential" || kind === "Driver")

  return (
    <>
      <PageHeader
        title="Staff market"
        description={t.isOpen ? "The transfer window is open: nominate someone with your opening bid to start an auction." : "Free agents and AI teams' staff. Auctions run during transfer windows."}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={source} onValueChange={(v) => { setSource(v as Source); setSelected(null) }}>
          <TabsList>
            <TabsTrigger value="free">Free agents</TabsTrigger>
            <TabsTrigger value="ai">AI teams</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={kind} onValueChange={(v) => { setKind(v as Kind); setSelected(null); if (v !== "Driver" && sort === "potential") setSort("avg") }}>
          <TabsList>
            {(["Driver", "Engineer", "Mechanic"] as const).map((k) => (
              <TabsTrigger key={k} value={k}>
                {k}s <span className="ml-1 text-muted-foreground">{pool.filter((p) => p.kind === k).length}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative min-w-48 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Name or nationality" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {sorts.map((s) => <SelectItem key={s} value={s}>{SORTS[s].label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[1fr_22rem]">
        <Card size="sm">
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Age</TableHead>
                  {source === "free" && <TableHead className="hidden sm:table-cell">Nationality</TableHead>}
                  <TableHead className="text-right">Avg</TableHead>
                  {kind === "Driver" && <TableHead className="text-right">Potential</TableHead>}
                  {source === "ai" && <TableHead>Team</TableHead>}
                  <TableHead className="text-right">{source === "ai" ? "Wage" : "Asking"}</TableHead>
                  <TableHead className="text-right">Opening bid</TableHead>
                  {source === "ai" && <TableHead className="hidden text-right md:table-cell">Buyout</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((p) => (
                  <TableRow
                    key={p.guid}
                    onClick={() => setSelected(p.guid)}
                    className={cn("cursor-pointer", p === current && "bg-primary/10 hover:bg-primary/15")}
                  >
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{ageAt(p.dateOfBirth, date)}</TableCell>
                    {source === "free" && <TableCell className="hidden sm:table-cell">{fmtCountry(p.nationality)}</TableCell>}
                    <TableCell className="text-right tabular-nums">{fmtNum(statAverage(p.stats))}</TableCell>
                    {kind === "Driver" && <TableCell className="text-right tabular-nums">{fmtNum(p.potential, 0)}</TableCell>}
                    {source === "ai" && <TableCell className="max-w-40 truncate">{p.contract.team}</TableCell>}
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtMoneyShort(p.contract.yearlyWages)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {fmtMoneyShort(minWage(p, t.settings))}
                      {auctionFor(p.guid) && <Gavel className="ml-1 inline size-3 text-primary" />}
                    </TableCell>
                    {source === "ai" && <TableCell className="hidden text-right tabular-nums md:table-cell">{fmtMoneyShort(buyout(p, date, t.settings))}</TableCell>}
                  </TableRow>
                ))}
                {!list.length && (
                  <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">Nobody matches.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <div className="flex flex-col gap-3 lg:sticky lg:top-16">
          {current && <PersonCard person={current} gameDate={date} />}
          {current && (
            auctionFor(current.guid)
              ? <Button variant="outline" onClick={() => navigate("/transfers")}><Gavel /> In auction: go to transfer window</Button>
              : t.isOpen && (
                <BidDialog
                  person={current}
                  fromTeam={source === "ai" ? current.contract.team : null}
                  trigger={<Button><Gavel /> Nominate with an opening bid from {fmtMoneyShort(minWage(current, t.settings))}</Button>}
                />
              )
          )}
        </div>
      </div>
    </>
  )
}
