import { NiadraValidationError } from "./errors.js";
import { toObjectRef } from "./handles.js";
import type { ObjectRef } from "./types/common.js";

/** Paging of `objectTimeline()`. */
export interface ObjectTimelineParams {
  /** `next_cursor` from the previous page. */
  cursor?: string;
  /** Between 1 and 100. Defaults to 20. */
  limit?: number;
}

/**
 * `/v1/objects/{type}/{namespace}/{id}` for an object reference. The segments are system record
 * ids, never personal data, so they may go in the path. A slash cannot: the server's route would
 * split on it, even percent-encoded.
 */
export function objectPath(object: ObjectRef | string): string {
  const ref = toObjectRef(object);
  const segments = [ref.type, ref.namespace, ref.id];
  if (segments.some((segment) => !segment || segment.includes("/"))) {
    throw new NiadraValidationError("object type, namespace and id must be non-empty and cannot contain a slash");
  }
  return `/v1/objects/${segments.map(encodeURIComponent).join("/")}`;
}
