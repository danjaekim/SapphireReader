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
- Daily backups of the library database (`data/app/backups`), plus a download button on the Status page.

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
(it checks every 6 hours). The Status page also has an **Update now** button. Set `UPDATE_TOKEN` on the
`sapphire` service and `WATCHTOWER_HTTP_API_TOKEN` on `watchtower` to the same random string. Changes to the
compose file itself (new services, ports, env vars) still need a redeploy from the Docker app.

## HTTPS (for offline reading on your phone)

Browsers only let a site save things for offline use when it's opened over https. Tailscale can give
Sapphire an https address on your tailnet. On the NAS, with Tailscale running:

```
sudo tailscale serve --bg --https=443 http://localhost:8080
```

Then open `https://<nas-name>.<your-tailnet>.ts.net` on your phone (Tailscale shows the exact name).
Turn on HTTPS certificates in the Tailscale admin console under DNS if it asks.
