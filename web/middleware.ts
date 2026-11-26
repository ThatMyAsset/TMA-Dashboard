import { NextRequest, NextResponse } from "next/server";

const publicPaths = new Set(["/login"]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/") || pathname.startsWith("/_next/") || pathname === "/favicon.ico") return NextResponse.next();
  const authenticated = request.cookies.has("tma_admin_session");
  if (!authenticated && !publicPaths.has(pathname)) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
