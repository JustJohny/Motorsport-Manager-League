import { CalendarDays, Check, ChevronsUpDown, Flag, Fan, Gavel, Scale, Moon, Shield, ShoppingBag, Sun, Trophy, Users, Wrench } from "lucide-react"
import { NavLink, useLocation } from "react-router"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, useSidebar,
} from "@/components/ui/sidebar"
import { useLeague, useLeagueContext } from "@/lib/league"
import { demoMode } from "@/lib/supabase"
import { useTheme } from "@/lib/theme"
import { useTransfers } from "@/lib/transfers"
import { circuitName } from "../../../src/circuit-names.ts"

const NAV = [
  { to: "/", label: "My team", icon: Wrench },
  { to: "/standings", label: "Standings", icon: Trophy },
  { to: "/results", label: "Calendar & results", icon: CalendarDays },
  { to: "/teams", label: "Teams", icon: Users },
  { to: "/market", label: "Staff market", icon: ShoppingBag },
  { to: "/transfers", label: "Transfer window", icon: Gavel },
  { to: "/regulations", label: "Regulations", icon: Scale },
  { to: "/engine", label: "Engine programme", icon: Fan },
]

export function AppSidebar() {
  const { me, league, series, current } = useLeague()
  const { session, signOut, switchSeries } = useLeagueContext()
  const { theme, toggle } = useTheme()
  const { pathname } = useLocation()
  const transfers = useTransfers()
  // On phones the sidebar is a sheet over the page: close it once something is picked.
  const { isMobile, setOpenMobile } = useSidebar()
  const closeMobile = () => isMobile && setOpenMobile(false)
  const ch = league.snapshot.championship
  const meta = session?.user.user_metadata ?? {}
  const displayName = (meta.custom_claims?.global_name as string | undefined) ?? me.discord_username
  const nav = me.role === "organizer" ? [...NAV, { to: "/organizer", label: "Organizer", icon: Shield }] : NAV

  return (
    <Sidebar>
      <SidebarHeader className={isMobile ? "pr-10" : undefined}>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={series.length < 2}>
                <SidebarMenuButton size="lg" className="disabled:opacity-100" title={series.length > 1 ? "Switch series" : undefined}>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <Flag className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1 text-left leading-tight">
                    <div className="truncate text-sm font-semibold">{current.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {current.name !== ch.name && `${ch.name} · `}
                      {ch.lastRace ? `After round ${ch.lastRace.round} · ${circuitName(ch.lastRace.circuit)}` : "Pre-season"}
                    </div>
                  </div>
                  {series.length > 1 && <ChevronsUpDown className="size-4 text-muted-foreground" />}
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width) min-w-56">
                <DropdownMenuLabel>Your series</DropdownMenuLabel>
                {series.map((s) => (
                  <DropdownMenuItem key={s.id} onSelect={() => { closeMobile(); if (s.id !== current.id) switchSeries(s.id) }}>
                    <Flag />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="truncate">{s.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{s.team}{s.role === "organizer" ? " · organizer" : ""}</div>
                    </div>
                    {s.id === current.id && <Check />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>League</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((n) => (
                <SidebarMenuItem key={n.to}>
                  <SidebarMenuButton asChild isActive={pathname === n.to}>
                    <NavLink to={n.to} onClick={closeMobile}>
                      <n.icon />
                      <span>{n.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                  {n.to === "/transfers" && transfers.isOpen && <SidebarMenuBadge className="text-primary">Open</SidebarMenuBadge>}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <Avatar className="size-8 rounded-md">
                    <AvatarImage src={meta.avatar_url as string | undefined} alt="" />
                    <AvatarFallback className="rounded-md">{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 text-left leading-tight">
                    <div className="truncate text-sm font-medium">{displayName}</div>
                    <div className="truncate text-xs text-muted-foreground">{me.team}</div>
                  </div>
                  {me.role === "organizer" && <Badge variant="outline">Org</Badge>}
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-(--radix-dropdown-menu-trigger-width)">
                <DropdownMenuLabel>{demoMode ? "Demo mode" : `@${me.discord_username}`}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={toggle}>
                  {theme === "dark" ? <Sun /> : <Moon />} {theme === "dark" ? "Light mode" : "Dark mode"}
                </DropdownMenuItem>
                {!demoMode && <DropdownMenuItem onSelect={() => void signOut()}>Sign out</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
