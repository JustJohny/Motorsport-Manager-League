import { Flag, Loader2 } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useLeagueContext } from "@/lib/league"

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-svh items-center justify-center p-4">{children}</div>
}

function Message({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Centered>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Flag className="size-5" />
          </div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{children}</CardDescription>
        </CardHeader>
        {action && <CardContent>{action}</CardContent>}
      </Card>
    </Centered>
  )
}

/** Renders children only when the league is loaded; otherwise login, loading and error screens. */
export function Gate({ children }: { children: ReactNode }) {
  const { status, signIn, signOut, switchSeries } = useLeagueContext()
  const signOutButton = <Button variant="outline" className="w-full" onClick={() => void signOut()}>Sign out</Button>

  switch (status.kind) {
    case "loading":
      return <Centered><Loader2 className="size-6 animate-spin text-muted-foreground" /></Centered>
    case "signedOut":
      return (
        <Message title="MM League" action={<Button className="w-full" onClick={() => void signIn()}>Sign in with Discord</Button>}>
          Manage your Motorsport Manager league team between races.
        </Message>
      )
    case "notMember":
      return (
        <Message title="Not in the league yet" action={signOutButton}>
          You're signed in as <b>@{status.username}</b>, but that Discord username isn't linked to a team. Send it to
          the organizer.
        </Message>
      )
    case "noSnapshot":
      return (
        <Message
          title="Nothing published yet"
          action={
            <div className="flex flex-col gap-2">
              {status.series.filter((s) => s.id !== status.current.id).map((s) => (
                <Button key={s.id} variant="secondary" className="w-full" onClick={() => switchSeries(s.id)}>Go to {s.name}</Button>
              ))}
              {signOutButton}
            </div>
          }
        >
          You drive for {status.me.team} in {status.current.name}. The organizer hasn't published this series' data yet.
        </Message>
      )
    case "error":
      return <Message title="Something went wrong" action={signOutButton}>{status.message}</Message>
    case "ready":
      return children
  }
}
