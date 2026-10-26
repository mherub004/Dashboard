"""Outbound-only host telemetry agent for MTech Infra."""
import asyncio
import contextlib
import logging
import json
import os
import socket
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from urllib.parse import urlparse

import docker
import httpx
import psutil
import ipaddress
from datetime import datetime, timezone
from fastapi import FastAPI

log = logging.getLogger("uvicorn.error")
DASHBOARD_URL = os.environ.get("DASHBOARD_URL", "").rstrip("/")
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
INTERVAL = max(5, int(os.environ.get("REPORT_INTERVAL", "10")))
previous_network = None
previous_time = None
previous_interfaces = None
previous_interfaces_time = None
last_success = None
WIREGUARD_STATUS_FILE = os.getenv("WIREGUARD_STATUS_FILE", "/var/lib/mtech-infra/wireguard-status.json")
WIREGUARD_CONTAINER = os.getenv("WIREGUARD_CONTAINER", "").strip()
BACKUP_HEARTBEAT_FILE = os.getenv("BACKUP_HEARTBEAT_FILE", "")


def network_counters():
    global previous_interfaces, previous_interfaces_time
    counters = psutil.net_io_counters(pernic=True)
    selected = [x.strip() for x in os.getenv("NETWORK_INTERFACES", "").split(",") if x.strip()]
    if not selected:
        selected = [name for name in counters if not name.startswith(("lo", "veth", "docker", "br-", "virbr", "wg", "tun"))]
    active = [name for name in selected if name in counters]
    now = time.monotonic()
    elapsed = max(now - previous_interfaces_time, 0.1) if previous_interfaces_time is not None else 0
    interface_stats = []
    for name in active:
        item, prior = counters[name], (previous_interfaces or {}).get(name)
        interface_stats.append({"name": name, "sent": item.bytes_sent, "received": item.bytes_recv,
            "up": round(max(0, item.bytes_sent - prior.bytes_sent) / elapsed) if prior and elapsed else 0,
            "down": round(max(0, item.bytes_recv - prior.bytes_recv) / elapsed) if prior and elapsed else 0})
    previous_interfaces, previous_interfaces_time = counters, now
    return {"sent": sum(counters[name].bytes_sent for name in active),
        "received": sum(counters[name].bytes_recv for name in active), "interfaces": ", ".join(active),
        "interface_stats": interface_stats}


def host_metrics():
    global previous_network, previous_time
    current = time.monotonic()
    network = network_counters()
    elapsed = current - previous_time if previous_time is not None else 0
    network["up"] = max(0, network["sent"] - previous_network["sent"]) / elapsed if elapsed else 0
    network["down"] = max(0, network["received"] - previous_network["received"]) / elapsed if elapsed else 0
    previous_network, previous_time = network.copy(), current
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/host" if os.path.exists("/host") else "/")
    return {
        "name": os.getenv("SERVER_NAME") or socket.gethostname(),
        "cpu": psutil.cpu_percent(),
        "memory": memory.percent,
        "memory_used": memory.used,
        "memory_total": memory.total,
        "disk": disk.percent,
        "disk_used": disk.used,
        "disk_total": disk.total,
        "uptime": int(time.time() - psutil.boot_time()),
        "network": network,
    }


def docker_diagnostic(error):
    message = str(error).lower()
    if "permission denied" in message or "access is denied" in message:
        return "permission_denied"
    if any(value in message for value in ("no such file or directory", "cannot find the file", "socket is not available")):
        return "socket_missing"
    if any(value in message for value in ("connection refused", "timed out", "connection aborted", "unreachable")):
        return "daemon_unreachable"
    return "unknown"


def container_metrics():
    client = None
    try:
        client = docker.from_env(timeout=3)
        containers = client.api.containers(all=True)[:100]
    except Exception as error:
        if client is not None:
            client.close()
        return [], False, docker_diagnostic(error)

    def sample(container):
        item = {
            "id": container["Id"][:12],
            "name": (container.get("Names") or [container["Id"][:12]])[0].lstrip("/"),
            "status": container.get("State", "unknown"),
            "image": container.get("Image", ""),
            "cpu": 0,
            "memory": 0,
            "stats_available": False,
        }
        if item["status"] == "running":
            try:
                stats = client.api.stats(container["Id"], stream=False)
                cpu, previous = stats.get("cpu_stats", {}), stats.get("precpu_stats", {})
                used = cpu.get("cpu_usage", {}).get("total_usage", 0) - previous.get("cpu_usage", {}).get("total_usage", 0)
                total = cpu.get("system_cpu_usage", 0) - previous.get("system_cpu_usage", 0)
                cores = cpu.get("online_cpus") or len(cpu.get("cpu_usage", {}).get("percpu_usage", [])) or 1
                item["cpu"] = round(max(0, used / total * cores * 100), 1) if total > 0 else 0
                memory = stats.get("memory_stats", {})
                cache = memory.get("stats", {}).get("inactive_file", memory.get("stats", {}).get("total_inactive_file", 0))
                item["memory"] = max(0, memory.get("usage", 0) - cache)
                item["stats_available"] = True
            except Exception:
                pass
        return item

    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            return list(pool.map(sample, containers)), True, None
    finally:
        client.close()


def lan_devices():
    """Best-effort host neighbor cache; it is not a router-wide client list."""
    devices = {}
    try:
        for row in Path("/host/proc/net/arp").read_text(encoding="utf-8").splitlines()[1:]:
            fields = row.split()
            if len(fields) < 6 or fields[2] == "0x0" or fields[3] == "00:00:00:00:00:00":
                continue
            ip, mac, iface = fields[0], fields[3], fields[5]
            if ip.startswith(("127.", "169.254.")):
                continue
            devices[ip] = {"ip": ip, "mac": mac, "interface": iface}
    except OSError:
        pass
    return list(devices.values())[:100]


async def dns_metrics(http):
    base = os.getenv("ADGUARD_URL", "").strip().rstrip("/")
    if not base:
        return None
    try:
        response = await http.get(base + "/control/stats",
            auth=(os.getenv("ADGUARD_USERNAME", ""), os.getenv("ADGUARD_PASSWORD", "")), timeout=4)
        response.raise_for_status()
        raw = response.json()
        def top_rows(rows, field):
            output = []
            for item in rows[:8] if isinstance(rows, list) else []:
                if isinstance(item, dict) and item:
                    label, count = next(iter(item.items()))
                    output.append({field: str(label)[:120], "count": int(count) if isinstance(count, (int, float)) else 0})
            return output
        querylog = {}
        try:
            log_response = await http.get(base + "/control/querylog", params={"limit": 50},
                auth=(os.getenv("ADGUARD_USERNAME", ""), os.getenv("ADGUARD_PASSWORD", "")), timeout=4)
            log_response.raise_for_status()
            querylog = log_response.json()
        except (httpx.HTTPError, ValueError, TypeError):
            querylog = {}
        recent_queries = []
        for entry in querylog.get("data", [])[:50] if isinstance(querylog.get("data", []), list) else []:
            question = entry.get("question") if isinstance(entry, dict) else {}
            if not isinstance(question, dict):
                question = {}
            recent_queries.append({"domain": str(question.get("host", ""))[:180],
                "client": str(entry.get("client", ""))[:64], "time": str(entry.get("time", ""))[:40],
                "reason": str(entry.get("reason", ""))[:80], "status": str(entry.get("status", ""))[:32]})
        return {"available": True, "querylog_available": isinstance(querylog.get("data"), list),
            "queries": int(raw.get("num_dns_queries", 0)), "blocked": int(raw.get("num_blocked_filtering", 0)),
            "time_units": raw.get("time_units") if raw.get("time_units") in ("hours", "days") else "hours",
            "query_history": [int(x) for x in raw.get("dns_queries", [])[-48:] if isinstance(x, (int, float))],
            "blocked_history": [int(x) for x in raw.get("blocked_filtering", [])[-48:] if isinstance(x, (int, float))],
            "domains": top_rows(raw.get("top_queried_domains", []), "domain"),
            "clients": top_rows(raw.get("top_clients", []), "ip"), "recent_queries": recent_queries}
    except (httpx.HTTPError, ValueError, TypeError):
        return {"available": False, "queries": None, "blocked": None, "time_units": "hours",
            "query_history": [], "blocked_history": [], "domains": [], "clients": [], "querylog_available": False, "recent_queries": []}


def backup_metrics():
    if not BACKUP_HEARTBEAT_FILE:
        return None
    marker = Path("/host") / BACKUP_HEARTBEAT_FILE.lstrip("/")
    try:
        return {"last_success": int(marker.stat().st_mtime)}
    except OSError:
        return {"last_success": None}


def wireguard_metrics():
    def peers_from_output(allowed, handshakes, transfers):
        last_handshake = {}
        for line in handshakes.splitlines():
            fields = line.split("\\t")
            if len(fields) >= 3:
                last_handshake[(fields[0], fields[1])] = int(fields[2] or 0)
        byte_counts = {}
        for line in transfers.splitlines():
            fields = line.split("\\t")
            if len(fields) >= 4:
                byte_counts[(fields[0], fields[1])] = (int(fields[2] or 0), int(fields[3] or 0))
        peers = []
        for line in allowed.splitlines():
            fields = line.split("\\t", 2)
            if len(fields) < 3:
                continue
            interface, public_key, allowed_ips = fields
            try:
                address = str(ipaddress.ip_interface(allowed_ips.split(",")[0]).ip)
            except (ValueError, IndexError):
                address = allowed_ips.split(",")[0][:64]
            timestamp = last_handshake.get((interface, public_key), 0)
            peers.append({"name": (interface + " · " + address).strip(" ·"), "ip": address,
                "online": timestamp > 0 and time.time() - timestamp <= 180,
                "last_seen": datetime.fromtimestamp(timestamp, timezone.utc).isoformat() if timestamp else None,
                "received": byte_counts.get((interface, public_key), (0, 0))[0],
                "sent": byte_counts.get((interface, public_key), (0, 0))[1]})
        return peers[:100]

    if WIREGUARD_CONTAINER:
        client = None
        try:
            client = docker.from_env(timeout=4)
            container = client.containers.get(WIREGUARD_CONTAINER)
            def wg(*args):
                result = container.exec_run(["wg", *args])
                if result.exit_code != 0:
                    raise RuntimeError("wg command failed in configured container")
                output = result.output.decode("utf-8", errors="replace") if isinstance(result.output, bytes) else str(result.output)
                return output
            peers = peers_from_output(wg("show", "all", "allowed-ips"),
                wg("show", "all", "latest-handshakes"), wg("show", "all", "transfer"))
            return peers, None
        except Exception:
            log.warning("Could not read WireGuard container %s; check WIREGUARD_CONTAINER and Docker access.", WIREGUARD_CONTAINER)
        finally:
            if client is not None:
                client.close()

    status_file = Path("/host") / WIREGUARD_STATUS_FILE.lstrip("/")
    try:
        report = json.loads(status_file.read_text(encoding="utf-8"))
        generated = int(report.get("generated_at", 0))
        if not isinstance(report.get("peers"), list) or time.time() - generated > 180:
            return None, "unavailable"
        peers = []
        for peer in report["peers"][:100]:
            if not isinstance(peer, dict):
                continue
            peers.append({"name": str(peer.get("name") or "WireGuard peer")[:80],
                "ip": str(peer.get("ip") or "")[:64], "online": peer.get("online") is True,
                "last_seen": peer.get("last_seen") if isinstance(peer.get("last_seen"), str) else None,
                "received": int(peer.get("received", 0)) if isinstance(peer.get("received", 0), (int, float)) else 0,
                "sent": int(peer.get("sent", 0)) if isinstance(peer.get("sent", 0), (int, float)) else 0})
        return peers, None
    except (OSError, ValueError, TypeError):
        return None, "not_configured"


async def publish_loop():
    global last_success
    psutil.cpu_percent()
    host_metrics()
    await asyncio.sleep(1)
    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as http:
        while True:
            started = time.monotonic()
            try:
                host = host_metrics()
                containers, available, docker_error = await asyncio.to_thread(container_metrics)
                vpn_peers, vpn_status = wireguard_metrics()
                devices = await asyncio.to_thread(lan_devices)
                dns = await dns_metrics(http)
                response = await http.post(
                    DASHBOARD_URL + "/api/agent",
                    headers={"Authorization": "Bearer " + AGENT_TOKEN},
                    json={"host": host, "containers": containers, "docker_available": available, "docker_error": docker_error, "vpn_peers": vpn_peers, "vpn_error": vpn_status, "devices": devices, "dns": dns, "backup": backup_metrics()},
                )
                if response.status_code == 200:
                    last_success = time.time()
                    if not available:
                        log.warning("Host metrics are reporting, but Docker is unavailable (%s). Check DOCKER_GID, DOCKER_SOCKET and Docker service status.", docker_error)
                else:
                    log.warning("Dashboard rejected agent report (HTTP %s). Check the URL and token.", response.status_code)
            except Exception as error:
                log.warning("Agent report failed (%s); retrying next interval.", type(error).__name__)
            await asyncio.sleep(max(1, INTERVAL - (time.monotonic() - started)))


@asynccontextmanager
async def lifespan(app):
    parsed = urlparse(DASHBOARD_URL)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
        raise RuntimeError("Set DASHBOARD_URL to the HTTPS origin of your dashboard")
    if len(AGENT_TOKEN) < 32:
        raise RuntimeError("Set AGENT_TOKEN from the dashboard's Connect server screen")
    task = asyncio.create_task(publish_loop())
    try:
        yield
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


app = FastAPI(title="MTech Infra agent", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"agent": "running", "reporting": last_success is not None and time.time() - last_success < INTERVAL * 3}
