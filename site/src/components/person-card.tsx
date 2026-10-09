import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ageAt, fmtCountry, fmtDate, fmtMoneyShort, fmtNum, humanize, statAverage } from "@/lib/format"
import type { Person } from "@/lib/types"
import { StatBar } from "./stat-bar"
import { statMax } from "../../../src/game-rules.ts"
import { useLeague } from "@/lib/league"
import { AgeWindowBadge, DriverDevelopment, GrowthBadge } from "./growth"

export function PersonCard({ person, role, gameDate }: { person: Person; role?: string; gameDate: string }) {
  const max = statMax(person.kind, useLeague().league.snapshot.championship.game)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span className="truncate">{person.name}</span>
          <Badge variant="secondary" className="tabular-nums">{fmtNum(statAverage(person.stats))} avg</Badge>
        </CardTitle>
        <CardDescription>
          {humanize(role ?? person.kind)} · {ageAt(person.dateOfBirth, gameDate)} y · {fmtCountry(person.nationality)}
        </CardDescription>
        {person.kind === "Driver" && (
          <div className="flex flex-wrap gap-1"><GrowthBadge person={person} /><AgeWindowBadge person={person} /></div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5">
        {Object.entries(person.stats).map(([k, v]) => <StatBar key={k} label={k} value={v} max={max} />)}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{fmtMoneyShort(person.contract.yearlyWages)}/yr</span>
          <span>until {fmtDate(person.contract.end)}</span>
          {person.kind === "Driver" && !person.growth && !!person.potential && <span>potential {fmtNum(person.potential, 0)}</span>}
        </div>
        {person.kind === "Driver" && <DriverDevelopment person={person} />}
      </CardContent>
    </Card>
  )
}
