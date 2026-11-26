"use client";

import { useRouter } from "next/navigation";
import { ErrorState } from "./ui";

export function OverviewError({ message }: { message: string }) {
  const router = useRouter();
  return <ErrorState message={message} retry={() => router.refresh()} />;
}
