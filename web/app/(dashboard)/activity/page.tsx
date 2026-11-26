import type { Metadata } from "next";
import { ActivityView } from "./activity-view";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

export default function ActivityPage() { return <ActivityView />; }
