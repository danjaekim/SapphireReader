# Sapphire

A self-hosted manga, manhwa and manhua reader, named after a cat. It runs as a Docker
stack on a home NAS and opens in a browser on PC, phone or tablet, with reading progress
shared across every device.

Planned features:

- Read from many free sources through community-maintained Keiyoushi extensions.
- Search once, and Sapphire picks the source with the highest chapter.
- Resume any series where you left off; new-chapter alerts for series you're caught up on.
- Discover with filters and sorts, recommendations, and "similar to this".
- A separate, PIN-protected 18+ mode with its own Discover page and recommendations.

Plan: [Manhwa Reader: desktop app plan](https://claude.ai/artifact/C1osCfwyKq3pFkWTS26JPp)

## Status

**Phase 1 and beyond: the Sapphire app.** A Node server and installable web app (PWA) with
the cat branding and a left-hand menu. What it does today:

- Search across your sources (grid, infinite scroll), with stackable genre filters.
- Series pages with chapters, genres, "also on" other sources, similar series, and AniList linking.
- A reader that remembers your place, plus per-chapter downloads to the NAS and a Downloads page.
- A Library with reading progress, and push alerts through ntfy when a series you're caught up on gets a new chapter.
- Discover: For you, Popular, Latest, and genre filters.
- An 18+ mode behind a PIN with its own library and Discover (18+) page.
- A Sources page to install, update and remove extensions, and to see which sources are healthy.
- Daily backups of the library database (`data/app/backups`), plus a download button on the Settings page.

- `server/`: Fastify + TypeScript API, serves the built web app.
- `web/`: React + Vite web app.
- `Dockerfile`: builds both into one image; GitHub Actions publishes it to
  `ghcr.io/danjaekim/sapphire` on every push to `main`.

Run locally: `cd server && npm ci && npm run dev` and, in another terminal,
`cd web && npm ci && npm run dev`, then open the address Vite prints.

**Phase 0 (done): engine stack on the NAS.** Runs the source engine, a Cloudflare solver
and ntfy, and tests which sites work.

- Stack: [`deploy/docker-compose.yml`](deploy/docker-compose.yml)
- Setup on the UGREEN DXP2800: [`docs/phase-0-setup.md`](docs/phase-0-setup.md)
- Site test checklist: [`docs/phase-0-site-test.md`](docs/phase-0-site-test.md)
- Optional remote access: [`deploy/docker-compose.tailscale.yml`](deploy/docker-compose.tailscale.yml)

## How it fits together

```
 phone / tablet / PC  (web app)
          |
          |  home network (or Tailscale when away)
          v
 +------------------ Docker stack on the NAS ------------------+
 |  Sapphire server (Phase 1+)  ---->  ntfy (push alerts)       |
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

To see on the Settings page whether a newer version is out, Sapphire asks GitHub for the latest commit.
The repo is private, so it needs a token: on GitHub open Settings > Developer settings > Fine-grained
tokens > Generate new token, pick only the SapphireReader repository, give it **Contents: Read-only**
(nothing else), and set it as `UPDATE_GITHUB_TOKEN` on the `sapphire` service.

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
