import fs from 'node:fs';
import path from 'node:path';


export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}


export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}


export class SessionManager {
  private sessionsDir: string;
  private currentSession: Session;


  constructor() {
    this.sessionsDir = path.join(process.cwd(), '.m38', 'sessions');
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true });
    }

    const all = this.getAllSessions();
    if (all.length > 0) {
      this.currentSession = all[0]!;
    } else {
      this.currentSession = this.createNewSession('Session 1');
    }
  }


  public getAllSessions(): Session[] {
    try {
      if (!fs.existsSync(this.sessionsDir)) return [];
      const files = fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json'));
      const sessions: Session[] = [];

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(this.sessionsDir, file), 'utf-8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.id) {
            sessions.push(parsed);
          }
        } catch {
          // ignore corrupted files
        }
      }

      return sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch {
      return [];
    }
  }


  public getCurrentSession(): Session {
    return this.currentSession;
  }


  public createNewSession(title?: string): Session {
    const id = `session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const session: Session = {
      id,
      title: title || 'New Session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: []
    };

    this.currentSession = session;
    this.persist(session);
    return session;
  }


  public setActiveSession(id: string): boolean {
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        this.currentSession = JSON.parse(raw);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }


  public deleteSession(id: string): void {
    const filePath = path.join(this.sessionsDir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    const remaining = this.getAllSessions();
    if (remaining.length > 0) {
      this.currentSession = remaining[0]!;
    } else {
      this.createNewSession('Session 1');
    }
  }


  public addMessage(role: 'user' | 'assistant' | 'system', content: string): void {
    if (!this.currentSession) {
      this.createNewSession();
    }

    if (role === 'user' && this.currentSession.messages.length === 0) {
      this.currentSession.title = content.trim().slice(0, 30) || 'Chat Session';
    }

    this.currentSession.messages.push({
      role,
      content,
      timestamp: Date.now()
    });

    this.currentSession.updatedAt = Date.now();
    this.persist(this.currentSession);
  }


  private persist(session: Session): void {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }
      const filePath = path.join(this.sessionsDir, `${session.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to save session to disk:', err);
    }
  }
}


export const sessionManager = new SessionManager();
