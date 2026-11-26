"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Icon } from "./icon";

export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button className="button button--secondary" onClick={() => startTransition(() => router.refresh())} disabled={pending}><Icon name="refresh" size={17} />{pending ? "Refreshing…" : "Refresh data"}</button>;
}
