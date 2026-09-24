import { NiadraValidationError } from "./errors.js";
import type { NiadraError } from "./errors.js";
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

export interface Navigator {
  search(params: SearchRequest, voice: boolean): Promise<Result<SearchResponse>>;
  timeline(params: TimelineRequest, voice: boolean): Promise<Result<TimelineResponse>>;
  open(id: string, binding: ToolBinding, voice: boolean): Promise<Result<OpenedItem>>;
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

export const TOOL_NAMES = {
  search: "search_customer_history",
  timeline: "get_customer_timeline",
  open: "open_history_item",
} as const;

const ITEM_KINDS: HistoryItemKind[] = ["episode", "fact", "open_item", "action", "object", "trait"];

const period = {
  since: { type: "string", format: "date-time", description: "Only items at or after this ISO 8601 time." },
  until: { type: "string", format: "date-time", description: "Only items before this ISO 8601 time." },
  channels: {
    type: "array",
    items: { type: "string" },
    description: "Only these channels, such as whatsapp, voice, email.",
  },
  item_kinds: {
    type: "array",
    items: { type: "string", enum: ITEM_KINDS },
    description: "Only these kinds of history items.",
  },
};

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: TOOL_NAMES.search,
      description:
        "Search this customer's past conversations, actions and business objects by meaning and keywords. " +
        "Use it when the customer refers to something that happened before and the details are not in the " +
        "customer context you already have. Do not use it for facts already listed there. The result also " +
        "says how often the same kind of issue came back. To read one result in full, call open_history_item.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in the customer's own terms." },
          ...period,
          categories: { type: "array", items: { type: "string" }, description: "Only these topics." },
          outcome: { type: "string", description: "Only items with this outcome, such as resolved." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.timeline,
      description:
        "List this customer's history, newest first, one line per item. Use it when you need " +
        "the sequence of events, for example what happened since a given date. Prefer " +
        "search_customer_history when you are looking for something specific.",
      parameters: {
        type: "object",
        properties: {
          ...period,
          limit: { type: "integer", minimum: 1, maximum: 100, description: "How many items. Defaults to 20." },
          cursor: { type: "string", description: "The next_cursor of a previous page." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: TOOL_NAMES.open,
      description:
        "Open one history item returned by search_customer_history or get_customer_timeline: its summary, " +
        "what was requested, commitments made by either side, the outcome and the resolution. Only use ids " +
        "returned by those tools.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "The item id." } },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

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

function filtersFrom(args: Record<string, unknown>): HistoryFilters {
  const filters: HistoryFilters = {};
  const since = str(args, "since");
  const until = str(args, "until");
  const channels = strings(args, "channels");
  const categories = strings(args, "categories");
  const kinds = strings(args, "item_kinds")?.filter((kind): kind is HistoryItemKind =>
    (ITEM_KINDS as string[]).includes(kind),
  );
  const outcome = str(args, "outcome");
  if (since) filters.since = since;
  if (until) filters.until = until;
  if (channels) filters.channels = channels;
  if (categories) filters.categories = categories;
  if (kinds?.length) filters.item_kinds = kinds;
  if (outcome) filters.outcome = outcome;
  return filters;
}

/** Builds the bound toolset. `strict` decides whether failures are thrown or described to the model. */
export function bindTools(subject: Handle, binding: ToolBinding, navigator: Navigator, strict: boolean): BoundTools {
  const voice = binding.voice ?? false;
  const names = new Set<string>(Object.values(TOOL_NAMES));

  async function run(name: string, args: Record<string, unknown>): Promise<Result<unknown>> {
    switch (name) {
      case TOOL_NAMES.search: {
        const query = str(args, "query");
        if (!query) throw new NiadraValidationError("search_customer_history needs a query");
        const request: SearchRequest = { subject, query, filters: filtersFrom(args) };
        applyBinding(request, binding);
        if (binding.task_id) request.task_id = binding.task_id;
        const result = await navigator.search(request, voice);
        return result.error ? result : { data: compactSearch(result.data), error: null };
      }
      case TOOL_NAMES.timeline: {
        const request: TimelineRequest = { subject, filters: filtersFrom(args) };
        applyBinding(request, binding);
        const cursor = str(args, "cursor");
        if (cursor) request.cursor = cursor;
        const limit = args.limit;
        if (typeof limit === "number" && Number.isInteger(limit)) request.limit = Math.min(100, Math.max(1, limit));
        return navigator.timeline(request, voice);
      }
      case TOOL_NAMES.open: {
        const id = str(args, "id");
        if (!id) throw new NiadraValidationError("open_history_item needs an id");
        return navigator.open(id, binding, voice);
      }
      default:
        throw new NiadraValidationError(`unknown tool: ${name}`);
    }
  }

  return {
    definitions: TOOL_DEFINITIONS.map((definition) => cloneDefinition(definition)),
    has: (name) => names.has(name),
    async call(name, rawArgs) {
      let result: Result<unknown>;
      try {
        result = await run(name, parseArgs(rawArgs));
      } catch (error) {
        if (strict) throw error;
        return JSON.stringify({ error: "invalid_call", detail: (error as Error).message });
      }
      if (result.error) {
        if (strict) throw result.error;
        return JSON.stringify({ error: "unavailable", detail: "customer history is unavailable right now" });
      }
      return JSON.stringify(result.data);
    },
  };
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
