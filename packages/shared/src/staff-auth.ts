/** The same allowlist is used before OAuth and after local MFA. */
export function safeStaffReturn(value: string | null): string {
  if (!value || /[\\\x00-\x20]/.test(value)) return "/staff";
  try {
    const url = new URL(value, "https://staff.invalid");
    if (url.origin !== "https://staff.invalid" || !value.startsWith("/"))
      return "/staff";
    const path = url.pathname;
    const valid =
      [
        "/staff",
        "/staff/cases",
        "/staff/account",
        "/staff/analytics",
        "/staff/admin/users",
        "/staff/admin/teams",
        "/staff/admin/settings",
        "/staff/admin/operations",
        "/staff/admin/development-tracker",
        "/staff/admin/audit",
        "/staff/admin/settings/history",
        "/staff/admin/staff",
        "/staff/admin/users/new",
      ].includes(path) ||
      /^\/staff\/admin\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/edit$/.test(
        path,
      ) ||
      /^\/staff\/cases\/[0-9a-f-]{36}(?:\/(?:messages|evidence|investigation|actions|closure|history))?$/.test(
        path,
      );
    return valid ? path + url.search : "/staff";
  } catch {
    return "/staff";
  }
}
