import type { Metadata } from "next";
import { DevicesView } from "./devices-view";

export const metadata: Metadata = { title: "Devices" };
export const dynamic = "force-dynamic";

export default function DevicesPage() { return <DevicesView />; }
