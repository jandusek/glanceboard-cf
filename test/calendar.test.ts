import { describe, expect, it } from "vitest";
import { eventsOnDay } from "../src/calendar";
import { zonedToEpoch } from "../src/time";

const TZ = "Australia/Sydney";
const ics = (body: string) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:test", body.trim(), "END:VCALENDAR"].join("\r\n");
const at = (y: number, m: number, d: number, h = 8) => zonedToEpoch(y, m, d, h, 0, 0, TZ);
const summaries = (src: string, now: number) => eventsOnDay(src, TZ, now).map((e) => `${e.time} ${e.summary}`);

describe("eventsOnDay", () => {
  it("converts zoned and UTC times to the board's zone", () => {
    const src = ics(`
BEGIN:VEVENT
UID:a
DTSTART;TZID=Australia/Sydney:20261008T093000
DTEND;TZID=Australia/Sydney:20261008T103000
SUMMARY:Swim
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART:20261008T043000Z
DTEND:20261008T053000Z
SUMMARY:Piano
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART;TZID=Europe/Prague:20261008T080000
DTEND;TZID=Europe/Prague:20261008T090000
SUMMARY:Call with Prague
END:VEVENT`);
    // 04:30Z = 15:30 AEDT; 08:00 Prague (CEST, +2) = 17:00 Sydney (AEDT, +11).
    expect(summaries(src, at(2026, 10, 8))).toEqual(["9:30 AM Swim", "3:30 PM Piano", "5:00 PM Call with Prague"]);
  });

  it("handles all-day events, including multi-day spans with exclusive DTEND", () => {
    const src = ics(`
BEGIN:VEVENT
UID:a
DTSTART;VALUE=DATE:20261008
DTEND;VALUE=DATE:20261009
SUMMARY:School holiday
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART;VALUE=DATE:20261006
DTEND;VALUE=DATE:20261008
SUMMARY:Ended yesterday
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART;VALUE=DATE:20261007
DTEND;VALUE=DATE:20261010
SUMMARY:Camp
END:VEVENT`);
    expect(summaries(src, at(2026, 10, 8))).toEqual(["All day Camp", "All day School holiday"]);
  });

  it("expands weekly recurrences, honouring EXDATE, moved instances and cancellations", () => {
    const src = ics(`
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Australia/Sydney:20260101T160000
DTEND;TZID=Australia/Sydney:20260101T170000
RRULE:FREQ=WEEKLY;BYDAY=TH
EXDATE;TZID=Australia/Sydney:20261015T160000
SUMMARY:Football
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Australia/Sydney:20261022T160000
DTSTART;TZID=Australia/Sydney:20261022T180000
DTEND;TZID=Australia/Sydney:20261022T190000
SUMMARY:Football (late)
END:VEVENT
BEGIN:VEVENT
UID:cancelled
DTSTART;TZID=Australia/Sydney:20261008T120000
DTEND;TZID=Australia/Sydney:20261008T130000
STATUS:CANCELLED
SUMMARY:Lunch
END:VEVENT`);
    expect(summaries(src, at(2026, 10, 8))).toEqual(["4:00 PM Football"]);
    expect(summaries(src, at(2026, 10, 15))).toEqual([]);
    expect(summaries(src, at(2026, 10, 22))).toEqual(["6:00 PM Football (late)"]);
    // Recurrence from January stays at 4 PM local across the October DST change.
    expect(summaries(src, at(2026, 10, 29))).toEqual(["4:00 PM Football"]);
  });

  it("reads floating times in the board's zone and ignores other days", () => {
    const src = ics(`
BEGIN:VEVENT
UID:a
DTSTART:20261008T070000
DTEND:20261008T080000
SUMMARY:Breakfast
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART:20261009T070000
SUMMARY:Tomorrow
END:VEVENT`);
    expect(summaries(src, at(2026, 10, 8, 23))).toEqual(["7:00 AM Breakfast"]);
  });
});
