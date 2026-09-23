import type { Handle } from "./common.js";
import type { Verification } from "./vocabulary.js";

/**
 * Body of `POST /v1/subject-tokens`. The token binds one customer to a session so that an MCP
 * connection, or any client you hand it to, can read that customer and no other.
 */
export interface SubjectTokenRequest {
  subject: Handle;
  about?: Handle | null;
  conversation_id?: string | null;
  task_id?: string | null;
  verification?: Verification;
}

/** A signed token valid for 15 minutes. Treat it as a credential: it reads this customer's memory. */
export interface SubjectToken {
  token: string;
  expires_at: string;
}
