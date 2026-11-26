import { NextRequest, NextResponse } from "next/server";
import { apiTarget } from "@/lib/api";

const allowed = new Set(["GET", "POST"]);
const hopHeaders = new Set(["connection", "content-length", "host", "transfer-encoding"]);

async function proxy(request: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!allowed.has(request.method)) return NextResponse.json({ error: { code: "method_not_allowed", message: "Method not allowed" } }, { status: 405 });
  const { path } = await params;
  let target: string;
  try { target = apiTarget(`/${path.join("/")}${request.nextUrl.search}`); }
  catch { return NextResponse.json({ error: { code: "invalid_path", message: "Invalid API path" } }, { status: 400 }); }
  const headers = new Headers();
  for (const name of ["content-type", "cookie", "origin"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!hopHeaders.has(key.toLowerCase())) responseHeaders.append(key, value);
    });
    return new NextResponse(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: { code: "control_plane_unavailable", message: "Control plane request failed" } }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST };
