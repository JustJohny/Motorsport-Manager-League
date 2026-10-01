import {
  ArrowRight, Check, ChevronDown, Copy, Download, Flag, Gamepad2, Gavel, Hammer, LifeBuoy, PencilRuler, ShieldAlert,
  Upload, Users, Wrench, type LucideIcon,
} from "lucide-react"
import { useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fmtDate } from "@/lib/format"
import { useHqOrders } from "@/lib/hq"
import { useLeague } from "@/lib/league"
import { useParts } from "@/lib/parts"
import { useTransfers } from "@/lib/transfers"
import { cn } from "@/lib/utils"

type Checkpoint = "after" | "before"

const CRASH_LOG = "~/Downloads/Motorsport.Manager.v1.53.ALL.DLCs/Motorsport Manager v1.53/MM_Data/output_log.txt"
const day = 86_400_000
const time = (d: string) => Date.parse(d.slice(0, 19) + "Z")

/**
 * Where the league is in the race cycle, from the published game date: a save made at the start
 * of the next race weekend is checkpoint B (before the race), anything earlier is A (after the
 * last race).
 */
function useCycle() {
  const { league } = useLeague()
  const ch = league.snapshot.championship
  const next = ch.calendar.find((e) => !e.ended) ?? null
  const last = [...ch.calendar].reverse().find((e) => e.ended) ?? null
  const gameDate = league.snapshot.gameDate
  const current: Checkpoint = next && time(gameDate) >= time(next.date) - day ? "before" : "after"
  return { last, next, current }
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(command)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/50 py-1.5 pr-1.5 pl-3">
      <code className="flex-1 overflow-x-auto py-1 font-mono text-xs whitespace-pre">{command}</code>
      <Button size="sm" variant="ghost" className="size-7 shrink-0 p-0" onClick={() => void copy()} title="Copy" aria-label="Copy command">
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  )
}

function Step({ n, icon: Icon, title, done, children }: { n: number; icon: LucideIcon; title: ReactNode; done?: boolean; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums",
          done ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-500" : "bg-muted")}>
          {done ? <Check className="size-3.5" /> : n}
        </span>
        <span className="w-px flex-1 bg-border" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pb-5">
        <div className="flex items-center gap-2 pt-1 text-sm font-medium">
          <Icon className="size-4 text-muted-foreground" /> {title}
          {done && <Badge variant="secondary" className="text-[10px]">Done</Badge>}
        </div>
        {children && <div className="flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>}
      </div>
    </li>
  )
}

const Save = ({ children }: { children: ReactNode }) => <strong className="font-medium text-foreground">{children}</strong>

export function RaceCycle() {
  const { league } = useLeague()
  const { last, next, current } = useCycle()
  const [tab, setTab] = useState<Checkpoint>(current)
  const hq = useHqOrders().orders
  const designs = useParts().orders.filter((o) => o.status === "queued")
  const t = useTransfers()
  const w = t.transferWindow

  const lastRound = last?.round ?? 0
  const nextRound = next?.round ?? lastRound + 1
  const post = `League R${lastRound} Post`
  const pre = `League R${nextRound} Pre`
  const cmd = {
    publish: (save: string) => `npx tsx src/cli.ts publish "Save${save}" --league league.json`,
    pull: "npx tsx src/cli.ts pull -o changes.json --mark-applied",
    apply: (save: string) => `npx tsx src/cli.ts apply "Save${save}" changes.json --name "${save} (league)"`,
  }
  const published = `Published ${new Date(league.publishedAt).toLocaleString()} with game date ${fmtDate(league.snapshot.gameDate)}.`
  const windowNote = !w ? "No transfer window." : w.status === "applied" ? `Transfer window #${w.id} is applied.`
    : t.isOpen ? `Transfer window #${w.id} is open until ${new Date(w.closes_at).toLocaleString()}; its signings are pulled only after that.`
    : `Transfer window #${w.id} has closed; its signings are in the next pull.`

  const Pending = () => (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline" className="gap-1"><PencilRuler className="size-3" /> {designs.length} part design{designs.length === 1 ? "" : "s"}</Badge>
      <Badge variant="outline" className="gap-1"><Hammer className="size-3" /> {hq.length} HQ order{hq.length === 1 ? "" : "s"}</Badge>
      <Badge variant="outline" className="gap-1"><Gavel className="size-3" /> {w && w.status !== "applied" ? `window #${w.id} ${t.isOpen ? "open" : "closed"}` : "no window"}</Badge>
      <Badge variant="outline" className="gap-1"><Wrench className="size-3" /> fitting and improvement: always</Badge>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Flag className="size-4" /> Race cycle</CardTitle>
        <CardDescription>
          Two checkpoints per race, as in vanilla MM: after the race, members design, build and bid; just before the
          next race, they fit the new parts. Members can do everything at both. Run the commands in the toolkit folder.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Where we are */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {([
            ["after", `A · After race ${lastRound}${last ? ` (${last.circuit})` : ""}`],
            ["before", `B · Before race ${nextRound}${next ? ` (${next.circuit}, ${fmtDate(next.date)})` : ""}`],
          ] as const).map(([key, label], i) => (
            <span key={key} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="size-4 text-muted-foreground" />}
              <button
                type="button" onClick={() => setTab(key)}
                className={cn("rounded-full border px-3 py-1 transition-colors hover:bg-muted",
                  current === key && "border-primary bg-primary/10 text-foreground", tab === key && "ring-2 ring-primary/30")}
              >
                {label}{current === key && <span className="ml-2 text-xs text-primary">you are here</span>}
              </button>
            </span>
          ))}
          <ArrowRight className="size-4 text-muted-foreground" />
          <span className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-muted-foreground"><Flag className="size-3.5" /> Race {nextRound}</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Waiting for the next pull</span>
          <Pending />
          <span className="text-xs text-muted-foreground">{windowNote}</span>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as Checkpoint)}>
          <TabsList variant="line">
            <TabsTrigger value="after">A · After race {lastRound}</TabsTrigger>
            <TabsTrigger value="before">B · Before race {nextRound}</TabsTrigger>
          </TabsList>

          <TabsContent value="after" className="pt-3">
            <ol>
              <Step n={1} icon={Gamepad2} title={<>Save in MM as <Save>{post}</Save></>} done={current === "after"}>
                After the race, back at HQ, not during a session.
              </Step>
              <Step n={2} icon={Upload} title="Publish it" done={current === "after"}>
                <CopyCommand command={cmd.publish(post)} />
                {current === "after" && <span className="text-xs">{published}</span>}
              </Step>
              <Step n={3} icon={Gavel} title="Transfer window (optional)">
                Open one with the controls on this page. Give it a deadline before step 5: bids are only pulled once it has passed.
              </Step>
              <Step n={4} icon={Users} title="Tell the members they can act">
                Part designs, HQ orders, bids, fitting and improvement.
              </Step>
              <Step n={5} icon={Download} title="Pull their decisions">
                <CopyCommand command={cmd.pull} />
                It prints the designs, HQ orders, fitting and signings. The first changes undo what MM's AI did on member teams; that's expected.
              </Step>
              <Step n={6} icon={Wrench} title="Apply them to the save you published">
                <CopyCommand command={cmd.apply(post)} />
              </Step>
              <Step n={7} icon={Gamepad2} title={<>In MM, load <Save>{post} (league)</Save>, advance and save as <Save>{pre}</Save></>}>
                Advance until race weekend {nextRound} starts{next ? ` (${fmtDate(next.date)})` : ""}, and stop before practice. Ordered parts finish along the way.
              </Step>
            </ol>
          </TabsContent>

          <TabsContent value="before" className="pt-3">
            <ol>
              <Step n={1} icon={Upload} title={<>Publish <Save>{pre}</Save></>} done={current === "before"}>
                <CopyCommand command={cmd.publish(pre)} />
                {current === "before" && <span className="text-xs">{published}</span>}
              </Step>
              <Step n={2} icon={Users} title="Tell the members their new parts are in">
                They fit them (car 1 / car 2) and pick improvements. New designs, HQ orders and bids placed now start at this apply.
              </Step>
              <Step n={3} icon={Download} title="Pull their decisions">
                <CopyCommand command={cmd.pull} />
              </Step>
              <Step n={4} icon={Wrench} title="Apply them">
                <CopyCommand command={cmd.apply(pre)} />
              </Step>
              <Step n={5} icon={Flag} title={<>In MM, load <Save>{pre} (league)</Save> and race</>}>
                <p>Practice, qualifying and race {nextRound}. Then save as <Save>League R{nextRound} Post</Save> and start again at A.</p>
              </Step>
            </ol>
          </TabsContent>
        </Tabs>

        <Details icon={ShieldAlert} title="Rules that keep it working">
          <li><b>Always apply to the save you just published.</b> Design options, parts and prices come from it; with a different save, apply stops with an error rather than guess.</li>
          <li><b>Don't play member teams yourself in MM</b> between apply and publish (no designing, fitting or HQ for them, your own career team included). Pull treats anything it didn't order as the AI's doing and undoes it with a refund.</li>
          <li><b>Never apply to a "(league)" save twice.</b> A new apply always starts from a save you made in MM.</li>
          <li><b>If apply fails after a pull</b>, don't pull again: <code>--mark-applied</code> has already marked the orders done. Fix it and apply the same <code>changes.json</code>.</li>
          <li>Your own saves are never overwritten; apply always writes a new "(league)" file.</li>
        </Details>
        <Details icon={LifeBuoy} title="If something goes wrong">
          <li><b>The game crashes or a save won't load:</b> the cause is at the end of <code className="break-all">{CRASH_LOG}</code>.</li>
          <li><b>Apply stops with an error:</b> nothing was written. The message names the change, e.g. <code>Change #4 (startDesign): …</code>.</li>
          <li><b>Members say their page is out of date:</b> publish the latest save. The header shows the game date and publish time.</li>
        </Details>
      </CardContent>
    </Card>
  )
}

function Details({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <details className="group rounded-lg border px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" /> {title}
        <ChevronDown className="ml-auto size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
        {children}
      </ul>
    </details>
  )
}
