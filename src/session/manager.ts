import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Session, SessionMessage } from "./types.js";

export class SessionManager {
  private dir: string;

  constructor(sessionDir?: string) {
    this.dir = sessionDir ?? join(process.cwd(), "workspace", "sessions");
    mkdirSync(this.dir, { recursive: true });
  }

  create(title?: string): Session {
    const id = `sess_${Date.now()}`;
    const now = new Date().toISOString();
    const session: Session = {
      id,
      title: title ?? "New Session",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.save(session);
    return session;
  }

  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    const filePath = join(this.dir, `${session.id}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2), "utf-8");
  }

  load(id: string): Session | null {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  list(): Session[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    const sessions: Session[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(this.dir, file), "utf-8");
        const parsed = JSON.parse(raw) as Session;
        if (parsed.messages.length > 0) {
          sessions.push(parsed);
        }
      } catch {
        // skip corrupt files
      }
    }
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  delete(id: string): boolean {
    const filePath = join(this.dir, `${id}.json`);
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  }

  discardIfEmpty(session: Session): void {
    if (session.messages.length === 0) {
      this.delete(session.id);
    }
  }

  addMessage(session: Session, message: SessionMessage): void {
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    this.save(session);
  }

  updateTitle(session: Session, title: string): void {
    session.title = title;
    session.updatedAt = new Date().toISOString();
    this.save(session);
  }

  static generateTitle(firstUserMessage: string): string {
    const words = firstUserMessage.replace(/\s+/g, " ").trim().split(" ");
    const slice = words.slice(0, 6).join(" ");
    if (slice.length <= 50) return slice;
    return slice.slice(0, 47) + "...";
  }

  private activeSession: Session | null = null;

  getActiveSession(): Session | null {
    return this.activeSession;
  }

  createNewSession(): Session {
    if (this.activeSession) {
      this.discardIfEmpty(this.activeSession);
    }
    this.activeSession = this.create();
    return this.activeSession;
  }

  setActiveSession(session: Session): void {
    this.activeSession = session;
  }
}

export const sessionManager = new SessionManager();
