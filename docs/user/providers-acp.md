# ACP providers

T3 Code can run an agent that speaks the Agent Client Protocol (ACP) over standard input and output. The generic ACP provider is experimental and complements the first-class Codex, Claude, Cursor, Grok, OpenCode, and Pi integrations.

## Hermes

Install and authenticate Hermes on the machine running the T3 Code server. Then open **Settings → Providers → Add provider instance** and choose **Hermes / Custom ACP**. The default launch configuration is:

- Command: `hermes`
- Arguments: `acp`
- Authentication method: automatic

The command and arguments can be changed for another ACP-compatible agent. T3 Code does not download or install the configured command.

## Current limitations

- Generic ACP sessions currently run in **Full access** mode.
- Plan mode and conversation rollback are unavailable.
- Commit messages, branch names, pull request content, and other utility text generation must use another provider instance.
- Agent-specific extensions may require a dedicated provider profile before T3 Code can present them accurately.

Pi remains a separate provider profile because it needs Pi-specific model options, interaction handling, and output filtering.
