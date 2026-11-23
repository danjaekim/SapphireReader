# Sapphire

A self-hosted manga, manhwa and manhua reader, named after a cat. It runs as a Docker
stack on a home NAS and opens in a browser on PC, phone or tablet, with reading progress
shared across every device.

What it does:

- Reads from many free sources through community-maintained Keiyoushi extensions, run by a headless
  Suwayomi engine. Search covers every source at once, ranked by how well titles match, with filters,
  sorts and a source filter.
- Series pages with chapters, "Also on" other sources, similar series, AniList scores and banners, likes,
  and merging of the same series across sources: suggested merges (same MangaBaka entry or same name apart
  from "Uncensored" and the like), a side-by-side compare to pick the main copy, and a choice of which
  copy's name, cover and description show.
- A reader (scroll or paged, set per device) that remembers your place everywhere; History; mark read.
- A Library with shelves, categories and sorting; new-chapter alerts through ntfy; offers to move a series
  to a source that's further ahead, or to a preferred version (for example Uncensored).
- Discover: For you (taste-based rows, cached and refreshable), Popular, Latest, genre browsing.
- A separate, PIN-protected 18+ mode with its own library, Discover and recommendations, unlocked with the PIN or Face ID (a passkey, on the https address).
- Downloads to the NAS (auto-download next chapters, auto-delete after reading), and an offline mode on phones:
  save chapters to the phone, read them with no connection, and your place syncs when you're back.
- Sources and Settings pages: extensions, source health, hidden and favorite tags, light theme, updates, backups.

**The full, current description of features, architecture, logic, decisions and open tasks lives in
[`docs/PROJECT.md`](docs/PROJECT.md).** Start there.

Original plan: [Manhwa Reader: desktop app plan](https://claude.ai/artifact/C1osCfwyKq3pFkWTS26JPp)

## For agents and contributors

1. Read [`docs/PROJECT.md`](docs/PROJECT.md) before changing anything. It is the living source of truth.
2. Every change that adds, removes or alters a feature, endpoint, table, setting, behavior or decision must
   update `docs/PROJECT.md` in the same commit, including the open questions and tasks list.
3. Tests: `cd server && npx vitest run`. Web type check and build: `cd web && npm run build`.

## Code layout

- `server/`: Fastify + TypeScript API on `node:sqlite`; serves the built web app.
- `web/`: React + Vite web app (installable PWA).
- `deploy/`: the Docker stack ([`docker-compose.yml`](deploy/docker-compose.yml)), plus optional
  [Tailscale](deploy/docker-compose.tailscale.yml).
- `Dockerfile`: builds both into one image; GitHub Actions publishes it to `ghcr.io/danjaekim/sapphire`
  on every push to `main`.

Run locally: `cd server && npm ci && npm run dev` and, in another terminal,
`cd web && npm ci && npm run dev`, then open the address Vite prints.

NAS setup history: [`docs/phase-0-setup.md`](docs/phase-0-setup.md) and the site test checklist
[`docs/phase-0-site-test.md`](docs/phase-0-site-test.md).

## How it fits together

```
 phone / tablet / PC  (web app)
          |
          |  home network (or Tailscale when away)
          v
 +------------------ Docker stack on the NAS ------------------+
 |  Sapphire server  ---------->  ntfy (push alerts)          |
 |          |                                                   |
 |          v                                                   |
 |  engine: Suwayomi-Server, headless --> Cloudflare solver    |
 |          runs the Keiyoushi extensions                      |
 +-------------------------------------------------------------+
          |
          v
   manga sites
```

Suwayomi-Server is used only as the runtime for the extensions. Sapphire has its own UI,
database, progress tracking, source ranking and recommendations.

## Personal use

Sapphire is a single-user app for one household's network. It ships no sources of its
own; sources come from extensions installed by the user.

## Updating

The compose file includes Watchtower, which updates the Sapphire app when a new image is published
(it checks every 6 hours). The Settings page also has an **Update now** button. Set `UPDATE_TOKEN` on the
`sapphire` service and `WATCHTOWER_HTTP_API_TOKEN` on `watchtower` to the same random string. Changes to the
compose file itself (new services, ports, env vars) still need a redeploy from the Docker app.

To see on the Settings page whether a newer version is out, Sapphire compares the image it is running with the
newest published image (`latest` on GitHub's container registry), so a new version only shows up once it can
actually be installed. That works with no setup while the package is public. If the package or repo is private,
create a GitHub token (Settings > Developer settings > Fine-grained or classic token) that can read the package and
repo, and set it as `UPDATE_GITHUB_TOKEN` on the `sapphire` service.

### Updating the engine

Settings > **Source engine** shows the engine's (Suwayomi's) version next to the newest release, so you can see
when it's behind. The engine is updated only when you press **Update engine**, never on a schedule, because it
restarts for about half a minute. That button needs the second Watchtower in the compose file
(`watchtower-engine`): copy it, the `scope` labels, `WATCHTOWER_SCOPE=sapphire` on the first Watchtower, and the
`ENGINE_UPDATE_URL` / `ENGINE_UPDATE_TOKEN` lines, set both tokens to the same random string, and redeploy
once from the Docker app. Without them the card still shows versions; update the engine from the Docker app.

## HTTPS (for offline reading on your phone)

Browsers only let a site save things for offline use (and install it as an app) when it's opened
over https. Tailscale can give Sapphire an https address on your tailnet:

1. In the Tailscale admin console, open **DNS**, make sure **MagicDNS** is on, and turn on
   **HTTPS Certificates**.
2. On the NAS, tell the Tailscale container to serve Sapphire over https (over SSH, or the
   container's terminal in the Docker app, where you drop `sudo docker exec sapphire-tailscale`):

   ```
   sudo docker exec sapphire-tailscale tailscale serve --bg --https=443 http://localhost:8080
   ```

   This is remembered in `data/tailscale`, so it survives restarts. `tailscale serve status`
   shows it; `tailscale serve --https=443 off` undoes it.
3. Open `https://sapphire.<your-tailnet>.ts.net` on your phone (the admin console shows the exact
   name). The first visit can take a few seconds while the certificate is issued.
