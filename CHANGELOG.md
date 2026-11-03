# Changelog

## 1.0.0

First public release, a full rewrite of the prototype.

- Interactive mode with a pixel-art logo, `/` command menu, history, `!shell` and streaming AI chat.
- `dash` / `top`: full-screen dashboard with sorting, grouping, filtering and process kill. Uses one shared
  PowerShell helper on Windows and never overlaps polls (the prototype could stall the machine).
- `ports`: locale-independent listening-port detection, dev-server and project detection, network exposure,
  next free port, `--kill`, `--pick`, `--json`.
- `clean`: only regenerable folders next to project markers, git-ignore verification, age-based suggestions,
  interactive selection, package-manager cache cleaning (`--caches`). Scans asynchronously.
- `doctor`: Node/npm/git/Python/PATH/disk/RAM/ports/AI checks plus Windows execution policy and long paths.
- AI: Ollama and OpenAI-compatible providers, `setup`, `models` (tokens-per-second estimates), `ask`, `sh`
  (static danger checker), `explain` (offline knowledge base + AI, frees busy ports), `commit` (AI or offline).
- English and Vietnamese interface.
