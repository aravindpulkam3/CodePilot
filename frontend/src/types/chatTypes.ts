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
}

export interface ChatSource {
  file_path: string;
  symbol_type: string;
  symbol_name: string;
  start_line: number;
  end_line: number;
  content: string;
  similarity_score: number;
}