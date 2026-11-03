# Changelog

## 0.9.0

First public release, a full rewrite of the prototype.

- **Shell integration** (`pikaclow init`): PowerShell, bash, zsh and fish remember the last command that failed
  and show a one-line hint under it. Press **Alt+Z** (or run `pikaclow fix`) to re-run it, read the real error and
  get the fix. The hook runs no Node process per prompt, ignores answers like `grep` finding nothing, and never
  re-runs a dangerous command on its own. `init --uninstall` removes it cleanly.
- **`dev`**: starts the project's dev server with the right package manager (packageManager field or lockfile),
  installs dependencies when missing, and, when the port is taken, shows who holds it and offers to stop it or move
  to the next free port (Vite, Next.js, Nuxt, Astro, Angular, Remix, Gatsby, webpack, Storybook…). If the server
  crashes, PikaClow offers to explain why.
- Update notice: at most once a day a background helper asks npm for the latest version; commands never wait for
  the network. Turn it off with `PIKACLOW_NO_UPDATE_CHECK=1`.
- Interactive mode with a pixel-art logo, `/` command menu, history, `!shell` and streaming AI chat. Failed `!`
  commands feed `/fix`.
- `dash` / `top`: full-screen dashboard with sorting, grouping, filtering and process kill. Uses one shared
  PowerShell helper on Windows and never overlaps polls (the prototype could stall the machine).
- `ports`: locale-independent listening-port detection, dev-server and project detection, network exposure,
  next free port, `--kill`, `--pick`, `--json`. Works on minimal Linux systems without lsof/ss (reads /proc).
- `clean`: only regenerable folders next to project markers, git-ignore verification, age-based suggestions,
  interactive selection, package-manager cache cleaning (`--caches`). Scans asynchronously.
- `doctor`: Node/npm/git/Python/PATH/disk/RAM/ports/AI checks plus Windows execution policy, long paths, shell
  integration and PikaClow updates.
- AI: Ollama and OpenAI-compatible providers, `setup`, `models` (tokens-per-second estimates), `ask`, `sh`
  (static danger checker), `explain` (offline knowledge base + AI, frees busy ports), `commit` (AI or offline).
- English and Vietnamese interface, pixel-art design throughout.
