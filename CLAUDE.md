# Sapphire: start here

Read [`docs/PROJECT.md`](docs/PROJECT.md) first. It is the living source of truth for this app:
features, architecture, code map, data model, the logic behind each behavior, decisions made, and the
running list of open questions and tasks.

Rules for every change:

- Update `docs/PROJECT.md` in the same commit whenever you add, remove or change a feature, endpoint,
  table or column, setting, behavior or decision. Move items in "Open questions and tasks" as they are
  answered or done, and bump "Last full audit" when you re-check the whole document.
- Keep `README.md` accurate for anything user-facing it mentions (features summary, setup, updating).
- Push straight to `main` (no PRs). Run `cd server && npx vitest run` and `cd web && npm run build` first.
- Never commit credentials, PINs or tokens. Keep 18+ titles out of notifications and tab titles.
