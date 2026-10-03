# Specification copies

The SDK keeps copies of what it implements from the Niadra specifications and the server's API, and
tests itself against them. `scripts/sync-spec.ts` refreshes the generated part (Node 22.6 or later):
Niadra's maintainers run it against the server and the specifications, and the copies here are what the
SDK is tested against.

## Context Pack schema

`context-pack.v1.json` is a copy of the Context Pack schema of the Niadra specifications
(JSON Schema 2020-12): the answer to a read, with the pack as data and the blocks a read asks for by
`include` (constraints, state, coordination and budget). `examples/context-pack/` holds its examples, among
them the answer to a turn with the turn's slots, as data (`turn-as-data.json`). `test/spec.test.ts` keeps
`ContextResponse`, each block's type and the pack types (`ContextPack`, `PackSection`, `PackStamp`,
`PackSlot`, `PackGuard`) equal to the schema, field by field, and reads the example.

## The routes of turn records, typed state, signals and coordination

`openapi/cell.json` is the part of the server's OpenAPI document with these routes and every schema they
reach. The script generates the types (`src/types/turns.ts`, `state.ts`, `signals.ts`, `coordination.ts`)
and the route methods (`src/api.ts`) from it, and `test/generated.test.ts` fails when a generated file
differs from what the script writes.

`examples/turn-record/` holds the Turn Record spec's examples; the tests read each as a `TurnRecord`.

## Conformance vectors

`vectors/<name>.<version>.json` are the conformance vectors of the specifications, which the server and
both SDKs run alike, and `examples/claim-contract/` the claim contract examples with their negative
corpus. `test/vectors.test.ts` lists every file the SDK runs. A missing file, an unexpected file or an
unknown case field fails.
