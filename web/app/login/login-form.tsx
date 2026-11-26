"use client";

import { FormEvent, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiBrowser } from "@/lib/client";
import { Icon } from "@/components/icon";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    const form = new FormData(event.currentTarget);
    try {
      await apiBrowser("/v1/auth/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
      const requested = searchParams.get("next");
      router.replace(requested && ["/", "/activity", "/devices", "/policies"].includes(requested) ? requested : "/");
      router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign in"); }
    finally { setPending(false); }
  }

  return <form className="login-form" onSubmit={submit} noValidate={false}><div className="field"><label htmlFor="username">Username</label><input id="username" name="username" type="text" autoComplete="username" autoCapitalize="none" required maxLength={254} autoFocus /></div><div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" autoComplete="current-password" required maxLength={72} /></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="button button--primary login-submit" type="submit" disabled={pending}>{pending ? <><span className="spinner" />Signing in…</> : <>Sign in to dashboard<Icon name="arrow" size={18} /></>}</button></form>;
}
