import { Fan } from "lucide-react"
import { Link } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/page-header"
import { fmtNum, humanize, statAverage } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { useTeamLook } from "@/lib/team-look"
import { cn } from "@/lib/utils"

export function TeamsPage() {
  const { me, league } = useLeague()
  const tl = useTeamLook()
  const { championship: ch, teams } = league.snapshot
  const byTeam = new Map(ch.standings.teams.map((s) => [s.teamID, s]))
  const sorted = [...teams].sort((a, b) => (byTeam.get(a.teamID)?.position ?? 99) - (byTeam.get(b.teamID)?.position ?? 99))

  return (
    <>
      <PageHeader title="Teams" description="Every team's engine and line-up. HQ, parts and budget stay private." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((t) => {
          const s = byTeam.get(t.teamID)
          const canOpen = t.name === me.team || me.role === "organizer"
          const colours = tl.coloursOf(t.name)
          const logo = tl.approvedLogo(t.name)
          return (
            <Card key={t.teamID} size="sm" className={cn("overflow-hidden", t.name === me.team && "ring-primary/50")}>
              {colours && (
                <div className="-mt-3 flex h-1.5" aria-hidden>
                  <span className="flex-[3]" style={{ background: colours.primary }} />
                  <span className="flex-[2]" style={{ background: colours.secondary }} />
                  <span className="flex-1" style={{ background: colours.tertiary }} />
                  <span className="flex-1" style={{ background: colours.trim }} />
                </div>
              )}
              <CardHeader>
                {logo && (
                  <div className="mb-1 flex h-12 items-center rounded bg-neutral-900 px-2">
                    <img src={tl.logoUrl(logo)} alt={`${t.name} logo`} className="max-h-10 max-w-full object-contain" />
                  </div>
                )}
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
                {t.engine && (
                  <div className="flex items-center justify-between gap-2 border-b pb-1">
                    <span className="flex items-center gap-1.5 text-muted-foreground"><Fan className="size-3.5" /> Engine</span>
                    <span className="truncate">{t.engine.name}</span>
                  </div>
                )}
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
