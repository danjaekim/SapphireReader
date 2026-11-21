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

**Phase 0: engine stack on the NAS.** Not yet a reader. This phase runs the source engine,
a Cloudflare solver and ntfy on the NAS, and tests which sites work.

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
