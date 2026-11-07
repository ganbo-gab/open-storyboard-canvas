# Agent stage reliability findings

Read-only production storage inspection (2026-11-07): no values, credentials, user text, session IDs, or project names were output. No production database was changed.

- The current production WebKit localStorage database contains 18 entries totaling 5,106,240 bytes of keys plus values. Relative to a 5 MiB ceiling, this leaves 136,640 bytes. This is strong evidence of storage pressure, not proof that the provider balance is exhausted.
- Agent session data occupies 1,799,782 bytes; run states 437,086 bytes; approvals and recovery 424,562 bytes. Other Agent metadata is small.
- Within 14 saved Agent sessions / 116 history items, history is approximately 393,114 JSON characters while transaction fingerprints repeat approximately 501,527 characters. Fingerprints currently duplicate complete transaction payloads.
- One active approval stores a 160,797-character SDK snapshot twice: run states and approval recovery. Within that snapshot, generated items occupy approximately 131,757 characters and model responses 24,221 characters.
- Today's native log has no matching stage validation, quota, balance, HTTP 429, or HTTP 402 entry. The exact JavaScript exception that stopped this user run is not recoverable from that native log.

Confirmed defects and bounded repairs:

1. A WebKit-shaped QuotaExceededError can lose its name during controller redaction, then lose all type information when the service stores only a message string. The previous broad quota regexp could label that local failure as provider billing exhaustion. The controller now retains a small, redacted failure classification; the service keeps error:string plus failure metadata and clears both for a fresh turn/session. Ambiguous quota, per-minute limits, RESOURCE_EXHAUSTED, schema validation, local budget, and turn limits no longer imply exhausted account balance.
2. Strict tools represent omitted optional fields as null. stage_command is a union of one command and a command array. The decoder previously processed arrays before choosing the array union branch, losing member schemas and failing to remove optional-null values inside batches. Union selection now precedes decoding; null removal remains limited to optional domain properties. Unsupported keys, invalid values, and empty/over-100 batches still fail closed.
3. Invalid union errors could contain thousands of lines and exceed redaction's long-value cap. The validation error now reports a bounded set of exact member paths/types without echoing argument values or every unrelated union branch.
4. New history transactions store SHA-256 identities instead of complete payloads. Existing plaintext identities are recognized, upgraded when replayed, and still reject conflicting reuse. Hashing freezes transaction input and preserves concurrent idempotence.

Validation: 93 tests across seven targeted files pass; TypeScript noEmit passes. These are local SDK/controller/application tests with fixture transport. No real provider request or billable operation was performed. Production storage migration/compression is owned by the main implementation and is separate from this report.
