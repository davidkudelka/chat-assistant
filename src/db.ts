import Database from "better-sqlite3";
import path from "path";
import type { CalendarProvider, Person, PersonRole } from "./config.js";

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const DB_PATH = path.join(DATA_DIR, "bot.db");

let db: Database.Database;

export function initDB(): void {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS people (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      calendar TEXT NOT NULL DEFAULT 'google',
      role TEXT NOT NULL DEFAULT 'client'
    );

    CREATE TABLE IF NOT EXISTS gym_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_sessions INTEGER NOT NULL,
      used_sessions INTEGER NOT NULL DEFAULT 0,
      purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS gym_session_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_id INTEGER NOT NULL,
      gcal_event_id TEXT,
      session_number INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      cancelled INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (package_id) REFERENCES gym_packages(id)
    );

    CREATE TABLE IF NOT EXISTS ics_events (
      gcal_event_id TEXT PRIMARY KEY,
      ics_uid TEXT NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      non_google_recipients TEXT NOT NULL DEFAULT '[]'
    );
  `);

  // Migration: add role column if missing (existing DBs created before role support)
  const columns = db.prepare("PRAGMA table_info(people)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "role")) {
    db.exec("ALTER TABLE people ADD COLUMN role TEXT NOT NULL DEFAULT 'client'");
  }

  seedPeople();
}

// ── People registry ──

interface PersonRow {
  key: string;
  name: string;
  email: string;
  calendar: string;
  role: string;
}

function rowToPerson(row: PersonRow): Person {
  return {
    name: row.name,
    email: row.email,
    calendar: row.calendar as CalendarProvider,
    role: row.role as PersonRole,
  };
}

function seedPeople(): void {
  const count = (db.prepare("SELECT COUNT(*) as n FROM people").get() as { n: number }).n;
  if (count > 0) return;

  const userEmail = process.env.USER_EMAIL ?? "";
  const userName = process.env.USER_NAME ?? "David";

  if (userEmail) {
    db.prepare(
      "INSERT INTO people (key, name, email, calendar, role) VALUES (?, ?, ?, ?, ?)",
    ).run(userName.toLowerCase(), userName, userEmail, "google", "client");
  }
}

export function resolvePerson(name: string): Person | null {
  const row = db
    .prepare("SELECT * FROM people WHERE key = ?")
    .get(name.toLowerCase()) as PersonRow | undefined;
  return row ? rowToPerson(row) : null;
}

export function getAllPeople(): Person[] {
  const rows = db.prepare("SELECT * FROM people").all() as PersonRow[];
  return rows.map(rowToPerson);
}

export function getPeopleList(): string {
  const people = getAllPeople();
  if (people.length === 0) return "No people registered.";
  return people
    .map((p) => `- ${p.name}: ${p.email} (${p.calendar} calendar, role: ${p.role})`)
    .join("\n");
}

export function upsertPerson(
  key: string,
  name: string,
  email: string,
  calendar: CalendarProvider,
  role: PersonRole,
): Person {
  db.prepare(
    `INSERT INTO people (key, name, email, calendar, role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET name = excluded.name, email = excluded.email, calendar = excluded.calendar, role = excluded.role`,
  ).run(key.toLowerCase(), name, email, calendar, role);
  return { name, email, calendar, role };
}

export function closeDB(): void {
  db?.close();
}

// ── Gym packages ──

export interface GymPackage {
  id: number;
  total_sessions: number;
  used_sessions: number;
  purchased_at: string;
  active: number;
}

export function createGymPackage(totalSessions: number): GymPackage {
  const stmt = db.prepare("INSERT INTO gym_packages (total_sessions) VALUES (?) RETURNING *");
  return stmt.get(totalSessions) as GymPackage;
}

export function getActiveGymPackage(): GymPackage | null {
  const stmt = db.prepare("SELECT * FROM gym_packages WHERE active = 1 ORDER BY id DESC LIMIT 1");
  return (stmt.get() as GymPackage) ?? null;
}

export function getAllGymPackages(): GymPackage[] {
  const stmt = db.prepare("SELECT * FROM gym_packages ORDER BY id DESC");
  return stmt.all() as GymPackage[];
}

export function setGymPackage(totalSessions: number, usedSessions: number): GymPackage {
  // Deactivate any existing active package
  db.prepare("UPDATE gym_packages SET active = 0 WHERE active = 1").run();
  const stmt = db.prepare(
    "INSERT INTO gym_packages (total_sessions, used_sessions) VALUES (?, ?) RETURNING *",
  );
  return stmt.get(totalSessions, usedSessions) as GymPackage;
}

export function useGymSession(packageId: number, gcalEventId: string, sessionNumber: number): void {
  const txn = db.transaction(() => {
    db.prepare("UPDATE gym_packages SET used_sessions = used_sessions + 1 WHERE id = ?").run(
      packageId,
    );
    db.prepare(
      "INSERT INTO gym_session_log (package_id, gcal_event_id, session_number) VALUES (?, ?, ?)",
    ).run(packageId, gcalEventId, sessionNumber);
  });
  txn();
}

export function cancelGymSession(gcalEventId: string): boolean {
  const txn = db.transaction(() => {
    const session = db
      .prepare("SELECT * FROM gym_session_log WHERE gcal_event_id = ? AND cancelled = 0")
      .get(gcalEventId) as { package_id: number } | undefined;

    if (!session) return false;

    db.prepare("UPDATE gym_session_log SET cancelled = 1 WHERE gcal_event_id = ?").run(gcalEventId);
    db.prepare("UPDATE gym_packages SET used_sessions = used_sessions - 1 WHERE id = ?").run(
      session.package_id,
    );

    return true;
  });
  return txn();
}

// ── ICS event tracking (replaces in-memory store) ──

export interface StoredICSEvent {
  gcal_event_id: string;
  ics_uid: string;
  sequence: number;
  title: string;
  non_google_recipients: string;
}

export function storeICSEvent(
  gcalEventId: string,
  icsUid: string,
  title: string,
  nonGoogleEmails: string[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO ics_events (gcal_event_id, ics_uid, sequence, title, non_google_recipients)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(gcalEventId, icsUid, title, JSON.stringify(nonGoogleEmails));
}

export function getICSEvent(gcalEventId: string): StoredICSEvent | null {
  const row = db.prepare("SELECT * FROM ics_events WHERE gcal_event_id = ?").get(gcalEventId);
  return (row as StoredICSEvent) ?? null;
}

export function incrementICSSequence(gcalEventId: string, title?: string): number {
  if (title) {
    db.prepare(
      "UPDATE ics_events SET sequence = sequence + 1, title = ? WHERE gcal_event_id = ?",
    ).run(title, gcalEventId);
  } else {
    db.prepare("UPDATE ics_events SET sequence = sequence + 1 WHERE gcal_event_id = ?").run(
      gcalEventId,
    );
  }
  const row = db
    .prepare("SELECT sequence FROM ics_events WHERE gcal_event_id = ?")
    .get(gcalEventId) as { sequence: number } | undefined;
  return row?.sequence ?? 0;
}

export function removeICSEvent(gcalEventId: string): StoredICSEvent | null {
  const row = getICSEvent(gcalEventId);
  if (row) {
    db.prepare("DELETE FROM ics_events WHERE gcal_event_id = ?").run(gcalEventId);
  }
  return row;
}
