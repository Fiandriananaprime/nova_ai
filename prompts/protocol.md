# Protocol `nova-agent/1`

Every model response is one JSON object, validated by Zod before the orchestration layer uses it.

While a response is being prepared, Nova may append a new user steering instruction to the current task. Re-evaluate the answer using that guidance before returning a final status. Steering does not change the JSON schema and is not file content.

```json
{
  "protocol": "nova-agent/1",
  "status": "NEED_FILES | FILE_RECEIVED | TRANSFER_STOP | NEED_INFO | RUN_COMMAND | PATCH_READY | DONE",
  "reason": "optional explanation",
  "files": ["src/module/file.ts"],
  "receivedFile": "src/module/file.ts",
  "chunkIndex": 1,
  "transferReason": "optional reason for stopping a transfer early",
  "question": "one question for the user",
  "command": "one local command to request",
  "commandReason": "why this command is needed",
  "summary": "what the proposed change accomplishes",
  "patch": "a complete unified git patch",
  "tests": ["npm test"]
}
```

Only fields required by the selected status should be present. The object rejects unknown fields. `NEED_FILES` requires a nonempty `files` array; `FILE_RECEIVED` requires `receivedFile` and a positive `chunkIndex`; `NEED_INFO` requires `question`; `PATCH_READY` requires `summary` and `patch`. Paths are relative to the project root. The local engine still enforces size limits, exclusions, path boundaries, file hashes, and patch applicability.

## Statuses

- `NEED_FILES`: the engine normalizes paths, checks permissions and ignore rules, reads only the allowed files, computes SHA-256, and sends only new/changed content.
- `FILE_RECEIVED`: acknowledge exactly the path and chunk index in the current delivery. Nova sends at most 300 lines and 12 KiB per chunk and waits for this acknowledgment before sending another chunk.
- `TRANSFER_STOP`: stop an active file or command-output transfer when the parts already received are sufficient. Include the exact current `receivedFile` and `chunkIndex`, plus an optional short `transferReason`. Nova cancels the remaining chunks and queued files, then asks you to continue. Never imply that you saw portions that were not sent; request a specific continuation with `NEED_FILES` if needed.
- `NEED_INFO`: the engine pauses for user input and persists the answer locally.
- `RUN_COMMAND`: request one local command and a reason. Nova displays the exact command, working directory and reason, then requires `approve` or `rejected`; `approve command` grants command approval for the rest of that session. Short results are returned inline. Long results are saved under `.nova_agents/output` and sent one acknowledged chunk at a time; use `TRANSFER_STOP` as soon as enough output has arrived.
- `PATCH_READY`: the engine validates and stores the diff, previews it, and awaits confirmation. It never interprets model output as permission to write.
- `DONE`: the model believes no further patch is needed.

One fenced JSON code block is tolerated when a web interface adds Markdown fences. Leading/trailing prose, invalid JSON, unknown states, truncated output, binary diffs, unsupported renames, and invalid patches are rejected. A repeated file request with no changed input is treated as a loop.
