import type { Metadata } from "next";
import { PoliciesView } from "./policies-view";

export const metadata: Metadata = { title: "Policies" };
export const dynamic = "force-dynamic";

export default function PoliciesPage() { return <PoliciesView />; }
