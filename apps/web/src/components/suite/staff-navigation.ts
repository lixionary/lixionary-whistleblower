import {
  BarChart3,
  ClipboardList,
  Users,
  Settings,
  Network,
  ScrollText,
  Activity,
  UserRound,
  Kanban,
  LayoutDashboard,
} from "lucide-react";
import type { StaffRole } from "@whistle/shared";
export const staffNavigation = [
  {
    href: "/staff/cases",
    key: "cases",
    icon: ClipboardList,
    roles: ["manager", "analyst"],
  },
  {
    href: "/staff/admin/dashboard",
    key: "dashboard",
    icon: LayoutDashboard,
    roles: ["admin"],
  },
  {
    href: "/staff/admin/users",
    key: "users",
    icon: Users,
    roles: ["admin"],
  },
  { href: "/staff/admin/teams", key: "teams", icon: Network, roles: ["admin"] },
  {
    href: "/staff/admin/settings",
    key: "settings",
    icon: Settings,
    roles: ["admin"],
  },
  {
    href: "/staff/admin/operations",
    key: "operations",
    icon: Activity,
    roles: ["admin"],
  },
  {
    href: "/staff/admin/development-tracker",
    key: "developmentTracker",
    icon: Kanban,
    roles: ["admin"],
  },
  {
    href: "/staff/admin/audit",
    key: "audit",
    icon: ScrollText,
    roles: ["admin"],
  },
  {
    href: "/staff/analytics",
    key: "statistics",
    icon: BarChart3,
    roles: ["admin", "manager", "analyst"],
  },
  {
    href: "/staff/account",
    key: "account",
    icon: UserRound,
    roles: ["admin", "manager", "analyst"],
  },
] satisfies {
  href: string;
  key: string;
  icon: typeof Users;
  roles: StaffRole[];
}[];
export const staffNavigationGroups = [
  {
    key: "workspace",
    items: staffNavigation.filter((n) => !n.href.startsWith("/staff/admin/")),
  },
  {
    key: "administration",
    items: staffNavigation.filter((n) => n.href.startsWith("/staff/admin/")),
  },
];
export const caseSections = [
  { segment: "", key: "overview" },
  { segment: "messages", key: "messages" },
  { segment: "evidence", key: "evidence" },
  { segment: "investigation", key: "investigation" },
  { segment: "actions", key: "tasks" },
  { segment: "closure", key: "closureMenu" },
  { segment: "history", key: "audit" },
] as const;
export type CaseSection = (typeof caseSections)[number]["segment"];
export function staffHome(role: StaffRole) {
  return role === "admin" ? "/staff/admin/settings" : "/staff/cases";
}
export { safeStaffReturn } from "@whistle/shared";
