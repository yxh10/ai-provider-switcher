# ai-provider-switcher

A cross-platform desktop app (Tauri) + CLI for managing model-provider configs
for **multiple coding agents** — currently [Codex](https://github.com/openai/codex)
and [Claude Code](https://docs.claude.com/en/docs/claude-code). Add, switch, and
remove providers without hand-editing TOML/JSON or your shell rc files.

The desktop app has a **Codex / Claude Code** toggle at the top; each target
manages its own config file, provider list, and presets. The selected target
persists across restarts.

| Target | Config location | Provider store | API keys |
| --- | --- | --- | --- |
| **Codex** | `~/.codex/config.toml` | `[model_providers.*]` in config.toml (Codex-native: name/base_url/env_key/wire_api) + `~/.codex/provider-switcher.json` for per-provider `model` | Shell rc (`~/.zshrc`, `setx` on Windows) |
| **Claude Code** | `~/.claude/settings.json` (`env` key) | `~/.claude/provider-switcher.json` | Written into `settings.json` `env` when active |

API keys are never written into Codex's `config.toml`. For Claude Code, the
active provider's key lives in `~/.claude/settings.json` under `env` (the
documented Claude Code mechanism, read at startup regardless of how `claude` is
launched — CLI or desktop app). The full set of saved providers is kept in a
separate `provider-switcher.json` so you can switch between them.

> **Why a sidecar for Codex?** Codex's `[model_providers.*]` schema only knows
> `name` / `base_url` / `env_key` / `wire_api`. The per-provider `model` is
> app-only metadata (used to recall which model each saved provider uses), so it
> lives in `~/.codex/provider-switcher.json` rather than polluting `config.toml`.
> Switching back to the built-in default removes the top-level `model` /
> `model_provider` from `config.toml` and leaves it containing only Codex-native
> fields — no app-only leftovers. On first run after upgrading, any existing
> `model = "..."` inside `[model_providers.*]` is automatically migrated into the
> sidecar and stripped from `config.toml`.

## Install

```bash
cd ai-provider-switcher
npm install
npm link   # optional: makes `cpm` available globally
```

Then run either `node index.js <command>` or, after `npm link`, just `cpm <command>`.
For the desktop app: `npm run tauri dev` (or build with `npm run tauri build`).

> The CLI currently targets Codex only. The desktop app supports both Codex and
> Claude Code. CLI support for Claude Code is planned.

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
| OpenCode Go | `https://opencode.ai/zen/go/v1` | `responses` | `OPENCODE_GO_API_KEY` |
| Prism API | `https://sub2api.558686.xyz/v1` | `responses` | `PRISM_API_KEY` |

Pick a preset and all fields fill in automatically — you just enter your API
key. You can still edit any field after selecting a preset.

> **Note:** Codex now only supports the **Responses API** (`wire_api = "responses"`).
> The Chat Completions wire API is no longer supported.

## Claude Code support (desktop app)

Switch the top toggle to **Claude Code** to manage providers for Claude Code.
Because Claude Code has no native multi-provider config, this app keeps its own
provider list in `~/.claude/provider-switcher.json` and writes the **active**
provider into `~/.claude/settings.json` under the `env` key:

```json
{
  "model": "opus",
  "effortLevel": "high",
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4000",
    "ANTHROPIC_MODEL": "claude-sonnet-4-20250514",
    "ANTHROPIC_AUTH_TOKEN": "sk-..."
  }
}
```

Your existing `settings.json` keys (`model`, `enabledPlugins`, etc.) are
preserved — only the `env` block is modified, and only the `ANTHROPIC_*` keys
are touched. The file's key order is preserved.

**This works for both the Claude Code CLI and the Claude Code desktop app** —
Claude Code reads the `env` key at startup regardless of how it's launched.

### Auth type

Claude Code supports two auth headers. Pick the one your endpoint expects:

| Auth type | Env var written | Header sent |
| --- | --- | --- |
| Auth Token | `ANTHROPIC_AUTH_TOKEN` | `Authorization: Bearer <value>` |
| API Key | `ANTHROPIC_API_KEY` | `x-api-key: <value>` |

Switching auth type automatically removes the other env var so they never
conflict.

### Claude Code presets

| Preset | Base URL | Auth type | Model |
| --- | --- | --- | --- |
| HuoShan GLM 5.2 | `https://ark.cn-beijing.volces.com/api/coding/v3` | Auth Token | `glm-latest` |
| OpenCode Go | `https://opencode.ai/zen/go` | Auth Token | `glm-5.2` |
| LiteLLM Proxy | `http://localhost:4000` | Auth Token | `claude-sonnet-4-20250514` |

The base URL is the **root** of an Anthropic Messages-compatible endpoint —
Claude Code appends `/v1/messages` itself. Don't include `/v1` in the base URL.

### Switching back to the Anthropic default

Click the **Anthropic Default** card to clear the `ANTHROPIC_*` env vars from
`settings.json`. Claude Code then uses your native Claude subscription again.

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

- **Wire API (Codex):** Codex now expects the Responses API (`wire_api = "responses"`).
  Providers that only support `/v1/chat/completions` may not work; choose `chat`
  only if you know your provider needs it.
- **Claude Code endpoints:** must expose the Anthropic Messages format
  (`/v1/messages`). OpenAI-style `/v1/chat/completions` endpoints will not work
  with Claude Code.
- **Windows:** `setx` only affects *new* processes — close and reopen Codex /
  your terminal after setting a key.
- **macOS:** after `cpm add`, run `source ~/.zshrc` (or open a new terminal) so
  the key is available, then restart Codex Desktop.
- Every write creates a timestamped backup: `config.toml.bak.*` **and**
  `provider-switcher.json.bak.*` in `~/.codex` (Codex) and `settings.json.bak.*`
  / `provider-switcher.json.bak.*` in `~/.claude` (Claude Code). Restoring a
  Codex backup brings back both files (matched by timestamp) and re-runs
  migration so a restored pre-sidecar backup is cleaned up automatically.
