#!/usr/bin/env python3
"""Write non-secret WireGuard peer status for the MTech Infra dashboard agent."""
import ipaddress
import json
import os
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

OUTPUT = Path("/var/lib/mtech-infra/wireguard-status.json")


def run_wg(*args):
    container = os.getenv("WIREGUARD_CONTAINER", "").strip()
    command = ["docker", "exec", container, "wg", *args] if container else ["wg", *args]
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=10)


def main():
    try:
        run_wg("--version")
    except FileNotFoundError as error:
        if os.getenv("WIREGUARD_CONTAINER", "").strip():
            raise SystemExit("Docker CLI is missing on the host.") from error
        raise SystemExit("No WIREGUARD_CONTAINER is set and host 'wg' is missing. Set WIREGUARD_CONTAINER to the Portainer container name.") from error
    except subprocess.CalledProcessError as error:
        raise SystemExit("Could not run wg. Check that the WireGuard container name is correct and running.") from error

    allowed = run_wg("show", "all", "allowed-ips")
    transfers = run_wg("show", "all", "transfer")
    handshakes = run_wg("show", "all", "latest-handshakes")
    last_handshake = {}
    for line in handshakes.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) >= 3:
            last_handshake[(fields[0], fields[1])] = int(fields[2] or "0")

    transfer_bytes = {}
    for line in transfers.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) >= 4:
            transfer_bytes[(fields[0], fields[1])] = (int(fields[2] or 0), int(fields[3] or 0))

    peers = []
    for line in allowed.stdout.splitlines():
        fields = line.split("\t", 2)
        if len(fields) < 3:
            continue
        interface, public_key, allowed_ips_value = fields
        allowed_ips = allowed_ips_value.split(",")
        address = ""
        if allowed_ips and allowed_ips[0]:
            try:
                address = str(ipaddress.ip_interface(allowed_ips[0]).ip)
            except ValueError:
                address = allowed_ips[0][:64]

        handshake = last_handshake.get((interface, public_key), 0)
        last_seen = (
            datetime.fromtimestamp(handshake, timezone.utc).isoformat()
            if handshake > 0
            else None
        )
        recent = handshake > 0 and time.time() - handshake <= 180
        peers.append({
            "name": (interface + " · " + address).strip(" ·")[:80],
            "ip": address,
            "online": recent,
            "last_seen": last_seen,
            "received": transfer_bytes.get((interface, public_key), (0, 0))[0],
            "sent": transfer_bytes.get((interface, public_key), (0, 0))[1],
        })

    payload = {"generated_at": int(time.time()), "peers": peers[:100]}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=OUTPUT.parent, delete=False
    ) as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
        temporary = Path(handle.name)
    os.chmod(temporary, 0o644)
    os.replace(temporary, OUTPUT)


if __name__ == "__main__":
    main()
