# Runtime modes

T3 Code has four runtime modes. A provider may advertise a smaller supported set when it cannot enforce every mode truthfully.

- **Supervised** (`approval-required`): asks before commands and file changes.
- **Auto-accept edits** (`auto-accept-edits`): accepts edits automatically but asks before other actions.
- **Auto** (`auto`): lets the provider's automated reviewer approve routine actions while risky actions still ask.
- **Full access** (`full-access`, default): allows commands and edits without approval prompts.

The contracts package exports the ordered `RUNTIME_MODES` list as the source of truth for providers and clients. Older provider snapshots that omit capabilities, or advertise an empty runtime-mode list, retain access to all four modes for backward compatibility.

## Provider capabilities

Provider snapshots may restrict both runtime and interaction modes. Web and mobile clients filter their controls and normalize stale selections when the selected provider changes. The server remains the final enforcement boundary.

Pi is full-access-only because its ACP adapter does not provide a general approval gate for ordinary tools. Pi also supports only the default interaction mode, so clients omit its Plan controls and `/plan` command while retaining `/default` as an escape from stale Plan state. See the [Pi user guide](../user/pi.md).
