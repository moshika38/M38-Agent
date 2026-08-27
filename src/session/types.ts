export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
  pool?: string;
  timestamp: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}
