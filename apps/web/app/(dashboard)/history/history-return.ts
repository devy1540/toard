export function safeHistoryReturnTo(value: string): string {
  return value === "/history" || value.startsWith("/history?") ? value : "/history";
}
