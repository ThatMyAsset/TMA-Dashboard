import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return <main className="login-page"><section className="login-story"><div className="brand brand--login"><span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>TMA <strong>Control Center</strong></span></div><div className="login-message"><p className="eyebrow">AI data loss prevention</p><h1>Control what leaves through AI.</h1><p>One place to enroll endpoints, version protection policies, and verify browser enforcement without collecting prompt or file content.</p></div><div className="login-scope"><span className="status-dot" />Metadata-only administration</div></section><section className="login-panel" aria-label="Administrator sign in"><div><p className="eyebrow">Administrator access</p><h2>Sign in to Control Center</h2><p className="login-description">Use your control plane administrator credentials.</p><Suspense fallback={<p role="status">Loading sign-in form…</p>}><LoginForm /></Suspense></div><p className="login-note">Protected by an HTTP-only, SameSite session cookie. Sessions expire automatically.</p></section></main>;
}
