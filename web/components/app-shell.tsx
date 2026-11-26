"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { apiBrowser } from "@/lib/client";
import { Icon, type IconName } from "./icon";

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/activity", label: "Activity", icon: "activity" },
  { href: "/devices", label: "Devices", icon: "devices" },
  { href: "/policies", label: "Policies", icon: "policies" }
];

export function AppShell({ username, children }: { username: string; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const firstLink = useRef<HTMLAnchorElement>(null);
  const current = navigation.find((item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href));

  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    document.body.classList.toggle("menu-open", open);
    if (open) firstLink.current?.focus();
    return () => document.body.classList.remove("menu-open");
  }, [open]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && open) { setOpen(false); menuButton.current?.focus(); } };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open]);

  async function logout() {
    setLoggingOut(true);
    try {
      await apiBrowser("/v1/auth/logout", { method: "POST", body: "{}" });
      router.replace("/login");
      router.refresh();
    } finally { setLoggingOut(false); }
  }

  return <>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <aside className={`sidebar ${open ? "sidebar--open" : ""}`} aria-label="Main navigation">
      <Link className="brand" href="/" aria-label="TMA Control Center overview"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>TMA <strong>Control Center</strong></span></Link>
      <nav className="nav-list">{navigation.map((item) => <Link ref={item === navigation[0] ? firstLink : undefined} key={item.href} href={item.href} className={current === item ? "nav-link nav-link--active" : "nav-link"} aria-current={current === item ? "page" : undefined}><Icon name={item.icon} /><span>{item.label}</span></Link>)}</nav>
      <div className="sidebar-foot"><div className="scope-label">Initial protection scope</div><p>Browser activity and local text inspection. Metadata only.</p><a href="https://github.com/thatmyassets" target="_blank" rel="noreferrer">Project resources <span aria-hidden="true">↗</span></a></div>
    </aside>
    {open && <button className="menu-scrim" aria-label="Close navigation" onClick={() => { setOpen(false); menuButton.current?.focus(); }} />}
    <div className="app-column">
      <header className="topbar"><div className="topbar-left"><button ref={menuButton} className="icon-button menu-button" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(true)}><Icon name="menu" /></button><span className="breadcrumb">Control Center <span aria-hidden="true">/</span> <strong>{current?.label ?? "Page"}</strong></span></div><div className="account"><span className="avatar" aria-hidden="true">{username.slice(0, 1).toUpperCase()}</span><span className="account-name">{username}</span><button className="text-button" onClick={logout} disabled={loggingOut}>{loggingOut ? "Signing out…" : "Sign out"}</button></div></header>
      <main id="main-content" className="main-content">{children}</main>
      <footer className="app-footer"><span>TMA Control Center</span><span>No prompt or file content is displayed or retained.</span></footer>
    </div>
  </>;
}
