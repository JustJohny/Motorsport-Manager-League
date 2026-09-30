import { Search } from "lucide-react"
import { useMemo, useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/page-header"
import { PersonCard } from "@/components/person-card"
import { ageAt, fmtCountry, fmtDate, fmtMoneyShort, fmtNum, statAverage } from "@/lib/format"
import { useLeague } from "@/lib/league"
import type { Person } from "@/lib/types"
import { cn } from "@/lib/utils"

type Kind = "Driver" | "Engineer" | "Mechanic"
type Sort = "avg" | "potential" | "wageAsc" | "age"

const SORTS: Record<Sort, { label: string; fn: (a: Person, b: Person, date: string) => number }> = {
  avg: { label: "Best average", fn: (a, b) => statAverage(b.stats) - statAverage(a.stats) },
  potential: { label: "Highest potential", fn: (a, b) => (b.potential ?? 0) - (a.potential ?? 0) },
  wageAsc: { label: "Cheapest", fn: (a, b) => a.contract.yearlyWages - b.contract.yearlyWages },
  age: { label: "Youngest", fn: (a, b, d) => ageAt(a.dateOfBirth, d) - ageAt(b.dateOfBirth, d) },
}

export function MarketPage() {
  const { league } = useLeague()
  const date = league.snapshot.gameDate
  const [kind, setKind] = useState<Kind>("Driver")
  const [sort, setSort] = useState<Sort>("avg")
  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState<string | null>(null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return league.freeAgents
      .filter((p) => p.kind === kind && (!q || p.name.toLowerCase().includes(q) || fmtCountry(p.nationality).toLowerCase().includes(q)))
      .sort((a, b) => SORTS[sort].fn(a, b, date))
  }, [league.freeAgents, kind, sort, query, date])
  const current = list.find((p) => p.guid === selected) ?? list[0]
  const sorts = (Object.keys(SORTS) as Sort[]).filter((s) => s !== "potential" || kind === "Driver")

  return (
    <>
      <PageHeader title="Staff market" description="Free agents. Bidding opens in a later version of the site." />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={kind} onValueChange={(v) => { setKind(v as Kind); setSelected(null); if (v !== "Driver" && sort === "potential") setSort("avg") }}>
          <TabsList>
            {(["Driver", "Engineer", "Mechanic"] as const).map((k) => (
              <TabsTrigger key={k} value={k}>
                {k}s <span className="ml-1 text-muted-foreground">{league.freeAgents.filter((p) => p.kind === k).length}</span>
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
                  <TableHead className="hidden sm:table-cell">Nationality</TableHead>
                  <TableHead className="text-right">Avg</TableHead>
                  {kind === "Driver" && <TableHead className="text-right">Potential</TableHead>}
                  <TableHead className="text-right">Asking wage</TableHead>
                  <TableHead className="hidden text-right md:table-cell">Contract to</TableHead>
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
                    <TableCell className="hidden sm:table-cell">{fmtCountry(p.nationality)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(statAverage(p.stats))}</TableCell>
                    {kind === "Driver" && <TableCell className="text-right tabular-nums">{fmtNum(p.potential, 0)}</TableCell>}
                    <TableCell className="text-right tabular-nums">{fmtMoneyShort(p.contract.yearlyWages)}</TableCell>
                    <TableCell className="hidden text-right md:table-cell">{fmtDate(p.contract.end)}</TableCell>
                  </TableRow>
                ))}
                {!list.length && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">Nobody matches.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <div className="lg:sticky lg:top-16">{current && <PersonCard person={current} gameDate={date} />}</div>
      </div>
    </>
  )
}
