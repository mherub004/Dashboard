# Dashboard

A private operations dashboard at https://dashboard.iamahsan.org for server resources, Docker containers, network throughput, websites, and editable service entries.

The dashboard and authenticated API run on Cloudflare Pages. D1 stores settings and the latest server report. A lightweight Python/FastAPI agent runs on your Linux Docker host and sends metrics outbound over HTTPS. No inbound server port is required.

## Server setup

After signing in, open **Connect server** and copy the agent token into your server's .env file. Follow the repository's Docker Compose instructions. Never put the token or admin password in Git.

## Deployment

Cloudflare Pages builds the static UI with `node build.mjs` and publishes `dist`. Pages Functions handle `/api/*`. The production database binding is `DB`; admin and agent credentials are encrypted Pages environment variables.

This repository is being initialized with the complete application.
