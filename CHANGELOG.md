# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-15

### Added

- Local coding agent with a zero-dependency Node server and a browser UI.
- Bring-your-own-key support for Anthropic, OpenAI, Google Gemini, OpenRouter,
  Ollama, and any OpenAI-compatible endpoint.
- Tools: read_file, write_file, edit_file, list_dir, glob, grep, run_bash.
- Permission gate (deny, ask, allow) enforced by the harness, with a
  catastrophic-command circuit breaker that holds even in auto-approve mode, a
  symlink-aware path sandbox, and an environment scrubbed of secrets before
  shell commands run.
- Animated pixel mascot that acts out the agent's activity: thinking, typing,
  reading, editing, searching, running, debugging, success, and error.
- Streaming responses, live token usage, light and dark themes, and a
  reduced-motion fallback for the mascot.
- Test suite on the built-in `node:test` runner covering the permission gate,
  all three provider families (mocked), the agent loop with approvals, the
  markdown renderer, and the mascot state machine.

[0.1.0]: https://github.com/AnwarDebes/pixie/releases/tag/v0.1.0
