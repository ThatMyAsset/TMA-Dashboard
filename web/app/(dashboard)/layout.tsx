import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { apiServer } from "@/lib/api";
import { AppShell } from "@/components/app-shell";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  let session: { username: string };
  try { session = await apiServer<{ username: string }>("/api/v1/auth/session"); }
  catch { redirect("/login"); }
  return <AppShell username={session.username}>{children}</AppShell>;
}
