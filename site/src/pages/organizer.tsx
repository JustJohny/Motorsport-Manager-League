import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/page-header"
import { Archive, Flag, Plus } from "lucide-react"
import { CopyCommand, RaceCycle } from "@/components/race-cycle"
import { seriesFiles } from "../../../src/race-cycle.ts"
import { WindowControls } from "@/components/window-controls"
import { EqualizeCard } from "@/components/equalize-card"
import { LogoReviewCard } from "@/components/logo-review-card"
import { fmtDate } from "@/lib/format"
import { useLeague } from "@/lib/league"

export function OrganizerPage() {
  const { league, current } = useLeague()
  const files = seriesFiles(current)
  const seen = new Map(league.logins.map((l) => [l.discord_username, l]))
  const unmatched = league.logins.filter((l) => !league.members.some((m) => m.discord_username === l.discord_username))
  const ch = league.snapshot.championship

  return (
    <>
      <PageHeader title="Organizer" description="The race cycle step by step, the transfer window, league members and the data currently on the site." />
      <RaceCycle />
      <div className="grid gap-4 lg:grid-cols-3">
        <WindowControls />
        <Card size="sm">
          <CardHeader>
            <CardTitle>Published snapshot #{league.snapshotId}</CardTitle>
            <CardDescription>What members see now. Publish again at each checkpoint (see the race cycle above).</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-y-1 text-sm">
            <span className="text-muted-foreground">Published</span><span>{new Date(league.publishedAt).toLocaleString()}</span>
            <span className="text-muted-foreground">Game date</span><span>{fmtDate(league.snapshot.gameDate)}</span>
            <span className="text-muted-foreground">Last race</span><span>{ch.lastRace ? `Round ${ch.lastRace.round}, ${ch.lastRace.circuit}` : "—"}</span>
            <span className="text-muted-foreground">Free agents</span><span>{league.freeAgents.length}</span>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>Logins without a team</CardTitle>
            <CardDescription>Add these Discord usernames to <code>{files.league}</code> as <code>"discord"</code>, then publish again.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {unmatched.length
              ? unmatched.map((l) => <Badge key={l.discord_username} variant="outline">@{l.discord_username}{l.display_name && ` (${l.display_name})`}</Badge>)
              : <span className="text-sm text-muted-foreground">None.</span>}
          </CardContent>
        </Card>
      </div>
      <EqualizeCard />
      <LogoReviewCard />
      <SeriesCard />
      <Card size="sm">
        <CardHeader><CardTitle>Members</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Discord</TableHead>
                <TableHead>Team</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Last seen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {league.members.map((m) => {
                const l = seen.get(m.discord_username)
                return (
                  <TableRow key={m.discord_username}>
                    <TableCell className="font-medium">{m.member}</TableCell>
                    <TableCell>@{m.discord_username}</TableCell>
                    <TableCell>{m.team}</TableCell>
                    <TableCell>{m.role === "organizer" ? <Badge>Organizer</Badge> : "Member"}</TableCell>
                    <TableCell>{l ? new Date(l.last_seen).toLocaleString() : <span className="text-muted-foreground">Never</span>}</TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}

/** Series = one MM save each. Starting one, and ending this one (backup first). */
function SeriesCard() {
  const { current, series } = useLeague()
  const files = seriesFiles(current)
  const example = JSON.stringify({
    series: { id: "endurance", name: "Endurance league" },
    championship: "<championship name in that save>",
    members: [{ member: "you", team: "<team>", discord: "<discord username>", organizer: true }],
  }, null, 2)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Flag className="size-4" /> Series</CardTitle>
        <CardDescription>
          Each series is one MM save with its own teams, members and everything they do on the site. Members switch series at the
          top of the sidebar. You're in {series.length} series; this one is <b>{current.name}</b> (id <code>{current.id}</code>).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 text-sm lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2 font-medium"><Plus className="size-4" /> Start another series</span>
          <span className="text-muted-foreground">
            Make a league file for it in the toolkit folder with a new series id (lower case, digits, dashes), e.g.
            <code> league-endurance.json</code>, and publish its save. It appears in the sidebar for its members.
            The same Discord account can be in several series, with a different team in each.
          </span>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">{example}</pre>
          <CopyCommand command={`npx tsx src/cli.ts publish "Save<save name>" --league league-endurance.json`} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-2 font-medium"><Archive className="size-4" /> End this series</span>
          <span className="text-muted-foreground">
            For a test league, or when a league is over. First a backup: every row of this series goes into one JSON file.
          </span>
          <CopyCommand command={`npx tsx src/cli.ts archive --league ${files.league}`} />
          <span className="text-muted-foreground">
            Then delete it from the site. This removes everything of <b>{current.name}</b> (snapshots, orders, bids, votes, engines,
            supplier choices, members) and nothing of other series. The backup is written and checked first.
          </span>
          <CopyCommand command={`npx tsx src/cli.ts archive --league ${files.league} --end`} />
          <span className="text-muted-foreground">To bring it back later (only while no series has that id):</span>
          <CopyCommand command={`npx tsx src/cli.ts restore backup-${current.id}-<date>.json`} />
          <span className="text-muted-foreground">
            To start fresh in the same series id, end it, then publish the new save with the same league file.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
