# Pi

Pi is an Early Access coding-agent provider backed by [`svkozak/pi-acp`](https://github.com/svkozak/pi-acp). T3 Code communicates only through ACP; Pi's native RPC protocol, extensions, skills, and MCP integration remain owned by the user's Pi environment.

For installation, authentication, safety guidance, and user-visible limitations, see [Use Pi with T3 Code](../user/pi.md).

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

## Supported behavior

- Start and resume sessions.
- Stream assistant, reasoning, and tool lifecycle events.
- Send and interrupt turns.
- Select models and thinking levels.
- Generate thread titles, branch names, commit messages, and pull request content through isolated ACP sessions.
- Map Pi extension confirmations to T3 approvals without presenting them as standard-mode tool gating.
- Map Pi extension selection menus to T3 structured user input.
- Keep Pi-managed extensions, skills, and MCP tools available through the inherited Pi environment.

## Implementation constraints

- Pi is full-access-only. `pi-acp` does not gate ordinary Pi shell or file tools before execution, so T3 Code cannot enforce standard per-tool approval mode.
- T3 plan mode is disabled. Pi thinking levels are model options, not planning modes.
- Conversation rollback is unsupported because ACP exposes no native Pi history truncate, fork, or revert operation.
- Pi extension `input` and `editor` interactions are cancelled by the current `pi-acp` implementation before T3 can answer them.
- Utility ACP sessions may appear in Pi's session history because `pi-acp` does not currently expose an ephemeral-session option.
- T3 Code does not pass MCP server definitions to Pi. Configure MCP through `pi-mcp-adapter` in Pi itself.

## Verification

Deterministic coverage must include startup, resume, streaming, interruption, model/thinking selection, confirmations, multi-choice input, unsupported rollback, process exits, output sanitization, discovery/auth states, settings, model-picker visibility, full-access-only messaging, and disabled plan mode.

Use focused `vp` commands from the repository root rather than the full workspace suite. For example:

```sh
vp test run apps/server/src/provider/Layers/PiProvider.test.ts
vp test run apps/server/src/provider/Layers/PiAdapter.test.ts
vp test run apps/server/src/provider/acp/PiAcpSupport.test.ts
vp test run apps/server/src/provider/Layers/ProviderRegistry.test.ts
vp run --filter t3 typecheck
```

The opt-in live test starts the real ACP runtime, verifies model discovery, sends `Reply with exactly PI_E2E_OK and nothing else.`, and requires the trimmed assistant response to equal `PI_E2E_OK`:

```sh
T3_PI_ACP_PROBE=1 \
T3_PI_ACP_BINARY=/path/to/pi-acp \
T3_PI_BINARY=/path/to/pi \
vp test run apps/server/src/provider/acp/PiAcpCliProbe.test.ts
```

`T3_PI_ACP_BINARY` defaults to `pi-acp` and `T3_PI_BINARY` defaults to `pi`. Authenticate through `pi` first. This test consumes provider usage and may persist a native Pi session.

## References

- [Pi user guide](../user/pi.md)
- [ADR 0001: Integrate Pi as an ACP-backed provider](../adr/0001-pi-provider-via-acp.md)
- [T3 Code PR #2748: ACP-backed Pi and Hermes providers](https://github.com/pingdotgg/t3code/pull/2748)
- [T3 Code PR #3818: Native-RPC Pi provider](https://github.com/pingdotgg/t3code/pull/3818)
