import { cookies } from "next/headers";

const apiBase = () => process.env.CONTROL_PLANE_URL ?? "http://127.0.0.1:8080";

export async function apiServer<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const session = cookieStore.get("tma_admin_session");
  const response = await fetch(`${apiBase()}${path}`, {
    headers: session ? { Cookie: `tma_admin_session=${session.value}` } : {},
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Control plane returned ${response.status}`);
  }
  return (await response.json()) as T;
}

export function apiTarget(path: string) {
  if (!path.startsWith("/v1/") || path.includes("..") || /[\s\\]/.test(path)) throw new Error("Invalid API path");
  return `${apiBase()}/api${path}`;
}
