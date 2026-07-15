# Pi

Pi is an Early Access coding-agent provider backed by [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp). T3 Code communicates only through ACP; Pi's native RPC protocol, extensions, skills, and MCP integration remain owned by the user's Pi environment.

## Prerequisites

- Install Pi and configure at least one usable model or authentication provider.
- Install `svkozak/pi-acp` and ensure both `pi` and `pi-acp` are available on the server's `PATH`.
- Configure `pi-mcp-adapter` within Pi when MCP tools are required. T3 Code does not manage those MCP servers for Pi.

The built-in provider is enabled by default. Its settings allow overriding the `pi-acp` and Pi executable paths; the default commands are `pi-acp` and `pi`.

## Runtime Shape

```text
T3 Code
  -> ACP session runtime
  -> pi-acp
  -> pi --mode rpc
  -> Pi extensions, skills, and pi-mcp-adapter
```

Each interactive T3 thread owns a scoped `pi-acp` process. Session continuation stores the native Pi session ID and resumes through ACP `session/load`. Model and thinking-level choices come from the ACP `model` and `thought_level` options.

Each Pi provider instance runs one eager ACP probe in the server's global provider working context. Discovery is not repeated per project or thread. The probe verifies startup and authentication and caches discovered models/options, including failures, until that provider instance's configuration changes or the server restarts. Periodic and manual provider refreshes only republish that cached result and do not create additional ACP sessions.

If discovery fails, that Pi instance remains visible as unavailable with the probe diagnostic. Change an executable-path setting to reconstruct the provider and retry once, or restart the server. Re-saving unchanged settings or refreshing the snapshot does not retry the probe.

## Supported MVP Behavior

- Start and resume sessions.
- Stream assistant, reasoning, and tool lifecycle events.
- Send and interrupt turns.
- Select models and thinking levels.
- Generate thread titles, branch names, commit messages, and pull request content through isolated ACP sessions.
- Map Pi extension confirmations to T3 approvals without presenting them as standard-mode tool gating.
- Map Pi extension selection menus to T3 structured user input.
- Keep Pi-managed extensions, skills, and MCP tools available through the inherited Pi environment.

## Limitations

- Pi is full-access-only. `pi-acp` does not gate ordinary Pi shell or file tools before execution, so T3 Code cannot enforce standard per-tool approval mode.
- T3 plan mode is disabled. Pi thinking levels are model options, not planning modes.
- Conversation rollback is unsupported because ACP exposes no native Pi history truncate, fork, or revert operation.
- Pi extension `input` and `editor` interactions are cancelled by the current `pi-acp` implementation before T3 can answer them.
- Utility ACP sessions may appear in Pi's session history because `pi-acp` does not currently expose an ephemeral-session option.
- T3 Code does not pass MCP server definitions to Pi. Configure MCP through `pi-mcp-adapter` in Pi itself.

## Implementation Sequence

1. Add Pi contracts, settings hydration, provider metadata, icon wiring, and Early Access presentation.
2. Extract the provider-neutral ACP adapter and structured-output behavior currently embedded in Cursor, keeping provider-specific spawn, model mapping, sanitization, and errors behind small bridges.
3. Add Pi ACP process construction, environment handling, model/thinking selection, and update-notice sanitization.
4. Add the Pi provider probe, driver, adapter, session continuation, event mapping, and truthful unsupported operations.
5. Add Pi text generation on the shared ACP structured-output path.
6. Add deterministic server, contracts, and browser tests, then run one live `PI_E2E_OK` smoke conversation.

## Verification

Deterministic coverage must include startup, resume, streaming, interruption, model/thinking selection, confirmations, multi-choice input, unsupported rollback, process exits, output sanitization, discovery/auth states, settings, model-picker visibility, full-access-only messaging, and disabled plan mode.

Before completion, `bun fmt`, `bun lint`, `bun typecheck`, and focused tests through `bun run test` must pass. The live smoke test consumes provider tokens and may leave a Pi test session in native history.

## References

- [ADR 0001: Integrate Pi as an ACP-backed provider](../adr/0001-pi-provider-via-acp.md)
- [T3 Code PR #2748: ACP-backed Pi and Hermes providers](https://github.com/pingdotgg/t3code/pull/2748)
- [T3 Code PR #3818: Native-RPC Pi provider](https://github.com/pingdotgg/t3code/pull/3818)
