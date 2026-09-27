# Context Pack schema

`context-pack.v1.json` is a copy of the Context Pack schema of the Niadra open specifications
(JSON Schema 2020-12), and `examples/context-pack-v1-turn-as-data.json` its example of the answer
to a turn, with the turn's slots, as data. `test/spec.test.ts` keeps the SDK's `ContextPack`,
`PackSection`, `PackStamp`, `PackSlot` and `PackGuard` types equal to the schema, field by field, and
reads the example. When the specification changes, copy the files again and run the tests.
