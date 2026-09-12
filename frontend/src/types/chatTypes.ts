import type { SourceRef, SourcesProvenance } from "./sourceTypes";

export interface ChatSession {
  id: string;
  repository_id: string;
  session_type: "QA" | "REVIEW" | "INTERVIEW";
  created_at: string;
}

export interface ChatMessage {
  id?: string;
  session_id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
  /** Q&A only — context the model was given for this answer. */
  sources?: SourceRef[];
  sourcesProvenance?: SourcesProvenance | null;
}