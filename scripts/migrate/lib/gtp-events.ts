/**
 * Legacy `events` -> `events-awards/industry-calendar` articles (gtp-launch
 * P4, A3, A12-N05, A13-R06). Pure. `briefs[]` rows follow the Phase 3 parser:
 * "Event date" (ISO), "Event end" (only when different), "Location", "Link"
 * (only when the event has a url); max 4 rows, each with non-empty
 * label/value/source; source = url host or "Industry calendar".
 * De-dupe against the industry-calendar articles on normalised title AND date;
 * near matches (similarity >= threshold, different date) are listed, not imported.
 */
import { normaliseWs, str } from "./gtp-transform";

export interface LegacyEvent {
  id: string;
  title: string;
  dateStart: string | null; // ISO date YYYY-MM-DD
  dateEnd: string | null;
  location: string;
  category: string;
  url: string;
  note: string;
  active: boolean;
}

export interface CalendarRef {
  title: string;
  date: string | null; // YYYY-MM-DD
  legacyId: string;
}

export interface Brief {
  label: string;
  value: string;
  source: string;
}

export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

export function toLegacyEvent(row: Record<string, unknown>): LegacyEvent {
  return {
    id: String(row.id),
    title: normaliseWs(str(row.title)),
    dateStart: isoDate(row.date_start),
    dateEnd: isoDate(row.date_end),
    location: normaliseWs(str(row.location)),
    category: normaliseWs(str(row.category)),
    url: str(row.url),
    note: normaliseWs(str(row.note)),
    active: row.active === true || row.active === "true" || row.active === "t",
  };
}

export function normTitle(t: string): string {
  return t.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Bigram Dice similarity of normalised titles. */
export function similarity(a: string, b: string): number {
  const A = normTitle(a);
  const B = normTitle(b);
  if (A === B) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const ga = grams(A);
  const gb = grams(B);
  let inter = 0;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(1, A.length - 1) + Math.max(1, B.length - 1);
  return (2 * inter) / total;
}

function sourceFor(url: string): string {
  try {
    return new URL(url).host || "Industry calendar";
  } catch {
    return "Industry calendar";
  }
}

export function eventBriefs(e: LegacyEvent): Brief[] {
  const source = e.url ? sourceFor(e.url) : "Industry calendar";
  const rows: Brief[] = [];
  if (e.dateStart) rows.push({ label: "Event date", value: e.dateStart, source });
  if (e.dateEnd && e.dateEnd !== e.dateStart) rows.push({ label: "Event end", value: e.dateEnd, source });
  if (e.location) rows.push({ label: "Location", value: e.location, source });
  if (e.url) rows.push({ label: "Link", value: e.url, source });
  return rows.slice(0, 4).filter((b) => b.label && b.value && b.source);
}

export interface EventDecision {
  imports: LegacyEvent[];
  duplicates: { event: LegacyEvent; of: string }[];
  near: { event: LegacyEvent; of: string; similarity: number }[];
}

export function planEvents(events: readonly LegacyEvent[], calendar: readonly CalendarRef[], threshold: number): EventDecision {
  const out: EventDecision = { imports: [], duplicates: [], near: [] };
  for (const e of events) {
    const dup = calendar.find((c) => normTitle(c.title) === normTitle(e.title) && c.date === e.dateStart);
    if (dup) {
      out.duplicates.push({ event: e, of: dup.legacyId });
      continue;
    }
    let best: { c: CalendarRef; s: number } | undefined;
    for (const c of calendar) {
      const s = similarity(c.title, e.title);
      if (s >= threshold && c.date !== e.dateStart && (!best || s > best.s)) best = { c, s };
    }
    if (best) {
      out.near.push({ event: e, of: best.c.legacyId, similarity: Math.round(best.s * 1000) / 1000 });
      continue;
    }
    out.imports.push(e);
  }
  return out;
}

export function eventStatus(e: LegacyEvent): "published" | "archived" {
  return e.active ? "published" : "archived";
}

export function eventDek(e: LegacyEvent): string {
  return [e.category, e.location].filter(Boolean).join(" · ");
}
