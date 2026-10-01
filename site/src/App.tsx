import { HashRouter, Navigate, Route, Routes } from "react-router"
import { AppSidebar } from "@/components/app-sidebar"
import { Gate } from "@/components/gate"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LeagueProvider, useLeague } from "@/lib/league"
import { demoMode } from "@/lib/supabase"
import { fmtDate } from "@/lib/format"
import { MarketPage } from "@/pages/market"
import { MyTeamPage } from "@/pages/my-team"
import { OrganizerPage } from "@/pages/organizer"
import { RegulationsPage } from "@/pages/regulations"
import { EnginePage } from "@/pages/engine"
import { ResultsPage } from "@/pages/results"
import { StandingsPage } from "@/pages/standings"
import { TeamsPage } from "@/pages/teams"
import { TransfersPage } from "@/pages/transfers"
import { TransfersProvider } from "@/lib/transfers"
import { HqOrdersProvider } from "@/lib/hq"
import { PartsProvider } from "@/lib/parts"

function Shell() {
  const { me, league } = useLeague()
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur">
          <SidebarTrigger className="-ml-1" />
          <span className="text-sm text-muted-foreground">
            Game date {fmtDate(league.snapshot.gameDate)}
            <span className="hidden sm:inline"> · published {new Date(league.publishedAt).toLocaleString()}</span>
          </span>
          {demoMode && <span className="ml-auto rounded bg-primary/15 px-2 py-0.5 text-xs text-primary">Demo data</span>}
        </header>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 md:p-6">
          <Routes>
            <Route path="/" element={<MyTeamPage />} />
            <Route path="/team/:name" element={<MyTeamPage />} />
            <Route path="/standings" element={<StandingsPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/teams" element={<TeamsPage />} />
            <Route path="/market" element={<MarketPage />} />
            <Route path="/transfers" element={<TransfersPage />} />
            <Route path="/regulations" element={<RegulationsPage />} />
            <Route path="/engine" element={<EnginePage />} />
            {me.role === "organizer" && <Route path="/organizer" element={<OrganizerPage />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default function App() {
  return (
    <LeagueProvider>
      <TooltipProvider>
        <HashRouter>
          <Gate>
            <TransfersProvider>
              <HqOrdersProvider>
                <PartsProvider>
                  <Shell />
                </PartsProvider>
              </HqOrdersProvider>
            </TransfersProvider>
          </Gate>
        </HashRouter>
      </TooltipProvider>
    </LeagueProvider>
  )
}
