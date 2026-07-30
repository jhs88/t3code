# Use Pi with T3 Code

Pi support is Early Access. T3 Code connects to Pi through `pi-acp`; both executables run on the machine hosting the T3 Code server.

## Install and authenticate

1. Install Pi and run `pi` in a terminal.
2. Configure and authenticate at least one model provider in Pi.
3. Install `pi-acp` and ensure both `pi` and `pi-acp` are on the server's `PATH`.
4. Restart T3 Code. Pi is enabled by default and appears in the provider list.

Custom executable paths can be set in Pi's provider settings. The defaults are `pi-acp` and `pi`.

If Pi is missing, unauthenticated, broken, or has no usable model, T3 Code keeps the provider visible and displays an actionable unavailable diagnostic. After fixing the installation, restart the server or change an executable-path setting to run a new discovery probe.

## Safety and interaction modes

Pi is available only in **Full access** mode. Its ACP adapter reports tool activity but does not ask T3 Code for permission before ordinary shell or file operations. Review Pi's own configuration and use it only in a workspace where full tool access is acceptable.

Plan interaction mode is unavailable for Pi. The composer therefore hides the Plan toggle and `/plan`; `/default` remains available. Switching to Pi automatically changes unsupported runtime and interaction selections to Full access and Default.

Pi extension confirmation and selection prompts can still appear in T3 Code. They are extension interactions, not a general approval boundary for Pi's tools.

## Current limitations

- Conversation rollback is unavailable because ACP exposes no native Pi history truncate, fork, or revert operation.
- Pi extension `input` and `editor` interactions are currently cancelled upstream before T3 Code can answer them.
- Discovery and utility sessions may appear in Pi's native history because `pi-acp` has no ephemeral-session option.
- T3 Code does not send MCP server definitions to Pi. Configure MCP through `pi-mcp-adapter` in Pi itself.

For protocol details and maintainer verification, see the [Pi provider reference](../providers/pi.md).
