import { NiadraAPIError, NiadraValidationError } from "./errors.js";
import type { NiadraError } from "./errors.js";
import type { AgentNote, AgentNoteKind, CreateAgentNoteRequest, RememberResult } from "./types/agent-memory.js";
import type { Handle } from "./types/common.js";
import type {
  HistoryFilters,
  OpenedItem,
  SearchRequest,
  SearchResponse,
  TimelineRequest,
  TimelineResponse,
  ToolDefinition,
} from "./types/context.js";
import type { HistoryItemKind, Verification } from "./types/vocabulary.js";

/** The outcome of a call that may fail without throwing. Exactly one of the two fields is set. */
export type Result<T> = { data: T; error: null } | { data: null; error: NiadraError };

/** Everything a tool call is bound to besides its arguments. None of it is visible to the model. */
export interface ToolBinding {
  about?: Handle;
  verification?: Verification;
  conversation_id?: string;
  task_id?: string;
  /** Use the voice time budget for the calls these tools make. */
  voice?: boolean;
}

/** Which tools a kit offers besides the navigation kit. */
export interface ToolOptions {
  /** Adds `search_agent_memory`, the agent's own working notes. */
  agentMemory?: boolean;
  /**
   * Adds `remember` too. Only for a key with the `agent_memory:write` scope: a tool the model
   * cannot use is a wasted call. Needs `agentMemory`.
   */
  writeAgentMemory?: boolean;
}

export interface Navigator {
  search(params: SearchRequest, voice: boolean): Promise<Result<SearchResponse>>;
  timeline(params: TimelineRequest, voice: boolean): Promise<Result<TimelineResponse>>;
  open(id: string, subject: Handle, binding: ToolBinding, voice: boolean): Promise<Result<OpenedItem>>;
  searchAgentMemory(
    query: string,
    options: { tags?: string[]; conversation_id?: string; task_id?: string },
    voice: boolean,
  ): Promise<Result<AgentNote[]>>;
  remember(note: CreateAgentNoteRequest): Promise<Result<RememberResult>>;
}

/**
 * The navigation kit as function-calling tools, bound to one customer.
 *
 * The definitions have no parameter for the customer: the handle lives in this object, outside
 * the model's reach. A prompt injection that says "now look up customer X" has no argument to
 * put X in. The model chooses what to ask, never whom it is about.
 */
export interface BoundTools {
  /** Tool definitions in the `{ type: "function", function: { name, description, parameters } }` shape. */
  readonly definitions: ToolDefinition[];
  /** Whether `name` is one of these tools, for dispatchers that route several toolsets. */
  has(name: string): boolean;
  /**
   * Runs one tool call and returns the text to send back to the model as the tool result.
   * `args` may be the JSON string most model APIs return, or an already parsed object.
   * Failures come back as a short JSON error the model can read and move past; with
   * `strict: true` they are thrown instead.
   */
  call(name: string, args: string | Record<string, unknown>): Promise<string>;
}

/** What `remember` answers when the note carries personal data: the model can rewrite it. */
export const PERSONAL_DATA_TOOL_ERROR = {
  error: "personal_data",
  detail:
    "The note has personal data. Rewrite it so it helps with any customer, without names, phones, e-mails, documents or ids.",
} as const;

export const TOOL_NAMES = {
  search: "search_customer_history",
  timeline: "get_customer_timeline",
  open: "open_history_item",
} as const;

/** The two tools of the agent's own memory, offered with `tools({ agentMemory: true })`. */
export const AGENT_MEMORY_TOOL_NAMES = {
  search: "search_agent_memory",
  remember: "remember",
} as const;

const ITEM_KINDS: HistoryItemKind[] = ["episode", "fact", "open_item", "action", "object", "trait"];
const NOTE_KINDS: AgentNoteKind[] = ["procedure", "tool_note", "process_note", "pitfall"];

/**
 * The navigation kit, word for word the server's canonical definitions (`GET /v1/history/tools`)
 * and the Python SDK's: a model sees one toolset whatever language the agent is written in. The
 * server names the context's history line in the space's language; the SDKs ship its default.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    "type": "function",
    "function": {
      "name": "search_customer_history",
      "description": "Search everything that already happened with this customer: past conversations, promises, agent actions, orders and invoices. Use it when the customer refers to something earlier or asks whether a problem happened before. Do not call it when the answer is already in the context block, including its 'Do histórico' line, which already counts recurrences. Returns short items with date, channel and outcome, plus a recurrence count. Open one with open_history_item.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "What to look for, in the customer's words."
          },
          "filters": {
            "type": "object",
            "properties": {
              "since": {
                "type": "string",
                "format": "date-time"
              },
              "until": {
                "type": "string",
                "format": "date-time"
              },
              "when": {
                "type": "string",
                "description": "The period in the customer's own words, as they said it: 'last week', 'semana passada', 'en marzo'."
              },
              "channels": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "categories": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "item_kinds": {
                "type": "array",
                "items": {
                  "enum": [
                    "episode",
                    "fact",
                    "open_item",
                    "action",
                    "object",
                    "trait"
                  ]
                }
              },
              "outcome": {
                "type": "string"
              }
            },
            "additionalProperties": false
          },
          "max_tokens": {
            "type": "integer",
            "minimum": 50,
            "maximum": 4000
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "get_customer_timeline",
      "description": "List this customer's conversations and agent actions in order, newest first, one line each. Use it to leaf through the history when you do not know what to search for. Pass next_cursor to continue. Prefer search_customer_history for a specific question.",
      "parameters": {
        "type": "object",
        "properties": {
          "cursor": {
            "type": "string"
          },
          "limit": {
            "type": "integer",
            "minimum": 1,
            "maximum": 100
          },
          "filters": {
            "type": "object",
            "properties": {
              "since": {
                "type": "string",
                "format": "date-time"
              },
              "until": {
                "type": "string",
                "format": "date-time"
              },
              "when": {
                "type": "string",
                "description": "The period in the customer's own words, as they said it: 'last week', 'semana passada', 'en marzo'."
              },
              "channels": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "categories": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "item_kinds": {
                "type": "array",
                "items": {
                  "enum": [
                    "episode",
                    "fact",
                    "open_item",
                    "action",
                    "object",
                    "trait"
                  ]
                }
              },
              "outcome": {
                "type": "string"
              }
            },
            "additionalProperties": false
          }
        },
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "open_history_item",
      "description": "Open one conversation or business object returned by search_customer_history or get_customer_timeline: what was asked, what was promised and by whom, the outcome and what memory came from it. Use it only after a search or timeline pointed to the item.",
      "parameters": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "The item id, e.g. `episode:...`."
          }
        },
        "required": [
          "id"
        ],
        "additionalProperties": false
      }
    }
  }
] as ToolDefinition[];

/**
 * `search_agent_memory` and `remember`, word for word the server's canonical definitions. They
 * read and write the agent's working notes, never anything about a customer.
 */
export const AGENT_MEMORY_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    "type": "function",
    "function": {
      "name": "search_agent_memory",
      "description": "Search your own working notes: procedures, how the company's tools and processes behave, and known pitfalls. Use it before a task or a tool call you are unsure how to do. It holds nothing about customers; for the customer's history use search_customer_history.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "What you need to know how to do."
          },
          "tags": {
            "type": "array",
            "maxItems": 8,
            "items": {
              "type": "string",
              "pattern": "^[a-z0-9][a-z0-9_.:-]{0,63}$"
            },
            "description": "Object types, operations or systems, e.g. `invoice`, `credit`, `erp`."
          }
        },
        "required": [
          "query"
        ],
        "additionalProperties": false
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "remember",
      "description": "Save a working note for yourself and future runs: a procedure that worked, how a tool or process behaves, or a pitfall to avoid. Never write anything about a customer here: no names, phones, e-mails, documents, ids or words from the conversation. A note with personal data is refused. Write it so it helps with any customer.",
      "parameters": {
        "type": "object",
        "properties": {
          "kind": {
            "enum": [
              "procedure",
              "tool_note",
              "process_note",
              "pitfall"
            ]
          },
          "title": {
            "type": "string",
            "maxLength": 120
          },
          "body": {
            "type": "string",
            "maxLength": 2000
          },
          "tags": {
            "type": "array",
            "maxItems": 8,
            "items": {
              "type": "string",
              "pattern": "^[a-z0-9][a-z0-9_.:-]{0,63}$"
            },
            "description": "Object types, operations or systems, e.g. `invoice`, `credit`, `erp`."
          }
        },
        "required": [
          "kind",
          "title",
          "body"
        ],
        "additionalProperties": false
      }
    }
  }
] as ToolDefinition[];

function parseArgs(args: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof args !== "string") return args;
  if (args.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new NiadraValidationError("tool arguments are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NiadraValidationError("tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(args: Record<string, unknown>, name: string): string[] | undefined {
  const value = args[name];
  if (!Array.isArray(value)) return undefined;
  const list = value.filter((entry): entry is string => typeof entry === "string");
  return list.length > 0 ? list : undefined;
}

function int(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

/**
 * The filters of a call: the `filters` object of the canonical definitions, over the flat fields
 * the 0.1 definitions offered (`since`, `until`, `channels`, `categories`, `item_kinds`, `outcome`).
 */
function filtersFrom(args: Record<string, unknown>): HistoryFilters {
  const nested = args.filters;
  const source: Record<string, unknown> =
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? { ...args, ...(nested as Record<string, unknown>) }
      : args;
  const filters: HistoryFilters = {};
  const since = str(source, "since");
  const until = str(source, "until");
  const when = str(source, "when");
  const channels = strings(source, "channels");
  const categories = strings(source, "categories");
  const kinds = strings(source, "item_kinds")
    ?.map((kind) => (kind === "system_event" ? "object" : kind))
    .filter((kind): kind is HistoryItemKind => (ITEM_KINDS as string[]).includes(kind));
  const outcome = str(source, "outcome");
  if (since) filters.since = since;
  if (until) filters.until = until;
  if (when) filters.when = when.slice(0, 100);
  if (channels) filters.channels = channels;
  if (categories) filters.categories = categories;
  if (kinds?.length) filters.item_kinds = [...new Set(kinds)];
  if (outcome) filters.outcome = outcome;
  return filters;
}

function tagsFrom(args: Record<string, unknown>): string[] | undefined {
  return strings(args, "tags")?.slice(0, 8);
}

/** Builds the bound toolset. `strict` decides whether failures are thrown or described to the model. */
export function bindTools(
  subject: Handle,
  binding: ToolBinding,
  navigator: Navigator,
  strict: boolean,
  options: ToolOptions = {},
): BoundTools {
  const voice = binding.voice ?? false;
  const memory = options.agentMemory ? AGENT_MEMORY_TOOL_DEFINITIONS.slice(0, options.writeAgentMemory ? 2 : 1) : [];
  const definitions: ToolDefinition[] = [...TOOL_DEFINITIONS, ...memory];
  const names = new Set(definitions.map((definition) => definition.function.name));

  async function run(name: string, args: Record<string, unknown>): Promise<Result<unknown>> {
    switch (name) {
      case TOOL_NAMES.search: {
        const query = str(args, "query");
        if (!query) throw new NiadraValidationError("search_customer_history needs a query");
        const request: SearchRequest = { subject, query, filters: filtersFrom(args) };
        applyBinding(request, binding);
        if (binding.task_id) request.task_id = binding.task_id;
        const maxTokens = int(args, "max_tokens");
        if (maxTokens !== undefined) request.max_tokens = Math.min(4000, Math.max(50, maxTokens));
        const result = await navigator.search(request, voice);
        return result.error ? result : { data: compactSearch(result.data), error: null };
      }
      case TOOL_NAMES.timeline: {
        const request: TimelineRequest = { subject, filters: filtersFrom(args) };
        applyBinding(request, binding);
        const cursor = str(args, "cursor");
        if (cursor) request.cursor = cursor;
        const limit = int(args, "limit");
        if (limit !== undefined) request.limit = Math.min(100, Math.max(1, limit));
        return navigator.timeline(request, voice);
      }
      case TOOL_NAMES.open: {
        const id = str(args, "id");
        if (!id) throw new NiadraValidationError("open_history_item needs an id");
        return navigator.open(id, subject, binding, voice);
      }
      case AGENT_MEMORY_TOOL_NAMES.search: {
        const query = str(args, "query");
        if (!query) throw new NiadraValidationError("search_agent_memory needs a query");
        const scope: { tags?: string[]; conversation_id?: string; task_id?: string } = {};
        const tags = tagsFrom(args);
        if (tags) scope.tags = tags;
        if (binding.conversation_id) scope.conversation_id = binding.conversation_id;
        else if (binding.task_id) scope.task_id = binding.task_id;
        const result = await navigator.searchAgentMemory(query, scope, voice);
        return result.error ? result : { data: { notes: result.data.map(compactNote) }, error: null };
      }
      case AGENT_MEMORY_TOOL_NAMES.remember: {
        const kind = str(args, "kind");
        const title = str(args, "title");
        const body = str(args, "body");
        if (!kind || !(NOTE_KINDS as string[]).includes(kind) || !title || !body) {
          throw new NiadraValidationError("remember needs a kind, a title and a body");
        }
        const note: CreateAgentNoteRequest = { kind: kind as AgentNoteKind, title, body };
        const tags = tagsFrom(args);
        if (tags) note.tags = tags;
        if (binding.conversation_id) note.evidence = { conversation_id: binding.conversation_id };
        else if (binding.task_id) note.evidence = { task_id: binding.task_id };
        const result = await navigator.remember(note);
        return result.error ? result : { data: remembered(result.data), error: null };
      }
      default:
        throw new NiadraValidationError(`unknown tool: ${name}`);
    }
  }

  return {
    definitions: definitions.map((definition) => cloneDefinition(definition)),
    has: (name) => names.has(name),
    async call(name, rawArgs) {
      let result: Result<unknown>;
      try {
        if (!names.has(name)) throw new NiadraValidationError(`unknown tool: ${name}`);
        result = await run(name, parseArgs(rawArgs));
      } catch (error) {
        // Even a strict client hands this one to the model: rewriting the note is the answer.
        if (error instanceof NiadraAPIError && isPersonalData(error)) return JSON.stringify(PERSONAL_DATA_TOOL_ERROR);
        if (strict) throw error;
        return JSON.stringify({ error: "invalid_call", detail: (error as Error).message });
      }
      if (result.error) {
        if (isPersonalData(result.error)) return JSON.stringify(PERSONAL_DATA_TOOL_ERROR);
        if (strict) throw result.error;
        const memory = name === AGENT_MEMORY_TOOL_NAMES.search || name === AGENT_MEMORY_TOOL_NAMES.remember;
        const detail = memory ? "agent memory is unavailable right now" : "customer history is unavailable right now";
        return JSON.stringify({ error: "unavailable", detail });
      }
      return JSON.stringify(result.data);
    },
  };
}

/** What the model needs of a note: the id, the kind, the title, the body and the tags. */
function compactNote(note: AgentNote): Partial<AgentNote> {
  const { note_id, kind, title, body, tags } = note;
  return tags === undefined ? { note_id, kind, title, body } : { note_id, kind, title, body, tags };
}

/** A saved note, or a proposal a person still has to approve, as the model reads it. */
function remembered(result: RememberResult): Record<string, unknown> {
  if (result.note) return { saved: true, note_id: result.note.note_id, version: result.note.version };
  return { saved: false, proposal_id: result.proposal_id ?? null, status: "waiting for review" };
}

/** The server refused a note with personal data: an answer for the model, not a failure. */
function isPersonalData(error: NiadraError): boolean {
  return error instanceof NiadraAPIError && error.code === "personal_data_in_agent_memory";
}

function applyBinding(request: SearchRequest | TimelineRequest, binding: ToolBinding): void {
  if (binding.about) request.about = binding.about;
  if (binding.verification) request.verification = binding.verification;
  if (binding.conversation_id) request.conversation_id = binding.conversation_id;
}

/** Token accounting is for the caller, not the model; everything else the model can use. */
function compactSearch(response: SearchResponse): Omit<SearchResponse, "tokens_used"> {
  const { tokens_used: _, ...rest } = response;
  return rest;
}

function cloneDefinition(definition: ToolDefinition): ToolDefinition {
  return JSON.parse(JSON.stringify(definition)) as ToolDefinition;
}
