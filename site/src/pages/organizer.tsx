import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PageHeader } from "@/components/page-header"
import { RaceCycle } from "@/components/race-cycle"
import { WindowControls } from "@/components/window-controls"
import { fmtDate } from "@/lib/format"
import { useLeague } from "@/lib/league"

export function OrganizerPage() {
  const { league } = useLeague()
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
            <CardDescription>Add these Discord usernames to league.json as <code>"discord"</code>, then publish again.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {unmatched.length
              ? unmatched.map((l) => <Badge key={l.discord_username} variant="outline">@{l.discord_username}{l.display_name && ` (${l.display_name})`}</Badge>)
              : <span className="text-sm text-muted-foreground">None.</span>}
          </CardContent>
        </Card>
      </div>
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
