import { CalendarDays, Flag, Fan, Gavel, Scale, Moon, Shield, ShoppingBag, Sun, Trophy, Users, Wrench } from "lucide-react"
import { NavLink, useLocation } from "react-router"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useLeague, useLeagueContext } from "@/lib/league"
import { demoMode } from "@/lib/supabase"
import { useTheme } from "@/lib/theme"
import { useTransfers } from "@/lib/transfers"

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
  const { me, league } = useLeague()
  const { session, signOut } = useLeagueContext()
  const { theme, toggle } = useTheme()
  const { pathname } = useLocation()
  const transfers = useTransfers()
  const ch = league.snapshot.championship
  const meta = session?.user.user_metadata ?? {}
  const displayName = (meta.custom_claims?.global_name as string | undefined) ?? me.discord_username
  const nav = me.role === "organizer" ? [...NAV, { to: "/organizer", label: "Organizer", icon: Shield }] : NAV

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 py-1.5">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Flag className="size-4" />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-sm font-semibold">{ch.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {ch.lastRace ? `After round ${ch.lastRace.round} · ${ch.lastRace.circuit}` : "Pre-season"}
            </div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>League</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((n) => (
                <SidebarMenuItem key={n.to}>
                  <SidebarMenuButton asChild isActive={pathname === n.to}>
                    <NavLink to={n.to}>
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
