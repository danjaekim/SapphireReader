# Phase 0 setup on the UGREEN DXP2800

This gets the engine stack running on the NAS so you can test your sources before any
Sapphire code exists. It takes about 20 minutes.

What you'll have afterwards:

| Service | Address | Purpose |
| --- | --- | --- |
| Engine (Suwayomi) | `http://<NAS IP>:4567` | Temporary web UI for installing Keiyoushi extensions and testing sites. Hidden again in Phase 1. |
| ntfy | `http://<NAS IP>:8090` | Push notifications. Sapphire will post new-chapter alerts here. |
| Cloudflare solver | internal only | Used by the engine when a site shows a Cloudflare check. |

## 1. Make a folder for the stack

Put it on the M.2 volume so the database and image cache are fast. In the UGOS Files app,
create a folder such as `docker/sapphire` on that volume. The stack keeps everything
inside it under `data/`, so backing up this one folder backs up Sapphire.

## 2. Fill in the compose file

Open `deploy/docker-compose.yml` from this repo and replace each `CHANGE_ME`:

- `AUTH_PASSWORD`: a password for the engine's web UI (username is `sapphire`).
- `NTFY_BASE_URL`: your NAS's local IP with port 8090, for example `http://192.168.1.50:8090`.
  The IP is shown in UGOS under Control Panel > Network.

If ports 4567 or 8090 are already used by something else on the NAS, change the number on
the left side of the `ports` line (for example `"4580:4567"`).

## 3. Create the project in UGOS

In the UGOS **Docker** app, open **Project** and create a new project:

- Name: `sapphire`
- Path: the `docker/sapphire` folder from step 1
- Compose: paste the edited `docker-compose.yml`

Start it. The first start downloads over 1 GB of images and the engine needs a minute or
two to boot. Menu names can differ slightly between UGOS versions.

If you prefer SSH: copy the file into the folder and run `docker compose up -d` there.

## 4. Check the engine

1. Open `http://<NAS IP>:4567` and log in as `sapphire`.
2. Go to **Extensions**. The Keiyoushi repository is already configured, so the list
   should be populated. If it is empty, use the refresh button.
3. Install the extensions in [the site test checklist](phase-0-site-test.md).

## 5. Set up ntfy on your phone

1. Create your ntfy login (SSH, or the container's terminal in the Docker app):

   ```
   docker exec -it sapphire-ntfy ntfy user add --role=admin dan
   ```

2. Install the ntfy app (Android or iOS). Add the server `http://<NAS IP>:8090`, log in, and
   subscribe to a topic named `sapphire`.
3. Send yourself a test from any computer on your network:

   ```
   curl -u dan:YOUR_PASSWORD -d "Test from Sapphire" http://<NAS IP>:8090/sapphire
   ```

   Your phone should show it within a few seconds.

## 6. Measure memory

After testing a few sites, check how much RAM the stack really uses. In the Docker app's
container list, or over SSH:

```
docker stats --no-stream sapphire-engine sapphire-flaresolverr sapphire-ntfy
```

Write the numbers into the checklist. The plan estimates 0.5 to 1 GB day to day.

## Optional: reading away from home

`deploy/docker-compose.tailscale.yml` adds Tailscale as a separate project. Instructions
are at the top of that file. It is not needed for Phase 0.
