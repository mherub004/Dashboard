# MTech Infra

A private operations dashboard for server resources, Docker containers, network throughput, websites, and services.

**Dashboard:** https://dashboard.iamahsan.org  
**Repository:** https://github.com/mherub004/Dashboard

## How it works

The UI and authenticated API run on Cloudflare Pages. D1 stores the admin password hash, sessions, service configuration, website check cache, and latest server report.

A Python/FastAPI agent runs on your **Linux Docker host** and sends telemetry to Pages over HTTPS every 30 seconds. No inbound server port is needed. One server is supported by this first version. CPU/memory charts retain samples for the current browser session; long-term metric retention is not implemented.

## Admin account

Sign in with the supplied admin credentials. Use **Account settings** to change your password. Sessions expire after 12 hours, are stored in secure HTTP-only cookies, and are revoked when the password changes. Login attempts are rate limited.

Use **Manage setup** to add, edit or remove websites, domains and service entries. Website checks run while the dashboard is open, with a 60-second cache. They measure HTTP reachability and response time, not historical uptime percentage or domain expiration. Public domain names on standard HTTP/HTTPS ports are supported; at most 10 sites per workspace.

Service statuses are notes maintained by the administrator; Docker statuses come from the engine.

## Connect your server

On your Linux server with Docker and Docker Compose installed:

~~~bash
git clone https://github.com/mherub004/Dashboard.git
cd Dashboard
cp .env.example .env
stat -c '%g' /var/run/docker.sock
~~~

In the dashboard, choose **Connect server** and copy the connection settings. Edit your server's .env file:

- DASHBOARD_URL: https://dashboard.iamahsan.org
- AGENT_TOKEN: the token shown in the connection screen
- DOCKER_GID: the group ID printed by the stat command
- SERVER_NAME: a label for this host
- NETWORK_INTERFACES: optional comma-separated interface names, for example eth0

Then run:

~~~bash
docker compose up -d --build
docker compose logs --tail=50 agent
~~~

The dashboard marks reports stale after two minutes without updates. Docker statistics are read-only in application code; container start/stop/delete operations are not exposed. A read-only bind mount of the Docker socket does **not** restrict Docker API capabilities. The agent has Docker socket access and a read-only host root mount for host disk usage, so install it only on a host you administer.

Host networking is required for host network counters. Without NETWORK_INTERFACES, loopback and common Docker/veth bridges are excluded. Select the physical interface explicitly if your host has overlapping bridges, VLANs or VPN interfaces. Throughput describes this host's interfaces, not all devices on a router or LAN.

The agent's FastAPI health endpoint listens only on 127.0.0.1:9876. No server admin password is required; administration happens through Pages.

## Update the server agent

~~~bash
git pull --ff-only
docker compose up -d --build
~~~

Images are built from this repository. This version does not publish a prebuilt GHCR image.

## Deployment

Cloudflare Pages is connected to the main branch:

- Build command: node build.mjs
- Output directory: dist
- Production database binding: DB
- Secret environment variable: AGENT_TOKEN

The build checks JavaScript syntax and runs the API validation/security tests before copying only public assets into dist. Pages Functions are bundled separately from functions/. Preview API deployments have no production database binding.

schema.sql defines the database tables. The admin password is stored as a salted PBKDF2 hash in D1; sessions store only token hashes. No credentials are stored in Git.

To provision another instance, create a D1 database, apply schema.sql, insert an admin password hash using the same PBKDF2 format as the API, bind DB, and set a random AGENT_TOKEN secret. Do not expose a public unauthenticated setup endpoint.

## Development and checks

Node 22 or newer:

~~~bash
npm test
npm run build
~~~

For local Pages development, use Wrangler with a local D1 database and local secrets. Do not point development tests at the production database.

## Cost and limits

This deployment uses Cloudflare Pages and D1 with free-tier usage in mind. No paid subscription or paid API is required by the code. Free tiers have quotas, and your server, domain and payment processing costs are separate. This is a monitoring foundation, not a guarantee of zero operating costs at arbitrary scale.

## Personal dashboard tools

The overview includes an Open-Meteo forecast for Erlangen, shortcuts and availability checks for configured websites, and recent public commits from this repository. The calendar stores dated notes in the private D1 database behind the admin session. GitHub activity is public repository metadata and is fetched from the browser. The storage card reports the monitored host's OS filesystem usage.

The host agent can read WireGuard peer IPs and latest handshake times from a root-generated status snapshot without being granted NET_ADMIN. It can also track successful backup marker timestamps. The backup marker must only be updated after the backup command succeeds.

## Docker troubleshooting

If host CPU, memory, disk and network appear but containers do not, the agent is reaching the dashboard and its Docker socket is the part that needs fixing.

On the server, check the daemon and socket:

~~~bash
docker ps
stat -c '%g %n' /var/run/docker.sock
grep '^DOCKER_GID=' .env
docker compose logs --tail=50 agent
~~~

Set DOCKER_GID in .env to the numeric group printed by stat, then recreate the agent:

~~~bash
docker compose up -d --build
docker compose logs -f agent
~~~

The dashboard reports a specific Docker socket error. For rootless Docker, set DOCKER_SOCKET and DOCKER_HOST to the daemon's actual socket, often `/run/user/<user-id>/docker.sock`, and set DOCKER_GID to that socket's group. Restart the agent after any .env change.

### Home network visualizations

The Home network page shows server interface throughput and byte totals, LAN neighbors visible in the host ARP cache, AdGuard Home query statistics/top domains/top clients, and WireGuard peer handshakes and transfer totals. The server agent cannot see each device's bandwidth through a Vodafone Station unless the router provides per-client counters/flow export or a network monitor is placed at the gateway. The public IP and WireGuard port do not expose that data.

To enable AdGuard Home statistics and recent query activity, set `ADGUARD_URL=http://127.0.0.1:8085`, `ADGUARD_USERNAME`, and `ADGUARD_PASSWORD` in the agent's `.env` file for the Portainer AdGuard container. Set `WIREGUARD_CONTAINER=wg-easy` and `REPORT_INTERVAL=10` there too, then rebuild the agent. The dashboard polls every five seconds; the agent sends reports every ten seconds and reads WireGuard counters directly from the running container. The address must be reachable from the host-networked agent; use the AdGuard Home web port (commonly `http://127.0.0.1:80` after setup). Then run `docker compose up -d --build` in the agent directory. Keep credentials on the server. DNS history uses AdGuard Home's statistics endpoint; query counts and domain names are sent to the authenticated dashboard storage.

### Enable WireGuard peers and backup history

The helper reads a host-level WireGuard interface. On Debian or Ubuntu, install the `wg` utility first, then confirm `sudo wg show all` lists your interface and peers. On a host using apt, install WireGuard tools with `sudo apt update && sudo apt install wireguard`. The host agent reads a snapshot file; it does not need `NET_ADMIN` or access to WireGuard private keys. Install the helper from the repo on the host and schedule it as root once per minute:

~~~bash
sudo install -d -m 755 /var/lib/mtech-infra
sudo install -m 755 scripts/wireguard_status.py /usr/local/bin/mtech-wireguard-status
sudo /usr/local/bin/mtech-wireguard-status
sudo crontab -e
~~~

If WireGuard runs in a Portainer container, get its exact container name with `docker ps --format 'table {{.Names}}\t{{.Image}}'`, then put that name in root's crontab. The helper uses `docker exec <name> wg`; it does not install or start another WireGuard server. For host-installed WireGuard, leave the variable unset.

~~~cron
WIREGUARD_CONTAINER=your-wireguard-container-name
* * * * * /usr/local/bin/mtech-wireguard-status >/dev/null 2>&1
~~~

Replace the example value with the real container name. If your server is on the host, omit the first line.

Set `WIREGUARD_STATUS_FILE=/var/lib/mtech-infra/wireguard-status.json` in the server's `.env`. The helper reads allowed IPs, latest handshakes, and transfer byte counters from `wg` (never private or preshared keys) and writes peer labels, tunnel IPs, handshake times, and received/sent totals. A recent handshake is shown as recent; WireGuard cannot prove a peer is currently reachable just from an old handshake. If WireGuard runs only inside a separate container/network namespace, this host helper will not see it and needs to run in that namespace.

To track backups, set `BACKUP_HEARTBEAT_FILE` in `.env` to an absolute path on the host. Make the marker readable to the agent. Your backup script must touch it only after a successful backup, for example:

~~~bash
your-backup-command && touch /var/lib/mtech-infra/backup-success
~~~

Create the marker directory with read/traverse permissions for the agent, set `BACKUP_HEARTBEAT_FILE=/var/lib/mtech-infra/backup-success`, and recreate the agent. Each new marker timestamp is recorded in the dashboard's D1 history.
