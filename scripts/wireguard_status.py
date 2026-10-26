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


def main():
    allowed = subprocess.run(
        ["wg", "show", "all", "allowed-ips"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    handshakes = subprocess.run(
        ["wg", "show", "all", "latest-handshakes"],
        check=True,
        capture_output=True,
        text=True,
        timeout=10,
    )
    last_handshake = {}
    for line in handshakes.stdout.splitlines():
        fields = line.split("\t")
        if len(fields) >= 3:
            last_handshake[(fields[0], fields[1])] = int(fields[2] or "0")

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
