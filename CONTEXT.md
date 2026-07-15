# T3 Code

T3 Code coordinates coding agents through a common session experience while preserving each agent's native capabilities and configuration boundaries.

## Language

**Provider**:
A coding-agent integration available to T3 Code, such as Codex, Cursor, or Pi.
_Avoid_: Backend, agent type

**Provider instance**:
A configured occurrence of a provider with its own identity, settings, and lifecycle. Multiple instances may use the same provider.
_Avoid_: Provider configuration, account

**Provider session**:
An active or resumable conversation owned by one provider instance.
_Avoid_: Process, connection

**ACP-backed provider**:
A provider whose sessions are presented to T3 Code through the Agent Client Protocol, regardless of the provider's internal protocol.
_Avoid_: Native ACP agent
