export type IconName = "overview" | "activity" | "devices" | "policies" | "menu" | "plus" | "refresh" | "shield" | "arrow" | "copy" | "check" | "search";

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, string> = {
    overview: "M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z",
    activity: "M3 12h4l2.5-7 5 14 2.5-7h4",
    devices: "M4 5h16v11H4V5Zm5 15h6m-3-4v4",
    policies: "M12 3 4.5 6v5.5c0 4.4 3.2 7.8 7.5 9.5 4.3-1.7 7.5-5.1 7.5-9.5V6L12 3Zm-3 9 2 2 4-5",
    menu: "M4 7h16M4 12h16M4 17h16",
    plus: "M12 5v14M5 12h14",
    refresh: "M20 7v5h-5M4 17v-5h5m9.5-3A7 7 0 0 0 6 6.5L4 9m2 6a7 7 0 0 0 12 2.5l2-2.5",
    shield: "M12 3 4.5 6v5.5c0 4.4 3.2 7.8 7.5 9.5 4.3-1.7 7.5-5.1 7.5-9.5V6L12 3Z",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    copy: "M8 8h11v11H8V8ZM5 16H4V5h11v1",
    check: "m5 12 4 4L19 6",
    search: "m20 20-4.5-4.5M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
