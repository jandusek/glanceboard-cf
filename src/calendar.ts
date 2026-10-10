import ICAL from "ical.js";
import { dayKey, formatTime12h, isValidTimeZone, wallClock, zonedToEpoch } from "./time";

export interface CalendarEvent {
  summary: string;
  /** "9:00 AM", or "All day". */
  time: string;
  /** Sort key; all-day events sort first. */
  startMs: number;
  allDay: boolean;
  location: string;
  description: string;
}

const MAX_OCCURRENCES = 20000;

export async function fetchTodaysEvents(icalUrl: string, timeZone: string, now = Date.now()): Promise<CalendarEvent[]> {
  // webcal:// is how Google and Apple hand out feed links; it's plain HTTPS underneath.
  const url = icalUrl.trim().replace(/^webcal:\/\//i, "https://");
  const res = await fetch(url, { headers: { accept: "text/calendar" } });
  if (!res.ok) throw new Error(`Calendar feed returned HTTP ${res.status}`);
  return eventsOnDay(await res.text(), timeZone, now);
}

/** Events overlapping the local day that contains `now`, in `timeZone`. */
export function eventsOnDay(ics: string, timeZone: string, now: number): CalendarEvent[] {
  const today = wallClock(now, timeZone);
  const todayKey = dayKey(today);
  const dayStart = zonedToEpoch(today.year, today.month, today.day, 0, 0, 0, timeZone);
  const next = wallClock(dayStart + 36 * 3600_000, timeZone);
  const dayEnd = zonedToEpoch(next.year, next.month, next.day, 0, 0, 0, timeZone);

  const root = new ICAL.Component(ICAL.parse(ics));
  const vevents = root.getAllSubcomponents("vevent");

  // Masters and their moved/edited instances (RECURRENCE-ID) share a UID.
  const masters = new Map<string, ICAL.Event>();
  const orphans: ICAL.Component[] = [];
  for (const vevent of vevents) {
    if (!vevent.hasProperty("recurrence-id")) {
      masters.set(String(vevent.getFirstPropertyValue("uid")), new ICAL.Event(vevent));
    }
  }
  for (const vevent of vevents) {
    if (!vevent.hasProperty("recurrence-id")) continue;
    const master = masters.get(String(vevent.getFirstPropertyValue("uid")));
    if (master) master.relateException(vevent);
    else orphans.push(vevent);
  }

  const out: CalendarEvent[] = [];
  const consider = (item: ICAL.Event, start: ICAL.Time, end: ICAL.Time) => {
    if (String(item.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    if (start.isDate) {
      // All-day: DTEND is exclusive; a missing DTEND means one day.
      const startKey = dateKey(start);
      const endKey = end && end.isDate ? dateKey(end) : startKey;
      const covers = startKey === endKey ? startKey === todayKey : startKey <= todayKey && todayKey < endKey;
      if (covers) out.push(toEvent(item, "All day", dayStart, true));
      return;
    }
    const startMs = toEpoch(start, item.component, "dtstart", timeZone);
    const endMs = end ? toEpoch(end, item.component, "dtend", timeZone) : startMs;
    const overlaps = startMs < dayEnd && (endMs > dayStart || (endMs === startMs && startMs >= dayStart));
    if (!overlaps) return;
    const local = wallClock(Math.max(startMs, dayStart), timeZone);
    const label = startMs < dayStart ? "All day" : formatTime12h(local.hour, local.minute);
    out.push(toEvent(item, label, startMs, startMs < dayStart));
  };

  for (const event of masters.values()) {
    if (!event.isRecurring()) {
      consider(event, event.startDate, event.endDate);
      continue;
    }
    const it = event.iterator();
    for (let i = 0, t: ICAL.Time | null; i < MAX_OCCURRENCES && (t = it.next()); i++) {
      const details = event.getOccurrenceDetails(t);
      const start = details.startDate;
      // Cheap early exit: occurrences are in order, so stop once past today.
      const roughMs = start.isDate
        ? Date.UTC(start.year, start.month - 1, start.day)
        : toEpoch(start, details.item.component, "dtstart", timeZone);
      if (roughMs >= dayEnd + 2 * 86400_000) break;
      consider(details.item, start, details.endDate);
    }
  }
  for (const vevent of orphans) {
    const event = new ICAL.Event(vevent);
    consider(event, event.startDate, event.endDate);
  }

  return out.sort((a, b) => a.startMs - b.startMs || a.summary.localeCompare(b.summary));
}

function dateKey(t: ICAL.Time): string {
  return dayKey({ year: t.year, month: t.month, day: t.day });
}

/**
 * Epoch ms for an ICAL.Time. TZIDs are resolved through Intl when they are IANA
 * names (Google's are), so DST is right even without a usable VTIMEZONE.
 * Floating times are read in the board's own zone.
 */
function toEpoch(t: ICAL.Time, component: ICAL.Component, propName: string, boardZone: string): number {
  if (t.zone && t.zone.tzid === "UTC") return t.toUnixTime() * 1000;
  // Events using DURATION have no DTEND; their end shares DTSTART's zone.
  const prop = component.getFirstProperty(propName) ?? component.getFirstProperty("dtstart");
  const tzid = prop?.getParameter("tzid");
  const zone = typeof tzid === "string" && isValidTimeZone(tzid) ? tzid : boardZone;
  return zonedToEpoch(t.year, t.month, t.day, t.hour, t.minute, t.second, zone);
}

function toEvent(item: ICAL.Event, time: string, startMs: number, allDay: boolean): CalendarEvent {
  return {
    summary: (item.summary || "Untitled event").trim(),
    time,
    startMs: allDay ? startMs - 1 : startMs,
    allDay,
    location: (item.location || "").trim(),
    description: (item.description || "").trim(),
  };
}
