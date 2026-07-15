# ADR 0001: Integrate Pi as an ACP-backed provider

## Status

Accepted

## Context

T3 Code needs a provider for the Pi coding agent.

Pi can be embedded through multiple surfaces:

- Pi's native SDK
- Pi's native RPC mode
- A community ACP adapter such as `svkozak/pi-acp`

The intended Pi setup also includes `pi-mcp-adapter`, which exposes MCP-backed tools inside Pi itself.

T3 Code already has an ACP-oriented provider path used by Cursor, including a reusable ACP session runtime and adapter support.

## Decision

T3 Code will integrate Pi as an ACP-backed provider.

The Pi provider will spawn `pi-acp` and communicate with it through ACP. T3 Code will not model Pi's native RPC protocol or Pi's MCP configuration directly in the first implementation.

MCP support for Pi will be treated as Pi-internal behavior provided by the user's Pi environment, including `pi-mcp-adapter`.

### Initial Capability Boundary

The first Pi provider will ship with a deliberately small capability set:

- Start and resume sessions.
- Send turns and stream assistant and tool events.
- Interrupt active turns and stop sessions.
- Select a model when the ACP implementation exposes model selection.

Capabilities that cannot be represented faithfully through `pi-acp` will fail explicitly rather than being simulated. Direct T3-managed MCP passthrough is outside the initial scope.

The MVP will handle ACP interaction requests according to their semantics. A Pi extension `confirm` request becomes a T3 approval even though the provider runs in full-access mode. A Pi extension `select` request becomes structured user input and always displays its choices, so T3 can return the selected `choice-N` option without guessing. These extension interactions are not a standard-mode tool safety boundary. Pi extension `input` and `editor` interactions remain unsupported because the adapter currently cancels them before the ACP client can respond; T3 Code will preserve the explanatory assistant message emitted by the adapter.

Session resume will use ACP `session/load`, allowing `pi-acp` to restore Pi's persisted session and replay its messages. Conversation rollback will return an explicit unsupported error in the MVP: the adapter exposes no native truncate, fork, or revert operation, and a local-only rollback would be misleading because removed turns would reappear from Pi's native history after resume.

Pi will implement the required `TextGenerationShape` using short-lived, isolated ACP sessions. Pi-backed model selections will therefore support commit messages, pull request content, branch names, and thread titles in the MVP.

The implementation will extract a narrow provider-neutral ACP structured-output flow from the existing Cursor integration. Session startup, streamed output collection, timeout handling, JSON decoding, and cleanup will be shared. Process arguments, authentication, model mapping, capability handling, and provider-specific errors will remain behind each provider's ACP bridge.

This integration targets the project's own deployment rather than a general third-party provider plugin system. The design will favor a small, explicit Pi driver and settings surface over extensibility that is not currently needed.

`pi-acp` and Pi are externally installed prerequisites, consistent with T3 Code's other CLI-backed providers. T3 Code will discover and launch `pi-acp` from `PATH` by default, permit an executable-path override, and report the provider as unavailable with an actionable diagnostic when launch or initialization fails. T3 Code will not install, update, or own the lifecycle of either external package.

The built-in Pi provider will be enabled by default. On startup, T3 Code will synthesize its default provider instance and probe the external ACP adapter, matching the plug-in-and-go lifecycle used by Codex, Claude, and OpenCode. A missing or unconfigured installation remains visible as unavailable rather than requiring an enablement step.

Pi's settings schema will remain minimal: a hidden `enabled` field defaulting to `true`, a `binaryPath` field defaulting to `pi-acp`, and a `piBinaryPath` field defaulting to `pi`. T3 Code will pass the latter to the adapter as `PI_ACP_PI_COMMAND`. Models and thinking levels will be discovered from Pi's ACP session configuration instead of being duplicated in static settings.

`pi-acp` currently starts Pi RPC without an ephemeral-session option, so ACP sessions used for model discovery and text generation may be recorded in Pi's native session history. The MVP accepts this upstream limitation but will minimize it: discovered models are cached for the provider/config lifetime, periodic snapshot refreshes do not create new ACP probes, and text-generation sessions are created only when requested. T3 Code can adopt an ephemeral option later if the adapter exposes one.

Discovery is project-independent: each Pi provider instance runs one eager ACP discovery probe for its configuration. The probe runs in the server's global provider working context, verifies adapter startup and usable Pi authentication, and captures the advertised `model` and `thought_level` options. Its result, including failure, is cached for the instance/configuration lifetime so projects, threads, and periodic or manual snapshot refreshes do not create hidden Pi sessions.

A failed discovery probe marks that Pi instance unavailable with its actionable diagnostic. Recovery requires reconstructing the provider instance by changing its executable configuration or restarting the server; either action starts one new eager probe. Re-saving unchanged settings or refreshing the snapshot only republishes the cached result and does not retry discovery.

The ACP-backed Pi MVP is full-access-only. `pi-acp` reports tool lifecycle events but does not gate ordinary Pi shell or file tools before execution, so T3 Code cannot truthfully offer its standard approval mode. The UI will disable that runtime-safety choice for Pi and explain that Pi executes tools under its own configuration. Extension-originated `confirm` and `select` interactions are still handled as described above, but they do not constitute a general tool-approval boundary.

T3 Code's plan interaction mode will be disabled for Pi because `pi-acp` does not advertise a distinct planning mode or implement T3's plan/implement semantics. Pi's ACP `thought_level` option remains available as model configuration and must not be presented as equivalent to plan mode.

The Pi provider will carry an `Early Access` badge while the full-access-only safety model, unsupported rollback, persisted utility sessions, and upstream extension-input limitations remain. The provider is still enabled by default; the badge communicates maturity rather than acting as a feature gate.

Release verification will include deterministic protocol/provider/UI coverage and one live local ACP conversation that returns a fixed marker. The live smoke test is allowed to consume a small amount of provider usage and persist a Pi test session.

## Related Implementations

- [`pingdotgg/t3code#2748`](https://github.com/pingdotgg/t3code/pull/2748) validates a Pi-over-ACP implementation and highlights packaged-app PATH handling, `PI_ACP_PI_COMMAND`, update-notice filtering, setup diagnostics, and the need to share ACP adapter/text-generation machinery rather than duplicate it.
- [`pingdotgg/t3code#3818`](https://github.com/pingdotgg/t3code/pull/3818) demonstrates the larger native-RPC alternative, including true fork-based rollback and a bundled default-deny approval extension. Those capabilities are useful references but do not justify adding a second Pi protocol stack to this deployment's MVP.
- [`pingdotgg/t3code#2800`](https://github.com/pingdotgg/t3code/pull/2800) provides UI and contract groundwork but is not a complete runtime integration.

## Consequences

### Positive

- Reuses T3 Code's existing ACP runtime and reduces implementation scope.
- Keeps Pi-specific protocol details behind a single provider seam.
- Avoids duplicating MCP wiring that Pi already manages.
- Keeps the MVP small while preserving room to add capabilities after the ACP path is proven reliable.

### Negative

- T3 Code depends on the behavior and completeness of `pi-acp`.
- ACP features not implemented by `pi-acp` or Pi will need graceful degradation in the provider.
- T3 Code will not have first-class control over Pi's MCP lifecycle in the initial design.

### Follow-up

- Implement the provider in the tracer-bullet sequence documented in [`docs/providers/pi.md`](../providers/pi.md).
- Revisit rollback, ephemeral utility sessions, standard tool approvals, and extension input when `pi-acp` adds the necessary protocol surfaces.
