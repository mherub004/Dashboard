(() => {
  "use strict";
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const state = { authenticated: false, data: null, view: "overview", history: [], networkHistory: [], busy: false, draft: null, tab: "websites", connection: null, notes: {}, selectedDate: (()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0")})(), calendarMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1), extrasLoaded: false };
  let poll, toastTimer;
  const escape = v => String(v ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const bytes = value => {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    let n = Number(value), i = 0; const units = ["B", "KB", "MB", "GB", "TB"];
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n >= 100 ? 0 : 1) : n.toFixed(0)) + " " + units[i];
  };
  const duration = seconds => {
    const d = Math.floor(seconds / 86400), h = Math.floor(seconds / 3600) % 24, m = Math.floor(seconds / 60) % 60;
    return d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
  };
  const tone = s => ["Online", "running", "Operational"].includes(s) ? "" : ["Offline", "exited", "dead"].includes(s) ? "offline" : "degraded";
  const status = s => '<span class="status ' + tone(s) + '"><i class="dot ' + tone(s) + '"></i>' + escape(s) + "</span>";
  const empty = text => '<div class="empty">' + escape(text) + "</div>";
  const show = id => { const dialog = $(id); if (!dialog.open) dialog.showModal(); };
  const toast = message => { $("#toast").textContent = message; $("#toast").classList.add("visible"); clearTimeout(toastTimer); toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 3500); };
  async function api(path, options = {}) {
    const response = await fetch("/api/" + path, { ...options, credentials: "same-origin", headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
    let data; try { data = await response.json(); } catch { throw new Error("The dashboard API is unavailable. Please try again."); }
    if (!response.ok) { const error = new Error(data.detail || "The request could not be completed."); error.status = response.status; throw error; }
    return data;
  }
  function signInScreen() {
    state.authenticated = false; clearTimeout(poll);
    $$("dialog[open]").forEach(d => d.close());
    $("#loginForm").elements.password.value = "";
    $("#loginError").textContent = "";
    show("#loginDialog");
  }
  async function refresh() {
    clearTimeout(poll);
    if (!state.authenticated || state.busy || document.hidden) return;
    state.busy = true;
    $("#refresh").disabled = true;
    try {
      const data = await api("overview");
      state.data = data; render(); renderFeatures(data);
      $("#pageError").classList.add("hidden");
      $("#lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      $("#syncDot").className = "dot"; $("#syncLabel").textContent = "SYNCED";
    } catch (error) {
      if (error.status === 401) { location.reload(); return; }
      $("#pageError").textContent = error.message; $("#pageError").classList.remove("hidden");
      $("#syncDot").className = "dot offline"; $("#syncLabel").textContent = "OFFLINE";
      $("#lastUpdated").textContent = "Sync unavailable";
    } finally {
      state.busy = false; $("#refresh").disabled = false;
      if (state.authenticated) poll = setTimeout(refresh, 15000);
    }
  }
  function render() {
    const d = state.data; if (!d) return;
    const h = d.host, connected = d.agent_connected;
    $("#connectionLabel").textContent = connected ? "Server connected" : d.received_at ? "Server report is stale" : "Connect your server";
    $("#connectionSub").textContent = connected ? "Live telemetry active" : d.received_at ? "Check the agent on your host" : "Ready when you are";
    $("#serverDot").className = "dot " + (connected ? "" : d.received_at ? "offline" : "neutral");
    $("#agentBanner").classList.toggle("hidden", connected);
    $("#bannerTitle").textContent = d.received_at ? "Your server has stopped reporting" : "Bring your server into the picture";
    $("#bannerText").textContent = d.received_at ? "Last report: " + new Date(d.received_at * 1000).toLocaleString() + ". Values below are from that report." : "Connect the lightweight agent to see live CPU, memory, network and Docker metrics.";
    $("#cpuValue").innerHTML = (h ? Number(h.cpu).toFixed(1) : "—") + "<small>%</small>";
    $("#memoryValue").innerHTML = (h ? Number(h.memory).toFixed(1) : "—") + "<small>%</small>";
    $("#cpuContext").textContent = h ? h.name + (connected ? " · live" : " · last report") : "Waiting for your server";
    $("#memoryContext").textContent = h ? bytes(h.memory_used) + " of " + bytes(h.memory_total) : "Waiting for your server";
    $("#cpuBar").style.width = (h?.cpu || 0) + "%"; $("#memoryBar").style.width = (h?.memory || 0) + "%";
    $("#downValue").textContent = h ? bytes(h.network.down) : "—"; $("#upValue").textContent = h ? bytes(h.network.up) : "—";
    $("#networkBar").style.width = h ? Math.min(100, (h.network.up + h.network.down) / 20000) + "%" : "0%";
    $("#uptimeValue").textContent = h ? duration(h.uptime) : "—";
    $("#hostName").textContent = h ? h.name : "No server connected"; $("#uptimeBar").style.width = connected ? "100%" : "0%";
    if (h && connected && !state.history.some(p => p.at === d.received_at)) {
      state.history.push({ at: d.received_at, cpu: h.cpu, memory: h.memory }); if (state.history.length > 60) state.history.shift();
      state.networkHistory.push({ at:d.received_at, up:Number(h.network.up)||0, down:Number(h.network.down)||0 }); if(state.networkHistory.length>60)state.networkHistory.shift();
    }
    $("#chartEmpty").classList.toggle("hidden", state.history.length > 0);
    $("#chartNote").textContent = h ? bytes(h.disk_used) + " of " + bytes(h.disk_total) + " disk used · " + h.disk.toFixed(0) + "% · network: " + (h.network.interfaces || "host") : "Connect your server to start collecting telemetry.";
    if (state.history.length) $("#chartStart").textContent = new Date(state.history[0].at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    drawChart(); renderNetwork(d);
    const sites = d.websites || [], up = sites.filter(s => s.status === "Online").length;
    $("#siteCount").textContent = sites.length;
    $("#healthPercent").textContent = sites.length ? Math.round(up / sites.length * 100) + "%" : "—";
    $("#healthRing").style.strokeDashoffset = sites.length ? 195 - up / sites.length * 195 : 195;
    $("#healthCount").textContent = sites.length ? up + " of " + sites.length + " online" : "No websites yet";
    $("#healthList").innerHTML = sites.length ? sites.slice(0, 4).map(s => '<div class="health-row"><i class="dot ' + tone(s.status) + '"></i><span class="site-name">' + escape(s.name) + '</span><span class="latency">' + (s.latency == null ? "No response" : s.latency + " ms") + "</span></div>").join("") : empty("Add your first website to start monitoring.");
    const containers = d.containers || [];
    $("#containerCount").textContent = containers.length;
    $("#containerList").innerHTML = containers.length ? containers.slice(0, 4).map(c => '<div class="container-row"><span class="name"><i class="dot ' + tone(c.status) + '"></i>' + escape(c.name) + "</span>" + status(c.status) + '<span class="usage">' + (c.stats_available ? c.cpu.toFixed(1) + "% · " + bytes(c.memory) : "—") + "</span></div>").join("") : empty(connected ? d.docker_available ? "No Docker containers found." : ({permission_denied:"Docker socket access is blocked. Set DOCKER_GID to the socket group, then rebuild the agent.",socket_missing:"Docker socket not found. Check DOCKER_SOCKET or start Docker.",daemon_unreachable:"Docker daemon is not responding. Check Docker, then restart the agent."}[d.docker_error] || "Docker is unavailable. Check the agent logs.") : "Connect your agent to see containers.");
    $("#dockerStatus").textContent = connected ? d.docker_available ? containers.filter(c => c.status === "running").length + " running · " + containers.length + " total" : ({permission_denied:"Socket permission denied · check DOCKER_GID",socket_missing:"Docker socket missing · check DOCKER_SOCKET",daemon_unreachable:"Docker daemon unreachable · check Docker service"}[d.docker_error] || "Docker unavailable · check agent logs") : "Awaiting current server data";
    const services = d.services || [];
    $("#serviceList").innerHTML = services.length ? services.slice(0, 4).map((s, i) => '<div class="service-row"><span class="service-icon">' + ["✳", "◈", "◌", "◇"][i % 4] + "</span><div><b>" + escape(s.name) + "</b><small>" + escape(s.description) + "</small></div>" + status(s.status) + "</div>").join("") : empty("Add the services behind your infrastructure.");
    renderList();
  }
  function renderNetwork(d) {
    const h=d.host, net=h?.network||{}, dns=d.dns||{};
    $("#networkDown").textContent=bytes(net.down); $("#networkUp").textContent=bytes(net.up);
    $("#networkChartStart").textContent=state.networkHistory.length?new Date(state.networkHistory[0].at*1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"Waiting for telemetry";
    const interfaces=net.interface_stats||[];
    $("#interfaceRows").innerHTML=interfaces.length?interfaces.map(x=>"<tr><td>"+escape(x.name)+"</td><td class=network-down>↓ "+bytes(x.down)+"/s</td><td class=network-up>↑ "+bytes(x.up)+"/s</td><td>"+bytes(x.received)+"</td><td>"+bytes(x.sent)+"</td></tr>").join(""):'<tr><td colspan="5" class="network-empty">No interface counters reported. Check NETWORK_INTERFACES in the server agent.</td></tr>';
    const neighbors=d.devices||[], clientMap=new Map((dns.clients||[]).map(x=>[x.ip,x.count])), combined=new Map();
    neighbors.forEach(x=>combined.set(x.ip,{...x,queries:clientMap.get(x.ip)||0}));
    (dns.clients||[]).forEach(x=>{if(!combined.has(x.ip))combined.set(x.ip,{ip:x.ip,mac:"",interface:"",queries:x.count})});
    const devices=[...combined.values()];
    $("#lanDeviceCount").textContent=devices.length;
    $("#lanDeviceRows").innerHTML=devices.length?devices.map(x=>"<tr><td>"+escape(x.ip)+"</td><td>"+escape(x.mac||"—")+"</td><td>"+escape(x.interface||"—")+"</td><td>"+Number(x.queries||0).toLocaleString()+"</td><td><span class=network-badge>"+(x.mac?"Seen by server":"AdGuard DNS client")+"</span></td></tr>").join(""):'<tr><td colspan="5" class="network-empty">No devices reported yet. Enable AdGuard integration or wait for the server to see LAN neighbors.</td></tr>';
    $("#dnsAvailability").textContent=dns.available?"CONNECTED":"NOT CONFIGURED";
    $("#dnsAvailability").classList.toggle("network-ok",dns.available===true);
    $("#dnsQueries").textContent=dns.available?Number(dns.queries||0).toLocaleString():"—";
    $("#dnsBlocked").textContent=dns.available?Number(dns.blocked||0).toLocaleString():"—";
    $("#dnsDomains").innerHTML=dns.available&&dns.domains?.length?dns.domains.map(x=>"<div class=dns-domain><span>"+escape(x.domain)+"</span><b>"+Number(x.count||0).toLocaleString()+"</b></div>").join(""):empty(dns.available?"AdGuard has no domain history yet.":"Set AdGuard connection details in the server agent .env file.");
    const peers=d.vpn_peers||[];
    $("#networkVpnCount").textContent=Array.isArray(peers)?String(peers.length):"—";
    $("#networkPeerRows").innerHTML=Array.isArray(peers)&&peers.length?peers.map(p=>"<tr><td>"+escape(p.name)+"</td><td>"+escape(p.ip||"—")+"</td><td>"+escape(p.last_seen?new Date(p.last_seen).toLocaleString():"Never")+"</td><td>"+bytes(p.received)+"</td><td>"+bytes(p.sent)+"</td><td><span class=network-badge>"+(p.online?"Recent handshake":"Inactive")+"</span></td></tr>").join(""):'<tr><td colspan="6" class="network-empty">No WireGuard peers reported. Check the host WireGuard helper.</td></tr>';
    drawNetworkChart(); drawDnsChart(dns);
  }
  function drawNetworkChart() {
    const canvas=$("#networkChart"),rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const ratio=window.devicePixelRatio||1;canvas.width=Math.floor(rect.width*ratio);canvas.height=Math.floor(rect.height*ratio);
    const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);ctx.clearRect(0,0,rect.width,rect.height);
    const points=state.networkHistory,max=Math.max(1,...points.flatMap(p=>[p.up,p.down]));
    for(const [key,color] of [["down","#278ebc"],["up","#8e6cd4"]]){if(!points.length)continue;ctx.beginPath();points.forEach((p,i)=>{const x=points.length<2?rect.width/2:i/(points.length-1)*rect.width,y=rect.height-5-(p[key]/max)*(rect.height-12);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle=color;ctx.lineWidth=2.5;ctx.stroke();}
  }
  function drawDnsChart(dns) {
    const canvas=$("#dnsChart"),rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
    const ratio=window.devicePixelRatio||1;canvas.width=Math.floor(rect.width*ratio);canvas.height=Math.floor(rect.height*ratio);
    const ctx=canvas.getContext("2d");ctx.scale(ratio,ratio);ctx.clearRect(0,0,rect.width,rect.height);
    const values=dns.query_history||[],max=Math.max(1,...values),gap=3,w=rect.width/Math.max(values.length,1);
    values.forEach((v,i)=>{const bh=(v/max)*(rect.height-4);ctx.fillStyle="#2c9ec6";ctx.globalAlpha=.45+(i/Math.max(1,values.length))*.55;ctx.fillRect(i*w+gap/2,rect.height-bh,Math.max(1,w-gap),bh)});ctx.globalAlpha=1;
  }
  function drawChart() {
    const canvas = $("#chart"), rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * ratio); canvas.height = Math.floor(rect.height * ratio);
    const ctx = canvas.getContext("2d"); ctx.scale(ratio, ratio);
    for (const [key, color] of [["cpu", "#f29387"], ["memory", "#b89cf6"]]) {
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round";
      const points = state.history.map((p, i) => [state.history.length === 1 ? rect.width / 2 : i / (state.history.length - 1) * rect.width, 2 + (1 - p[key] / 100) * (rect.height - 4)]);
      if (points.length === 1) { ctx.beginPath(); ctx.arc(points[0][0], points[0][1], 3, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.beginPath(); points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); }
    }
  }

  const weatherText = code => ({0:"Clear sky",1:"Mostly clear",2:"Partly cloudy",3:"Overcast",45:"Foggy",48:"Icy fog",51:"Light drizzle",53:"Drizzle",55:"Heavy drizzle",61:"Light rain",63:"Rain",65:"Heavy rain",71:"Light snow",73:"Snow",75:"Heavy snow",80:"Rain showers",81:"Rain showers",82:"Heavy showers",95:"Thunderstorms",96:"Thunderstorms",99:"Severe thunderstorms"})[code] || "Conditions updated";
  const weatherIcon = code => code === 0 ? "☀" : [1,2].includes(code) ? "⛅" : [71,73,75].includes(code) ? "❄" : [95,96,99].includes(code) ? "ϟ" : "☂";
  async function loadWeather() {
    try {
      const w = await api("weather"), c = w.current, d = w.daily;
      $("#weatherTemp").textContent = Math.round(c.temperature_2m) + "°";
      $("#weatherSummary").textContent = weatherText(c.weather_code);
      $(".weather-icon").textContent = weatherIcon(c.weather_code);
      const hourIndex = w.hourly.time.indexOf(c.time);
      const rainChance = hourIndex >= 0 ? w.hourly.precipitation_probability[hourIndex] : d.precipitation_probability_max[0];
      $("#weatherRain").textContent = "Rain chance " + (rainChance ?? 0) + "%";
      $("#weatherHighLow").textContent = "Today " + Math.round(d.temperature_2m_max[0]) + "° / " + Math.round(d.temperature_2m_min[0]) + "°";
      $("#weatherForecast").innerHTML = d.time.slice(1).map((day,i)=>'<div><small>'+new Date(day+"T12:00:00").toLocaleDateString("en",{weekday:"short"})+'</small><span>'+weatherIcon(d.weather_code[i+1])+'</span><b>'+Math.round(d.temperature_2m_max[i+1])+'°</b></div>').join("");
    } catch { $("#weatherSummary").textContent = "Forecast temporarily unavailable"; }
  }
  async function loadGitActivity() {
    try {
      const r = await fetch("https://api.github.com/repos/mherub004/Dashboard/commits?per_page=4"); if (!r.ok) throw new Error();
      const commits = await r.json();
      $("#gitActivity").innerHTML = commits.map(c=>'<a class="feed-item" href="'+escape(c.html_url)+'" target="_blank" rel="noopener noreferrer"><i class="feed-dot"></i><span><b>'+escape((c.commit.message.split("\n")[0]||"Commit").slice(0,90))+'</b><small>'+escape(c.commit.author?.name||"GitHub")+" · "+escape(new Date(c.commit.author?.date||Date.now()).toLocaleDateString())+'</small></span><code>'+escape(c.sha.slice(0,7))+'</code></a>').join("") || empty("No recent commits found.");
    } catch { $("#gitActivity").innerHTML = '<div class="empty">GitHub activity is temporarily unavailable.</div>'; }
  }
  function renderCalendar() {
    const month = state.calendarMonth, year = month.getFullYear(), m = month.getMonth();
    $("#calendarMonth").textContent = month.toLocaleDateString("en",{month:"long",year:"numeric"});
    const first = (new Date(year,m,1).getDay()+6)%7, count = new Date(year,m+1,0).getDate(), nowDate = new Date(), today = nowDate.getFullYear()+"-"+String(nowDate.getMonth()+1).padStart(2,"0")+"-"+String(nowDate.getDate()).padStart(2,"0");
    $("#calendarDays").innerHTML = Array.from({length:Math.ceil((first+count)/7)*7},(_,i)=>{
      const day=i-first+1; if(day<1||day>count)return '<span class="calendar-blank"></span>';
      const date=year+"-"+String(m+1).padStart(2,"0")+"-"+String(day).padStart(2,"0");
      return '<button type="button" class="calendar-day'+(date===state.selectedDate?" selected":"")+(date===today?" today":"")+(state.notes[date]?" has-note":"")+'" data-date="'+date+'">'+day+'</button>';
    }).join("");
    $("#noteDateLabel").textContent = new Date(state.selectedDate+"T12:00:00").toLocaleDateString("en",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
    $("#dayNote").value = state.notes[state.selectedDate] || "";
  }
  function renderFeatures(d) {
    const sites=d.websites||[];
    $("#shortcutGrid").innerHTML=sites.length?sites.map((s,i)=>'<a class="shortcut" href="'+escape(s.url)+'" target="_blank" rel="noopener noreferrer"><span class="shortcut-icon tone-'+(i%4)+'">'+escape((s.name||"↗").slice(0,1).toUpperCase())+'</span><b>'+escape(s.name)+'</b><small><i class="dot '+tone(s.status)+'"></i>'+escape(s.status)+'</small></a>').join(""):empty("Add websites in Manage setup to build your launcher.");
    const h=d.host;
    $("#storagePercent").textContent=h?Math.round(h.disk)+"%":"—";
    $("#storageUsed").textContent=h?bytes(h.disk_used)+" used":"Waiting for server";
    $("#storageTotal").textContent=h?bytes(h.disk_total)+" total · OS filesystem":"Disk usage updates with server telemetry.";
    $("#storageRing").style.setProperty("--used",h?Math.min(100,h.disk)+"%":"0%");
    const peers=d.vpn_peers;
    $("#vpnPeerCount").textContent=Array.isArray(peers)?peers.filter(p=>p.online).length+" recent":"—";
    $("#vpnPeerList").innerHTML=Array.isArray(peers)?(peers.length?peers.map(p=>'<div class="peer-row"><i class="dot '+(p.online?"":"offline")+'"></i><span><b>'+escape(p.name)+'</b><small>'+escape(p.ip||"No IP reported")+'</small></span><em>'+escape(p.online?"Recent handshake":p.last_seen?"Last handshake "+new Date(p.last_seen).toLocaleString():"No handshake yet")+'</em></div>').join(""):empty("No peers are listed on the host WireGuard interfaces.")):'<div class="integration-empty"><span class="integration-badge">'+(d.vpn_error==="unavailable"?"CHECK WIREGUARD HELPER":"AGENT SETUP NEEDED")+'</span><p>'+(d.vpn_error==="unavailable"?"The agent cannot read the WireGuard snapshot. Check the host helper and file path.":"Install the WireGuard status helper on the host to see peer IPs and latest handshakes.")+'</p></div>';
    const backupTime=d.backup?.last_success;
    const backupAge=backupTime?Math.floor(Date.now()/1000-backupTime):null;
    $("#backupStatus").textContent=backupTime?"Last success · "+(backupAge<3600?Math.max(1,Math.floor(backupAge/60))+"m ago":backupAge<86400?Math.floor(backupAge/3600)+"h ago":Math.floor(backupAge/86400)+"d ago"):d.backup?"Marker file not found":"Not configured";
    const backupDot=$("#backupStatus").previousElementSibling;
    backupDot.className="dot "+(backupAge==null?"neutral":backupAge<86400?"":"offline");
    const history=d.backup_history||[];
    $("#backupTimeline").innerHTML=history.length?'<div class="backup-history-title">RECENT SUCCESSFUL BACKUPS</div>'+history.slice(0,5).map(t=>'<div class="backup-event"><i></i><span>'+escape(new Date(t*1000).toLocaleString())+'</span></div>').join(""):empty("Configure a backup success marker to start the timeline.");
    if(!state.extrasLoaded){state.extrasLoaded=true;renderCalendar();loadWeather();loadGitActivity();api("notes").then(x=>{state.notes=x.notes||{};renderCalendar()}).catch(()=>{});}
  }
  function setView() {
    const view = location.hash.slice(1);
    state.view = ["websites", "containers", "services", "network", "planner"].includes(view) ? view : "overview";
    const titles = { overview: "Overview", websites: "Websites & domains", containers: "Docker containers", services: "Services", network: "Home network", planner: "Calendar & notes" };
    $$(".nav-item").forEach(a => a.classList.toggle("active", a.dataset.view === state.view));
    $("#crumb").textContent = titles[state.view];
    $("#pageTitle").innerHTML = state.view === "overview" ? "Your infrastructure, <span>in focus.</span>" : escape(titles[state.view]) + " <span>at a glance.</span>";
    $("#pageSubtitle").textContent = state.view === "overview" ? "Everything running behind your work. Right now." : { websites: "Know when your websites are reachable.", containers: "A clear view of every workload on your server.", services: "Keep your infrastructure services organized.", planner: "Plan ahead and keep notes for each day.", network: "Live server traffic, DNS, LAN devices and WireGuard peers." }[state.view];
    $("#overviewView").classList.toggle("hidden", !["overview", "planner"].includes(state.view)); $("#listView").classList.toggle("hidden", ["overview", "planner", "network"].includes(state.view)); $("#networkView").classList.toggle("hidden", state.view !== "network");
    $(".feature-grid > .panel").forEach(panel => panel.classList.toggle("hidden", state.view === "planner" && !panel.classList.contains("planner-panel")));
    $("#sidebar").classList.remove("open"); $("#mobileMenu").setAttribute("aria-expanded", "false");
    renderList(); requestAnimationFrame(()=>{drawChart();drawNetworkChart();drawDnsChart(state.data?.dns||{})});
  }
  function renderList() {
    if (["overview", "planner"].includes(state.view)) return;
    const config = {
      websites: ["MONITORED ENDPOINTS", "Websites & domains", "Public HTTP checks run while this dashboard is open.", "＋ Add website"],
      containers: ["DOCKER RUNTIME", "Containers", "Container status and resource usage from your latest server report.", ""],
      services: ["YOUR STACK", "Services", "Service descriptions and status are managed by you.", "＋ Add service"]
    }[state.view];
    $("#listKicker").textContent = config[0]; $("#listTitle").textContent = config[1]; $("#listDescription").textContent = config[2]; $("#listAdd").textContent = config[3]; $("#listAdd").classList.toggle("hidden", !config[3]);
    const rows = state.data?.[state.view] || [];
    if (!rows.length) { $("#listTable").innerHTML = empty(state.view === "containers" ? "No containers to display. Connect your agent and check Docker access." : "Nothing here yet. Add your first entry."); return; }
    const headings = state.view === "websites" ? ["NAME", "ADDRESS", "STATUS", "RESPONSE"] : state.view === "containers" ? ["CONTAINER", "IMAGE", "STATUS", "RESOURCES"] : ["NAME", "DESCRIPTION", "STATUS"];
    $("#listTable").innerHTML = "<table><thead><tr>" + headings.map(h => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" + rows.map(r => {
      const details = state.view === "websites" ? '<a href="' + escape(r.url) + '" target="_blank" rel="noopener noreferrer">' + escape(r.url) + "</a>" : escape(state.view === "containers" ? r.image : r.description);
      const extra = state.view === "websites" ? (r.code ? "HTTP " + r.code : "—") + (r.latency != null ? " · " + r.latency + " ms" : "") : r.stats_available ? r.cpu.toFixed(1) + "% · " + bytes(r.memory) : "—";
      return "<tr><td>" + escape(r.name) + '</td><td class="table-url">' + details + "</td><td>" + status(r.status) + "</td>" + (state.view !== "services" ? "<td>" + extra + "</td>" : "") + "</tr>";
    }).join("") + "</tbody></table>";
  }
  async function openEditor(tab = "websites") {
    try {
      state.draft = await api("config"); state.tab = tab;
      $("#editorError").textContent = ""; drawEditor(); show("#editorDialog");
    } catch (error) { toast(error.message); }
  }
  function readDraft() {
    state.draft[state.tab] = $$("#editorRows .editor-row").map(row => {
      const values = Object.fromEntries([...row.querySelectorAll("[data-field]")].map(input => [input.dataset.field, input.value]));
      return values;
    });
  }
  function drawEditor() {
    $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === state.tab));
    $("#editorAdd").textContent = state.tab === "websites" ? "＋ Add website" : "＋ Add service";
    $("#editorRows").innerHTML = state.draft[state.tab].map((entry, i) => {
      const website = state.tab === "websites", options = website ? ["Website", "Domain"] : ["Operational", "Maintenance", "Degraded"];
      return '<div class="editor-row"><label>Name<input data-field="name" value="' + escape(entry.name) + '" maxlength="80" required></label><label>' + (website ? "Website address" : "Description") + '<input data-field="' + (website ? "url" : "description") + '" value="' + escape(website ? entry.url : entry.description) + '" ' + (website ? 'type="url" placeholder="https://example.com" required' : 'maxlength="160"') + "></label><label>" + (website ? "Type" : "Status") + '<select data-field="' + (website ? "kind" : "status") + '">' + options.map(o => "<option" + ((website ? entry.kind : entry.status) === o ? " selected" : "") + ">" + o + "</option>").join("") + '</select></label><button class="remove-row" type="button" data-remove="' + i + '" aria-label="Remove ' + escape(entry.name || "entry") + '">×</button></div>';
    }).join("");
  }
  async function openConnection() {
    try {
      state.connection = await api("connection"); $("#agentToken").value = state.connection.agent_token || "";
      show("#connectDialog");
    } catch (error) { toast(error.message); }
  }
  $("#loginDialog").addEventListener("cancel", event => event.preventDefault());
  $("#loginForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector("button");
    button.disabled = true; $("#loginError").textContent = "";
    try {
      await api("login", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      form.elements.password.value = ""; state.authenticated = true; $("#loginDialog").close(); await refresh();
    } catch (error) { $("#loginError").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#editorForm").addEventListener("submit", async event => {
    event.preventDefault(); readDraft(); const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true; $("#editorError").textContent = "";
    try { await api("config", { method: "PUT", body: JSON.stringify(state.draft) }); $("#editorDialog").close(); toast("Workspace setup saved"); await refresh(); }
    catch (error) { $("#editorError").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#editorAdd").addEventListener("click", () => {
    readDraft(); state.draft[state.tab].push(state.tab === "websites" ? { name: "", url: "", kind: "Website" } : { name: "", description: "", status: "Operational" });
    drawEditor(); $("#editorRows").lastElementChild?.querySelector("input")?.focus();
  });
  $("#editorRows").addEventListener("click", event => {
    const remove = event.target.closest("[data-remove]"); if (!remove) return;
    readDraft(); state.draft[state.tab].splice(Number(remove.dataset.remove), 1); drawEditor();
  });
  $$(".tab").forEach(tab => tab.addEventListener("click", () => { readDraft(); state.tab = tab.dataset.tab; drawEditor(); }));
  $("#addService").addEventListener("click", () => openEditor("services"));
  $("#listAdd").addEventListener("click", () => openEditor(state.view === "services" ? "services" : "websites"));
  $("#copyAgent").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText("DASHBOARD_URL=" + state.connection.dashboard_url + "\nAGENT_TOKEN=" + state.connection.agent_token + "\n");
      toast("Connection settings copied");
    } catch { toast("Copy unavailable. Your token is selected for manual copying."); $("#agentToken").type = "text"; $("#agentToken").select(); }
  });
  $("#connectDialog").addEventListener("close", () => { state.connection = null; $("#agentToken").value = ""; $("#agentToken").type = "password"; });
  $("#passwordForm").addEventListener("submit", async event => {
    event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form)), button = form.querySelector("button");
    $("#passwordError").textContent = "";
    if (data.new_password !== data.confirm_password) { $("#passwordError").textContent = "The new passwords do not match."; return; }
    button.disabled = true;
    try { await api("password", { method: "POST", body: JSON.stringify(data) }); form.reset(); location.reload(); }
    catch (error) { $("#passwordError").textContent = error.message; }
    finally { button.disabled = false; }
  });
  $("#logout").addEventListener("click", async () => {
    try { await api("logout", { method: "POST", body: "{}" }); location.reload(); }
    catch (error) { toast(error.message); }
  });
  document.addEventListener("click", event => {
    const close = event.target.closest("[data-close]"); if (close) close.closest("dialog").close();
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "manage") openEditor();
    if (action === "connect") openConnection();
    if (action === "account") { $("#passwordError").textContent = ""; $("#passwordForm").reset(); show("#accountDialog"); }
  });
  $("#refresh").addEventListener("click", refresh);
  $("#monthPrev").addEventListener("click",()=>{state.calendarMonth=new Date(state.calendarMonth.getFullYear(),state.calendarMonth.getMonth()-1,1);renderCalendar()});
  $("#monthNext").addEventListener("click",()=>{state.calendarMonth=new Date(state.calendarMonth.getFullYear(),state.calendarMonth.getMonth()+1,1);renderCalendar()});
  $("#calendarDays").addEventListener("click",e=>{const day=e.target.closest("[data-date]");if(!day)return;state.selectedDate=day.dataset.date;renderCalendar()});
  $("#saveNote").addEventListener("click",async()=>{const note=$("#dayNote").value.trim();try{await api("notes",{method:"PUT",body:JSON.stringify({date:state.selectedDate,note})});if(note)state.notes[state.selectedDate]=note;else delete state.notes[state.selectedDate];renderCalendar();toast("Note saved");}catch(e){toast(e.message)}});
  $("#mobileMenu").addEventListener("click", () => { const open = $("#sidebar").classList.toggle("open"); $("#mobileMenu").setAttribute("aria-expanded", String(open)); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); else clearTimeout(poll); });
  window.addEventListener("resize", drawChart); window.addEventListener("hashchange", setView);
  $("#today").textContent = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric" }).format(new Date()).toUpperCase();
  setView();
  (async () => {
    try { const user = await api("session"); if (user.authenticated) { $("#loginDialog").close(); state.authenticated = true; await refresh(); } else signInScreen(); }
    catch (error) { signInScreen(); $("#loginError").textContent = error.message; }
  })();
})();
