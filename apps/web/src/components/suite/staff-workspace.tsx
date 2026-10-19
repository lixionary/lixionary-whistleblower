"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { LogOut, Menu, X, ShieldCheck } from "lucide-react";
import type { StaffIdentity } from "@whistle/shared";
import { api, ApiError } from "@/lib/api";
import { BuildSignature } from "@/components/build-signature";
import { LanguageSelector } from "./language-selector";
import { LogoMark } from "./logo";
import { ErrorBox, StatusBadge, friendly, useLanguage } from "./common";
import {
  safeStaffReturn,
  staffHome,
  staffNavigationGroups,
} from "./staff-navigation";
type Drafts = Record<string, unknown>;
type StaffContextValue = {
  user: StaffIdentity;
  language: ReturnType<typeof useLanguage>;
  drafts: Drafts;
  setDrafts: Dispatch<SetStateAction<Drafts>>;
  clearDrafts: (prefix?: string) => void;
};
const StaffContext = createContext<StaffContextValue | null>(null);
export function useStaff() {
  const value = useContext(StaffContext);
  if (!value) throw new Error("Staff workspace required");
  return value;
}
export function useDraftState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const { drafts, setDrafts } = useStaff();
  const value = Object.hasOwn(drafts, key) ? (drafts[key] as T) : initial;
  const set: Dispatch<SetStateAction<T>> = (next) =>
    setDrafts((current) => {
      const previous = Object.hasOwn(current, key)
        ? (current[key] as T)
        : initial;
      const updated =
        typeof next === "function" ? (next as (v: T) => T)(previous) : next;
      const result = { ...current };
      if (JSON.stringify(updated) === JSON.stringify(initial))
        delete result[key];
      else result[key] = updated;
      return result;
    });
  return [value, set];
}
export function DiscardDraft({ prefix }: { prefix: string }) {
  const {
    drafts,
    clearDrafts,
    language: { t },
  } = useStaff();
  if (!Object.keys(drafts).some((key) => key.startsWith(prefix))) return null;
  return (
    <button
      className="secondary"
      type="button"
      onClick={() => clearDrafts(prefix)}
    >
      {t("discardDraft")}
    </button>
  );
}
export function StaffWorkspace({ children }: { children: ReactNode }) {
  const language = useLanguage(),
    { t, lang, setLang } = language;
  const pathname = usePathname(),
    queryClient = useQueryClient();
  const [user, setUser] = useState<StaffIdentity>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Drafts>({}),
    [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null),
    toggle = useRef<HTMLButtonElement>(null),
    identityRef = useRef<StaffIdentity | undefined>(undefined),
    endingSession = useRef(false),
    draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const clearDrafts = useCallback(
    (prefix = "") =>
      setDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.startsWith(prefix)),
        ),
      ),
    [],
  );
  const expire = useCallback(() => {
    if (endingSession.current) return;
    endingSession.current = true;
    draftsRef.current = {};
    identityRef.current = undefined;
    setUser(undefined);
    setDrafts({});
    queryClient.clear();
    setOpen(false);
    const target = safeStaffReturn(
      window.location.pathname + window.location.search,
    );
    window.location.replace(`/staff/login?next=${encodeURIComponent(target)}`);
  }, [queryClient]);
  useEffect(() => {
    let alive = true;
    const verify = async () => {
      try {
        const identity = await api<StaffIdentity & { mfaVerified: boolean }>(
          "/api/staff/me",
        );
        if (!alive) return;
        if (!identity.mfaVerified) {
          expire();
          return;
        }
        setError("");
        const previous = identityRef.current;
        if (
          previous &&
          (previous.id !== identity.id || previous.role !== identity.role)
        ) {
          draftsRef.current = {};
          setDrafts({});
          queryClient.clear();
          window.location.reload();
          return;
        }
        identityRef.current = identity;
        setUser(identity);
      } catch (e) {
        if (!alive) return;
        if (
          e instanceof ApiError &&
          (e.status === 401 || e.code === "mfa_required")
        )
          expire();
        else setError(friendly(e, lang));
      }
    };
    void verify();
    const onExpired = () => {
      if (alive) expire();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void verify();
    };
    window.addEventListener("wb:staff-expired", onExpired);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.removeEventListener("wb:staff-expired", onExpired);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [expire, lang, queryClient]);
  useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!Object.keys(draftsRef.current).length) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [drafts]);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (open) {
      modal.showModal();
      modal.querySelector<HTMLButtonElement>("button")?.focus();
      const overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        modal.close();
        document.body.style.overflow = overflow;
        toggle.current?.focus();
      };
    }
  }, [open]);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 900px)");
    const close = () => {
      if (mq.matches) setOpen(false);
    };
    mq.addEventListener("change", close);
    return () => mq.removeEventListener("change", close);
  }, []);
  const denied =
    user &&
    ((pathname.startsWith("/staff/admin/") && user.role !== "admin") ||
      (pathname.startsWith("/staff/cases") && user.role === "admin"));
  async function logout() {
    setBusy(true);
    setError("");
    try {
      await api("/api/staff/logout", { method: "POST", body: {} });
      endingSession.current = true;
      draftsRef.current = {};
      setDrafts({});
      queryClient.clear();
      setUser(undefined);
      setOpen(false);
      window.location.replace("/staff/login");
    } catch (e) {
      setError(friendly(e, lang));
    } finally {
      setBusy(false);
    }
  }
  function navigation() {
    return (
      <>
        <div className="staff-identity">
          <strong>{user?.name}</strong>
          {user && <StatusBadge state={user.role}>{t(user.role)}</StatusBadge>}
        </div>
        <nav aria-label={t("navigation")}>
          {staffNavigationGroups.map((group) => {
            const items = group.items.filter(
              (n) => user && n.roles.includes(user.role),
            );
            if (!items.length) return null;
            return (
              <div
                className="staff-nav-group"
                role="group"
                aria-label={t(group.key)}
                key={group.key}
              >
                <p className="staff-nav-heading">{t(group.key)}</p>
                {items.map(({ href, key, icon: Icon }) => (
                  <Link
                    key={href}
                    href={href}
                    onClick={() => setOpen(false)}
                    aria-current={
                      pathname === href || pathname.startsWith(href + "/")
                        ? "page"
                        : undefined
                    }
                  >
                    <Icon size={18} aria-hidden="true" />
                    {t(key)}
                  </Link>
                ))}
              </div>
            );
          })}
        </nav>
        <button
          className="secondary staff-signout"
          disabled={busy}
          onClick={() => void logout()}
        >
          <LogOut size={18} aria-hidden="true" />
          {t("signout")}
        </button>
      </>
    );
  }
  return (
    <StaffContext.Provider
      value={user ? { user, language, drafts, setDrafts, clearDrafts } : null}
    >
      <div className="suite suite-workspace staff-workspace">
        <a className="skip-link" href="#main-content">
          {t("skip")}
        </a>
        <header className="suite-header staff-header">
          <div className="brand-lockup">
            <Link className="wordmark" href="/">
              <LogoMark size={28} />
              Speak Up
            </Link>
            <span className="brand-caption">{t("staff")}</span>
          </div>
          <div className="staff-header-controls">
            <LanguageSelector value={lang} onChange={setLang} />
            {user && (
              <button
                ref={toggle}
                className="secondary staff-menu-toggle"
                aria-expanded={open}
                aria-controls="staff-menu"
                onClick={() => setOpen((v) => !v)}
              >
                <Menu size={20} aria-hidden="true" />
                {t("menu")}
              </button>
            )}
          </div>
        </header>
        <div className="staff-body">
          {user && <aside className="staff-sidebar">{navigation()}</aside>}
          <div className="staff-page">
            <main id="main-content" tabIndex={-1} className="suite-content">
              <ErrorBox error={error} />
              {!user ? (
                <p>{error ? t("retryConnection") : t("loading")}</p>
              ) : denied ? (
                <section>
                  <h1>{t("accessDenied")}</h1>
                  <Link href={staffHome(user.role)}>{t("returnToWork")}</Link>
                </section>
              ) : (
                children
              )}
            </main>
            <footer className="suite-footer">
              <span>
                <ShieldCheck size={16} aria-hidden="true" />
                {t("confidential")}
              </span>
              <span>
                Speak Up · Lixionary · <BuildSignature />
              </span>
            </footer>
          </div>
        </div>
        {user && (
          <dialog
            ref={dialog}
            id="staff-menu"
            className="staff-drawer"
            aria-label={t("navigation")}
            onKeyDown={(e) => {
              if (e.key !== "Tab") return;
              const items = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  "a[href], button:not(:disabled), select, [tabindex='0']",
                ),
              ).filter((item) => item.getClientRects().length);
              const first = items[0],
                last = items.at(-1);
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }}
            onCancel={(e) => {
              e.preventDefault();
              setOpen(false);
            }}
            onClick={(e) => {
              if (e.target === dialog.current) setOpen(false);
            }}
          >
            <div className="staff-drawer-panel">
              <button
                className="secondary staff-drawer-close"
                aria-label={t("closeMenu")}
                onClick={() => setOpen(false)}
              >
                <X size={20} aria-hidden="true" />
                {t("closeMenu")}
              </button>
              {navigation()}
            </div>
          </dialog>
        )}
      </div>
    </StaffContext.Provider>
  );
}
