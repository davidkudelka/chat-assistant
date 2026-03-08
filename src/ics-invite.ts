import { Resend } from "resend";
import { config, Person } from "./config.js";
import { v4 as uuid } from "uuid";
import { storeICSEvent, getICSEvent, incrementICSSequence, removeICSEvent } from "./db.js";

// ────────────────────────────────────────────────────
// ICS generation
// ────────────────────────────────────────────────────

type ICSMethod = "REQUEST" | "CANCEL";
type ICSStatus = "CONFIRMED" | "CANCELLED";

interface ICSEventInput {
  uid: string;
  sequence: number;
  method: ICSMethod;
  status: ICSStatus;
  title: string;
  description?: string;
  location?: string;
  startTime: Date;
  endTime: Date;
  organizerEmail: string;
  organizerName?: string;
  attendees: { email: string; name?: string }[];
}

/**
 * Generate an RFC 5545 iCalendar (.ics) string.
 *
 * Key fields for update/cancel support:
 * - UID: must stay the same across create → update → cancel
 * - SEQUENCE: must increment on each update (0 → 1 → 2 ...)
 * - METHOD: REQUEST for create/update, CANCEL for cancellation
 * - STATUS: CONFIRMED for create/update, CANCELLED for cancel
 */
export function generateICS(event: ICSEventInput): string {
  const now = formatICSDate(new Date());
  const start = formatICSDate(event.startTime);
  const end = formatICSDate(event.endTime);

  const attendeeLines = event.attendees
    .map(
      (a) =>
        `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;` +
        `RSVP=TRUE;CN=${a.name ?? a.email}:mailto:${a.email}`,
    )
    .join("\r\n");

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//WhatsApp Calendar Bot//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${event.method}`,
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${escapeICS(event.title)}`,
    event.description ? `DESCRIPTION:${escapeICS(event.description)}` : "",
    event.location ? `LOCATION:${escapeICS(event.location)}` : "",
    `ORGANIZER;CN=${event.organizerName ?? "Calendar Bot"}:mailto:${event.organizerEmail}`,
    attendeeLines,
    `STATUS:${event.status}`,
    `SEQUENCE:${event.sequence}`,
  ];

  // Only add reminder for active events
  if (event.status === "CONFIRMED") {
    lines.push(
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      "END:VALARM",
    );
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.filter(Boolean).join("\r\n");
}

// ────────────────────────────────────────────────────
// Resend client (lazy-initialized)
// ────────────────────────────────────────────────────

let resend: Resend | null = null;

function getResend(): Resend | null {
  if (resend) return resend;
  if (!config.resendApiKey) return null;
  resend = new Resend(config.resendApiKey);
  return resend;
}

// ────────────────────────────────────────────────────
// Public API: create / update / cancel invites
// ────────────────────────────────────────────────────

interface SendResult {
  sent: string[];
  skipped: string[];
  errors: string[];
  icsUid: string;
}

/**
 * Send a NEW .ics invite. Generates a fresh UID and tracks the event.
 */
export async function sendICSInvite(
  recipients: Person[],
  event: {
    gcalEventId: string;
    title: string;
    description?: string;
    location?: string;
    startTime: Date;
    endTime: Date;
    allAttendees: { email: string; name?: string }[];
  },
): Promise<SendResult> {
  const icsUid = `${uuid()}@whatsapp-calendar-bot`;

  const nonGoogleRecipients = recipients.filter((p) => p.calendar !== "google");
  const nonGoogleEmails = nonGoogleRecipients.map((p) => p.email);

  // Track the event in the database for future updates/cancellations
  storeICSEvent(event.gcalEventId, icsUid, event.title, nonGoogleEmails);

  return sendICSEmail(nonGoogleRecipients, {
    uid: icsUid,
    sequence: 0,
    method: "REQUEST",
    status: "CONFIRMED",
    title: event.title,
    description: event.description,
    location: event.location,
    startTime: event.startTime,
    endTime: event.endTime,
    attendees: event.allAttendees,
    subject: `Calendar Invite: ${event.title}`,
    bodyPrefix: "You've been invited to",
  });
}

/**
 * Send an UPDATED .ics invite. Reuses the same UID, increments SEQUENCE.
 * Apple Calendar / Outlook will update the existing event in-place.
 */
export async function sendICSUpdate(
  recipients: Person[],
  event: {
    gcalEventId: string;
    title: string;
    description?: string;
    location?: string;
    startTime: Date;
    endTime: Date;
    allAttendees: { email: string; name?: string }[];
  },
): Promise<SendResult> {
  const tracked = getICSEvent(event.gcalEventId);

  if (!tracked) {
    // No prior .ics was sent — treat as a new invite
    return sendICSInvite(recipients, event);
  }

  // Increment sequence number in DB
  const newSequence = incrementICSSequence(event.gcalEventId, event.title);

  const nonGoogleRecipients = recipients.filter((p) => p.calendar !== "google");

  return sendICSEmail(nonGoogleRecipients, {
    uid: tracked.ics_uid,
    sequence: newSequence,
    method: "REQUEST",
    status: "CONFIRMED",
    title: event.title,
    description: event.description,
    location: event.location,
    startTime: event.startTime,
    endTime: event.endTime,
    attendees: event.allAttendees,
    subject: `Updated: ${event.title}`,
    bodyPrefix: "This event has been updated",
  });
}

/**
 * Send a CANCELLATION .ics. Same UID, incremented SEQUENCE, METHOD:CANCEL.
 * Apple Calendar / Outlook will remove the event.
 */
export async function sendICSCancel(
  recipients: Person[],
  gcalEventId: string,
  event: {
    startTime: Date;
    endTime: Date;
    allAttendees: { email: string; name?: string }[];
  },
): Promise<SendResult> {
  const tracked = removeICSEvent(gcalEventId);

  if (!tracked) {
    // We never sent an .ics for this event — nothing to cancel
    return { sent: [], skipped: [], errors: [], icsUid: "" };
  }

  const newSequence = tracked.sequence + 1;
  const nonGoogleRecipients = recipients.filter((p) => p.calendar !== "google");

  return sendICSEmail(nonGoogleRecipients, {
    uid: tracked.ics_uid,
    sequence: newSequence,
    method: "CANCEL",
    status: "CANCELLED",
    title: tracked.title,
    startTime: event.startTime,
    endTime: event.endTime,
    attendees: event.allAttendees,
    subject: `Cancelled: ${tracked.title}`,
    bodyPrefix: "This event has been cancelled",
  });
}

// ────────────────────────────────────────────────────
// Internal: shared email sending logic
// ────────────────────────────────────────────────────

async function sendICSEmail(
  recipients: Person[],
  params: Omit<ICSEventInput, "organizerEmail" | "organizerName"> & {
    subject: string;
    bodyPrefix: string;
  },
): Promise<SendResult> {
  const result: SendResult = { sent: [], skipped: [], errors: [], icsUid: params.uid };

  if (recipients.length === 0) return result;

  const client = getResend();
  if (!client) {
    recipients.forEach((p) => result.skipped.push(p.email));
    return result;
  }

  const organizerEmail = config.emailFrom.match(/<(.+)>/)?.[1] ?? config.emailFrom;

  const icsContent = generateICS({
    uid: params.uid,
    sequence: params.sequence,
    method: params.method,
    status: params.status,
    title: params.title,
    description: params.description,
    location: params.location,
    startTime: params.startTime,
    endTime: params.endTime,
    organizerEmail,
    organizerName: "Calendar Bot",
    attendees: params.attendees,
  });

  const timeStr = `${params.startTime.toLocaleString()} - ${params.endTime.toLocaleString()}`;
  const textBody = [
    `${params.bodyPrefix}: ${params.title}`,
    `When: ${timeStr}`,
    params.location ? `Where: ${params.location}` : "",
    "",
    "Please see the attached calendar invite.",
  ]
    .filter(Boolean)
    .join("\n");

  for (const person of recipients) {
    try {
      await client.emails.send({
        from: config.emailFrom,
        to: person.email,
        subject: params.subject,
        text: textBody,
        headers: {
          "Content-Type": `text/calendar; method=${params.method}`,
        },
        attachments: [
          {
            filename: "invite.ics",
            content: Buffer.from(icsContent).toString("base64"),
            contentType: `text/calendar; method=${params.method}`,
          },
        ],
      });
      result.sent.push(person.email);
    } catch (err) {
      console.error(`Failed to send ICS to ${person.email}:`, err);
      result.errors.push(person.email);
    }
  }

  return result;
}

// ── Helpers ──

function formatICSDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}
