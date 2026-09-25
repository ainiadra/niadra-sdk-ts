/**
 * The agent's own memory: working notes an agent keeps about its job (procedures, how the
 * company's tools and processes behave, pitfalls), never about customers. `/v1/agent-memory`.
 */

/** `procedure`, `tool_note`, `process_note` or `pitfall`. */
export type AgentNoteKind = "procedure" | "tool_note" | "process_note" | "pitfall";

/** Who reads a note: the agent that wrote it, every agent of its vendor, or every agent of the space. */
export type AgentNoteVisibility = "source" | "vendor" | "space";

export type AgentNoteStatus = "active" | "retired";

/** `agent` wrote it, a person wrote it in the Console, or it was distilled and approved. */
export type AgentNoteOrigin = "agent" | "human" | "distilled";

export type ProposalStatus = "pending" | "approved" | "rejected";

/** Where a note came from: the id of the conversation or task, never its text. */
export interface Evidence {
  conversation_id?: string | null;
  task_id?: string | null;
}

export interface AgentNote {
  note_id: string;
  source_id: string;
  visibility: AgentNoteVisibility;
  kind: AgentNoteKind;
  /** Up to 120 characters. */
  title: string;
  /** Up to 2,000 characters. */
  body: string;
  /** Up to 8. */
  tags?: string[];
  evidence?: Evidence | null;
  origin: AgentNoteOrigin;
  version: number;
  supersedes_note_id?: string | null;
  status: AgentNoteStatus;
  valid_until?: string | null;
  created_at: string;
  created_by: string;
}

/** `GET /v1/agent-memory/block`: the notes as text for the prompt, before the customer's context. */
export interface AgentMemoryBlock {
  text: string;
  /** The ids of the notes in `text`. */
  notes?: string[];
  etag: string;
  tokens?: number;
  /** `false` when agent memory is off for the space. */
  enabled?: boolean;
}

/** Body of `POST /v1/agent-memory/search`. */
export interface AgentMemorySearchRequest {
  query: string;
  tags?: string[];
  /** Defaults to 5. */
  limit?: number;
  conversation_id?: string | null;
  task_id?: string | null;
}

export interface AgentMemorySearchResponse {
  notes: AgentNote[];
}

/** Body of `POST /v1/agent-memory/notes`. */
export interface CreateAgentNoteRequest {
  kind: AgentNoteKind;
  title: string;
  body: string;
  tags?: string[];
  evidence?: Evidence | null;
  /** Defaults to `source`. */
  visibility?: AgentNoteVisibility;
  valid_until?: string | null;
  /** Only for keys that write for another source. */
  source_id?: string | null;
}

/** A note saved, or a proposal waiting for a person to approve it (when the space asks for that). */
export interface RememberResult {
  note?: AgentNote | null;
  proposal_id?: string | null;
}
