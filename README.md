# codex-provider-manager (cpm)

A tiny cross-platform CLI (macOS + Windows) for managing Codex model-provider
configs in `~/.codex/config.toml` and the matching API-key environment
variables. Lets you add, switch, and remove providers (OpenRouter, DeepSeek,
OpenAI, Ollama, etc.) without hand-editing TOML or your shell rc files.

API keys are **never** written into `config.toml` — Codex's `env_key` field only
stores the *name* of an environment variable; the secret itself goes into your
shell profile (`~/.zshrc` on macOS, `setx` on Windows).

## Install

```bash
cd ai-provider-switcher
npm install
npm link   # optional: makes `cpm` available globally
```

Then run either `node index.js <command>` or, after `npm link`, just `cpm <command>`.

## Commands

| Command | Description |
| --- | --- |
| `cpm` or `cpm add` | Interactively add a provider — pick a preset (HuoShan, OpenCode Go) or fill in manually. |
| `cpm list` | List all providers, mark the active default, and show whether each API-key env var is set. |
| `cpm use [provider] [model]` | Switch the default provider/model. Without args it opens a picker. |
| `cpm remove [provider]` | Remove a provider from config (env var is left untouched). |
| `cpm env` | Show which API-key env vars are set in the current shell. |
| `cpm backup` | Create a timestamped backup of `config.toml`. |
| `cpm restore` | Restore `config.toml` from a previous backup. |
| `cpm help` | Show usage. |

## Provider presets

Both the CLI and the desktop app include built-in presets that pre-fill the
correct base URL, model, env var name, and wire API for known providers:

| Preset | Base URL | Wire API | Env Var |
| --- | --- | --- | --- |
| HuoShan GLM 5.2 | `https://ark.cn-beijing.volces.com/api/coding/v3` | `responses` | `HUOSHAN_API_KEY` |
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `chat` | `OPENCODE_GO_API_KEY` |

Pick a preset and all fields fill in automatically — you just enter your API
key. You can still edit any field after selecting a preset.

> **Important:** OpenCode Go uses the **Chat Completions** wire API, not the
> Responses API. The preset handles this for you. If you add OpenCode Go
> manually, make sure to select "Chat Completions" — otherwise Codex will hit
> a 404.

## Example: add OpenRouter

```bash
cpm add
# Provider ID: openrouter
# Provider display name: OpenRouter
# Base URL: https://openrouter.ai/api/v1
# Default model: anthropic/claude-sonnet-4
# Env var name: OPENROUTER_API_KEY
# API key: sk-or-v1-...
# Wire API: Responses API
# Set as default? y
```

This writes:

```toml
model_provider = "openrouter"
model = "anthropic/claude-sonnet-4"

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
wire_api = "responses"
```

…plus `export OPENROUTER_API_KEY="sk-or-v1-..."` into `~/.zshrc`.

## Example: switch models later

```bash
cpm use deepseek deepseek-chat
cpm use openrouter anthropic/claude-sonnet-4
```

## Notes

- **Wire API:** Codex now expects the Responses API (`wire_api = "responses"`).
  Providers that only support `/v1/chat/completions` may not work; choose `chat`
  only if you know your provider needs it.
- **Windows:** `setx` only affects *new* processes — close and reopen Codex /
  your terminal after setting a key.
- **macOS:** after `cpm add`, run `source ~/.zshrc` (or open a new terminal) so
  the key is available, then restart Codex Desktop.
- Every write creates a timestamped `config.toml.bak.*` backup in `~/.codex`.
