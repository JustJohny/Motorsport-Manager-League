import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/page-header"
import { fmtNum, humanize, statAverage } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { cn } from "@/lib/utils"

export function TeamsPage() {
  const { me, league } = useLeague()
  const { championship: ch, teams } = league.snapshot
  const byTeam = new Map(ch.standings.teams.map((s) => [s.teamID, s]))
  const sorted = [...teams].sort((a, b) => (byTeam.get(a.teamID)?.position ?? 99) - (byTeam.get(b.teamID)?.position ?? 99))

  return (
    <>
      <PageHeader title="Teams" description="Every team's line-up. HQ, parts and budget stay private." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((t) => {
          const s = byTeam.get(t.teamID)
          const canOpen = t.name === me.team || me.role === "organizer"
          return (
            <Card key={t.teamID} size="sm" className={cn(t.name === me.team && "ring-primary/50")}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between gap-2">
                  <Link to={t.name === me.team ? "/" : `/team/${encodeURIComponent(t.name)}`} className="truncate hover:underline">
                    {t.name}
                  </Link>
                  {t.member ? <Badge variant={t.name === me.team ? "default" : "secondary"}>{t.member}</Badge> : <Badge variant="outline">AI</Badge>}
                </CardTitle>
                <CardDescription>
                  {s ? `P${s.position} · ${s.points} pts` : "—"}
                  {!canOpen && " · staff only"}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                {t.staff.filter((x) => x.person).map((x) => (
                  <div key={x.slotID} className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="text-muted-foreground">{humanize(x.job)} </span>
                      {x.person!.name}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{fmtNum(statAverage(x.person!.stats))}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </>
  )
}
