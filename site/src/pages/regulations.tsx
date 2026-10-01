import { Bot, CalendarClock, Check, Loader2, Minus, Scale, ScrollText, ThumbsDown, ThumbsUp, Vote, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { castVotes, tallyVote, votesClosingNow, type OverrideRow, type RuleVoteRow, type VoteResultRow } from "../../../src/politics.ts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/page-header"
import { fmtDate, humanize } from "@/lib/format"
import { useLeague } from "@/lib/league"
import { demoMode, supabase, watchTable } from "@/lib/supabase"
import type { Regulations, Rule, RuleVote, VoteChoice } from "@/lib/types"
import { cn } from "@/lib/utils"

async function check<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p
  if (error) throw new Error(error.message)
  return data
}

/** Member votes, league results and the organizer's next-season choices (live, or in memory in demo mode). */
function usePolitics() {
  const [rows, setRows] = useState<RuleVoteRow[]>([])
  const [results, setResults] = useState<VoteResultRow[]>([])
  const [overrides, setOverrides] = useState<OverrideRow[]>([])
  const reload = useCallback(async () => {
    if (demoMode) return
    const [r, res, o] = await Promise.all([
      check(supabase!.from("rule_votes").select("*")),
      check(supabase!.from("rule_vote_results").select("*")),
      check(supabase!.from("next_rule_overrides").select("*")),
    ])
    setRows((r ?? []) as RuleVoteRow[]); setResults((res ?? []) as VoteResultRow[]); setOverrides((o ?? []) as OverrideRow[])
  }, [])
  useEffect(() => {
    if (demoMode) return
    void reload()
    const ch = supabase!.channel("politics")
    for (const table of ["rule_votes", "rule_vote_results", "next_rule_overrides"]) watchTable(ch, table, () => void reload())
    ch.subscribe()
    return () => void supabase!.removeChannel(ch)
  }, [reload])
  return { rows, setRows, results, overrides, setOverrides, reload }
}

const ruleLabel = (r: Rule | undefined) => r?.name ?? (r ? `${humanize(r.group)}: ${r.effect}` : "—")

export function RegulationsPage() {
  const { me, league } = useLeague()
  const ch = league.snapshot.championship
  const regs = ch.regulations
  const p = usePolitics()
  if (!regs) {
    return (
      <>
        <PageHeader title="Regulations" description={ch.name} />
        <Alert><AlertDescription>The latest publish has no regulations yet; they appear after the organizer publishes again.</AlertDescription></Alert>
      </>
    )
  }
  const nextRace = ch.calendar.find((e) => !e.ended)?.date ?? null
  const closingNow = new Set(votesClosingNow(regs.votes, league.snapshot.gameDate, nextRace).map((v) => v.ruleId))
  const myTeam = regs.teams.find((t) => t.team === me.team)

  return (
    <>
      <PageHeader
        title="Regulations"
        description={<>{ch.name} · {regs.season} season. Rule votes are held here; the league's result replaces MM's own vote.</>}
      />
      <VotesCard regs={regs} rows={p.rows} results={p.results} closingNow={closingNow} myTeam={myTeam} onVoted={p.reload}
        setDemoRows={p.setRows} />
      <RulesCard regs={regs} overrides={p.overrides} results={p.results} organizer={me.role === "organizer"}
        onChanged={p.reload} setDemoOverrides={p.setOverrides} />
    </>
  )
}

function VotesCard({ regs, rows, results, closingNow, myTeam, onVoted, setDemoRows }: {
  regs: Regulations; rows: RuleVoteRow[]; results: VoteResultRow[]; closingNow: Set<number>
  myTeam: Regulations["teams"][number] | undefined; onVoted: () => Promise<void>
  setDemoRows: React.Dispatch<React.SetStateAction<RuleVoteRow[]>>
}) {
  const upcoming = regs.votes.filter((v) => v.status === "upcoming" && !results.some((r) => r.season === regs.season && r.rule_id === v.ruleId))
  const held = regs.votes.filter((v) => !upcoming.includes(v))
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Vote className="size-4" /> Rule votes</CardTitle>
        <CardDescription>
          As in MM: every team votes yes, no or abstain. Extra vote power counts more; abstaining banks 1 power for later.
          AI teams vote by how the rule affects them (predicted with MM's logic). Accepted rules apply next season.
          {myTeam && <> Your vote power: <strong className="font-medium text-foreground">{myTeam.votingPower}</strong>.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {upcoming.map((v) => (
          <UpcomingVote key={v.ruleId} regs={regs} vote={v} rows={rows} closing={closingNow.has(v.ruleId)} myTeam={myTeam}
            onVoted={onVoted} setDemoRows={setDemoRows} />
        ))}
        {!upcoming.length && <p className="text-sm text-muted-foreground">No votes left this season.</p>}
        {held.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow><TableHead>Held</TableHead><TableHead>Rule</TableHead><TableHead className="text-right">Yes · No · Abstained</TableHead><TableHead>Result</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {held.map((v) => {
                const league = results.find((r) => r.season === regs.season && r.rule_id === v.ruleId)
                const r = league ? { yes: league.yes, no: league.no, abstained: league.abstained, accepted: league.accepted } : v.result
                return (
                  <TableRow key={v.ruleId}>
                    <TableCell className="whitespace-nowrap">{fmtDate(v.date)}</TableCell>
                    <TableCell>{ruleLabel(regs.rules[v.ruleId])}{league && <Badge variant="outline" className="ml-2 text-[10px]">League vote</Badge>}</TableCell>
                    <TableCell className="text-right tabular-nums">{r ? `${r.yes} · ${r.no} · ${r.abstained}` : "—"}</TableCell>
                    <TableCell>{r ? (r.accepted ? <Badge className="gap-1"><Check className="size-3" /> Accepted</Badge> : <Badge variant="outline" className="gap-1"><X className="size-3" /> Rejected</Badge>) : "—"}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function UpcomingVote({ regs, vote, rows, closing, myTeam, onVoted, setDemoRows }: {
  regs: Regulations; vote: RuleVote; rows: RuleVoteRow[]; closing: boolean; myTeam: Regulations["teams"][number] | undefined
  onVoted: () => Promise<void>; setDemoRows: React.Dispatch<React.SetStateAction<RuleVoteRow[]>>
}) {
  const rule = regs.rules[vote.ruleId]
  const current = Object.values(regs.rules).find((r) => r.group === rule?.group && regs.current.includes(r.id))
  const mine = rows.find((r) => r.team === myTeam?.team && r.rule_id === vote.ruleId && r.season === regs.season)
  const [extra, setExtra] = useState(mine?.extra_power ?? 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cast = castVotes(regs, vote.ruleId, rows)
  const tally = tallyVote(cast, [regs.season, vote.ruleId])
  const submit = async (choice: VoteChoice) => {
    if (!myTeam) return
    const extraPower = choice === "abstain" ? 0 : extra
    setBusy(true); setError(null)
    try {
      if (demoMode) {
        setDemoRows((rs) => [...rs.filter((r) => !(r.team === myTeam.team && r.rule_id === vote.ruleId)),
          { team: myTeam.team, season: regs.season, rule_id: vote.ruleId, choice, extra_power: extraPower }])
      } else {
        await check(supabase!.rpc("cast_rule_vote", { rule_id: vote.ruleId, choice, extra_power: extraPower }))
        await onVoted()
      }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const icon = (c: VoteChoice) => (c === "yes" ? ThumbsUp : c === "no" ? ThumbsDown : Minus)

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">{ruleLabel(rule)}</span>
          {rule?.description && <span className="text-sm text-muted-foreground">{rule.description}</span>}
          <span className="text-xs text-muted-foreground">Replaces: {ruleLabel(current)}</span>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><CalendarClock className="size-3.5" /> MM vote {fmtDate(vote.date)}</span>
          <Badge variant={closing ? "default" : "outline"}>{closing ? "Closes at this checkpoint's pull" : "Closes at a later checkpoint"}</Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-md bg-muted/50 px-3 py-2 text-sm tabular-nums">
        <span className="flex items-center gap-1.5"><ThumbsUp className="size-4 text-emerald-500" /> {tally.yes}</span>
        <span className="flex items-center gap-1.5"><ThumbsDown className="size-4 text-destructive" /> {tally.no}</span>
        <span className="text-muted-foreground">{tally.abstained} abstaining</span>
        <span className="font-medium">{tally.tie ? "Tied: a coin flip decides" : tally.accepted ? "Heading for: accepted" : "Heading for: rejected"}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {cast.map((c) => {
          const I = icon(c.vote)
          const ai = !regs.teams.find((t) => t.team === c.team)?.member
          return (
            <span key={c.team} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs",
              c.vote === "yes" && "border-emerald-500/40", c.vote === "no" && "border-destructive/40", c.team === myTeam?.team && "bg-primary/10")}
              title={ai ? "AI team: predicted with MM's logic" : "Member"}>
              {ai && <Bot className="size-3 text-muted-foreground" />}{c.team}<I className="size-3" />{c.power > 1 && <span>×{c.power}</span>}
            </span>
          )
        })}
      </div>

      {myTeam && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Your vote{mine ? `: ${mine.choice}${mine.extra_power ? ` (+${mine.extra_power} power)` : ""}` : " (none yet = abstain)"}</span>
          <label className="ml-auto flex items-center gap-1.5 text-sm">
            Extra power
            <input type="number" min={0} max={myTeam.votingPower} value={extra} disabled={!myTeam.votingPower}
              onChange={(e) => setExtra(Math.max(0, Math.min(myTeam.votingPower, Number(e.target.value) || 0)))}
              className="h-8 w-14 rounded-md border bg-transparent px-2 tabular-nums" />
          </label>
          {(["yes", "no", "abstain"] as const).map((c) => {
            const I = icon(c)
            return (
              <Button key={c} size="sm" variant={mine?.choice === c ? "default" : "outline"} disabled={busy} onClick={() => void submit(c)}>
                {busy ? <Loader2 className="animate-spin" /> : <I />} {humanize(c)}
              </Button>
            )
          })}
        </div>
      )}
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    </div>
  )
}

function RulesCard({ regs, overrides, results, organizer, onChanged, setDemoOverrides }: {
  regs: Regulations; overrides: OverrideRow[]; results: VoteResultRow[]; organizer: boolean
  onChanged: () => Promise<void>; setDemoOverrides: React.Dispatch<React.SetStateAction<OverrideRow[]>>
}) {
  const [error, setError] = useState<string | null>(null)
  const byGroup = (ids: number[]) => new Map(ids.map((id) => [regs.rules[id]?.group, id]))
  const current = byGroup(regs.current)
  const next = byGroup(regs.next)
  // League vote results not yet in a publish.
  for (const r of results.filter((x) => x.season === regs.season && x.accepted)) next.set(regs.rules[r.rule_id]?.group, r.rule_id)
  const voted = new Map(next)
  const forced = new Map(overrides.filter((o) => o.season === regs.season).map((o) => [o.rule_group, o.rule_id]))
  for (const [g, id] of forced) next.set(g, id)
  const groups = [...new Set([...current.keys(), ...next.keys()])].filter(Boolean) as string[]
  const options = (group: string) => Object.values(regs.rules).filter((r) => r.group === group)
  const choose = async (group: string, value: string) => {
    const ruleId = value === "keep" ? null : Number(value)
    setError(null)
    try {
      if (demoMode) {
        setDemoOverrides((os) => [...os.filter((o) => o.rule_group !== group), ...(ruleId == null ? [] : [{ season: regs.season, rule_group: group, rule_id: ruleId }])])
      } else {
        await check(supabase!.rpc("set_next_rule", { rule_group: group, rule_id: ruleId }))
        await onChanged()
      }
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ScrollText className="size-4" /> Rules</CardTitle>
        <CardDescription>
          This season's rules and next season's confirmed rules. Changes are highlighted.
          {organizer && " As organizer you can set any rule group for next season; your choice overrides votes."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Table>
          <TableHeader>
            <TableRow><TableHead>Area</TableHead><TableHead>{regs.season}</TableHead><TableHead>{regs.season + 1}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => {
              const now = current.get(g), then = next.get(g)
              const changed = now !== then
              return (
                <TableRow key={g} className={cn(changed && "bg-primary/5")}>
                  <TableCell className="text-muted-foreground">{humanize(g)}</TableCell>
                  <TableCell>{ruleLabel(regs.rules[now!])}</TableCell>
                  <TableCell>
                    {organizer ? (
                      <Select value={forced.has(g) ? String(forced.get(g)) : "keep"} onValueChange={(v) => void choose(g, v)}>
                        <SelectTrigger className={cn("h-8 w-full max-w-80", changed && "border-primary/60")}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="keep">As voted: {ruleLabel(regs.rules[voted.get(g)!])}</SelectItem>
                          {options(g).map((r) => <SelectItem key={r.id} value={String(r.id)}>{ruleLabel(r)}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className={cn(changed && "font-medium")}>{ruleLabel(regs.rules[then!])}</span>
                    )}
                    {forced.has(g) && <Badge variant="outline" className="ml-2 gap-1 text-[10px]"><Scale className="size-3" /> Organizer</Badge>}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
