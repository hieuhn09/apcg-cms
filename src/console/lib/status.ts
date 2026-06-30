/** Shared workflow-status → badge tone mapping, reused across console views. */
type Tone = "default" | "good" | "warn" | "bad" | "muted" | "accent";

export function statusTone(status: string): Tone {
  switch (status) {
    case "published":
    case "approved":
      return "good";
    case "pending_review":
    case "scheduled":
      return "warn";
    case "hidden":
    case "archived":
      return "muted";
    default:
      return "default"; // draft
  }
}

export function originTone(origin: string): Tone {
  switch (origin) {
    case "engine":
      return "accent";
    case "manual":
      return "good";
    default:
      return "muted"; // import / unknown
  }
}
