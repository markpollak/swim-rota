/* Arc Swim Rota — single-page PWA front end (vanilla JS).
   Sections: api/state, helpers, login, shell+nav, views (home/calendar/myshifts/
   approvals/reports/manage/profile), modals, boot. */
"use strict";

// ------------------------------------------------------------------ state/api
const State = {
  token: localStorage.getItem("swim_token") || null,
  user: null,
  roles: [],
  levels: [],
  serverDate: null,
  view: "home",
  // calendar
  weekStart: null,
  selectedDate: null,
  calendarFilter: null,      // null = my-roles default; role_id = that role; 'all' = everything
  calendarLevelFilter: null, // null = all; 'duty' = pool duty; number = level_id
  calendarView: "week",      // "day" | "week"
  // my shifts
  myTab: "upcoming",
  // admin
  manageTab: "users",
  reportTab: "outstanding",
  rotaRole: null,        // role_id being built in rota builder
  _adminDayDate: null,   // selected date in admin day view
  _homeWeekStart: null,  // week being viewed on home grid
  notifUnread: 0,
  // messaging
  activeChannel: null,   // channel id currently open
  msgUnread: 0,          // badge count
  _evtSource: null,      // SSE EventSource
  _channels: [],         // cached channel list
};

async function api(path, { method = "GET", body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (State.token) headers.Authorization = "Bearer " + State.token;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    logout(true);
    throw new Error("Session expired — please sign in again.");
  }
  if (res.headers.get("content-type")?.includes("text/csv")) return res;
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Something went wrong.");
  return data;
}

// ------------------------------------------------------------------ helpers
const $ = (sel, el = document) => el.querySelector(sel);
const app = () => document.getElementById("app");
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoToday() { return State.serverDate || new Date().toISOString().slice(0, 10); }
function parseISO(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function toISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function mondayOf(d) { const x = new Date(d); const wd = (x.getDay() + 6) % 7; x.setDate(x.getDate() - wd); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function fmtDate(iso) { const d = parseISO(iso); return `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${MON[d.getMonth()]}`; }
function fmtLong(iso) { const d = parseISO(iso); return `${DOW[(d.getDay() + 6) % 7]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; }

let toastTimer;
function toast(msg, kind = "") {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.className = kind; t.textContent = msg;
  requestAnimationFrame(() => t.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function roleColor(roleId) { return State.roles.find((r) => r.id === roleId)?.color || "#26358B"; }
function roleName(roleId) { return State.roles.find((r) => r.id === roleId)?.name || ""; }
function userHasRole(roleId) { return State.user?.roles?.some((r) => r.id === roleId); }

// ------------------------------------------------------------------ login
function renderLogin(errMsg) {
  app().innerHTML = `
    <div class="login-wrap">
      <div class="login-logo">
        <img src="/static/icon-512.png" alt="Arc Swim Rota" />
        <h1>Arc Swim Rota</h1>
        <p>The Arc, Matlock · Freedom Leisure</p>
      </div>
      ${errMsg ? `<div class="banner danger">${esc(errMsg)}</div>` : ""}
      <form id="loginForm" class="card stack">
        <div class="field">
          <label>Username</label>
          <input id="lf-user" autocomplete="username" autocapitalize="none" placeholder="e.g. emma" required />
        </div>
        <div class="field">
          <label>Password</label>
          <input id="lf-pass" type="password" autocomplete="current-password" placeholder="Your password" required />
        </div>
        <button class="btn block" type="submit">Sign in</button>
      </form>
      <div class="demo-creds">
        <strong>Demo logins</strong><br/>
        Admin: <code>admin</code> / <code>admin123</code><br/>
        Staff: <code>emma</code>, <code>james</code>, <code>grace</code>… / <code>password</code>
      </div>
    </div>`;
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#loginForm button");
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const data = await api("/api/login", {
        method: "POST",
        body: { username: $("#lf-user").value, password: $("#lf-pass").value },
      });
      State.token = data.token;
      localStorage.setItem("swim_token", data.token);
      await boot();
    } catch (err) {
      renderLogin(err.message);
    }
  });
}

function logout(silent) {
  disconnectSSE();
  State.token = null; State.user = null;
  localStorage.removeItem("swim_token");
  if (!silent) renderLogin();
  else renderLogin("Your session has expired. Please sign in again.");
}

// ------------------------------------------------------------------ SSE (live messages)
function connectSSE() {
  disconnectSSE();
  if (!State.token) return;
  const src = new EventSource(`/api/messages/stream?token=${encodeURIComponent(State.token)}`);
  State._evtSource = src;
  src.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleLiveMessage(msg);
    } catch {}
  };
  src.onerror = () => {
    // EventSource auto-reconnects; we just log in dev
  };
}

function disconnectSSE() {
  if (State._evtSource) { State._evtSource.close(); State._evtSource = null; }
}

function handleLiveMessage(msg) {
  if (msg.deleted) {
    const bubble = document.querySelector(`[data-mid="${msg.id}"]`);
    if (bubble) bubble.remove();
    return;
  }
  if (State.view === "messages" && State.activeChannel === msg.channel_id) {
    appendBubble(msg);
    scrollChatBottom();
    // Mark as read immediately since the user is looking at it
    if (msg.user_id !== State.user?.id) {
      api(`/api/channels/${msg.channel_id}/read`, { method: "POST" }).catch(() => {});
    }
  } else {
    if (msg.user_id !== State.user?.id) {
      updateMsgBadge(1);
      // Increment per-channel unread in cache and update badge in DOM if visible
      const ch = State._channels.find((c) => c.id === msg.channel_id);
      if (ch) {
        ch.unread = (ch.unread || 0) + 1;
        const badge = document.querySelector(`[data-ch-unread="${msg.channel_id}"]`);
        if (badge) {
          badge.textContent = ch.unread > 99 ? "99+" : ch.unread;
        } else {
          const row = document.querySelector(`[data-ch="${msg.channel_id}"] .between`);
          if (row) {
            const b = document.createElement("span");
            b.className = "ch-unread";
            b.dataset.chUnread = msg.channel_id;
            b.textContent = ch.unread;
            row.appendChild(b);
          }
        }
      }
    }
  }
  const preview = document.querySelector(`[data-ch-preview="${msg.channel_id}"]`);
  if (preview) preview.textContent = msg.body.slice(0, 60);
}

// ------------------------------------------------------------------ shell
const NAV = [
  { id: "home",     icon: "🏠",  label: "Home" },
  { id: "calendar", icon: "📅",  label: "Shifts" },
  { id: "messages", icon: "💬",  label: "Messages" },
  { id: "admin",    icon: "🛠️", label: "Admin", adminOnly: true },
  { id: "profile",  icon: "👤",  label: "Me" },
];

function renderShell() {
  const nav = NAV.filter((n) => !n.adminOnly || State.user.is_admin);
  app().innerHTML = `
    <header class="topbar">
      <div class="logo"><img src="/static/icon-192.png" alt=""/> Arc Swim Rota</div>
      <div class="spacer"></div>
      <button class="iconbtn" id="notifBtn" aria-label="Notifications">🔔${
        State.notifUnread ? `<span class="dot">${State.notifUnread}</span>` : ""
      }</button>
    </header>
    <main class="app-main" id="screen"></main>
    <nav class="bottomnav">
      ${nav.map((n) => `
        <button data-nav="${n.id}" class="${State.view === n.id ? "active" : ""}">
          <span class="ico">${n.icon}</span>
          <span class="nav-label">${n.label}${n.id === "messages" && State.msgUnread
            ? `<span class="nav-badge">${State.msgUnread > 99 ? "99+" : State.msgUnread}</span>`
            : ""}</span>
        </button>`).join("")}
    </nav>`;
  app().querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => go(b.dataset.nav)));
  $("#notifBtn").addEventListener("click", openNotifications);
  renderView();
}

function updateMsgBadge(delta) {
  State.msgUnread = Math.max(0, (State.msgUnread || 0) + delta);
  const label = document.querySelector('[data-nav="messages"] .nav-label');
  if (!label) return;
  let badge = label.querySelector(".nav-badge");
  if (State.msgUnread > 0) {
    if (!badge) { badge = document.createElement("span"); badge.className = "nav-badge"; label.appendChild(badge); }
    badge.textContent = State.msgUnread > 99 ? "99+" : State.msgUnread;
  } else { badge?.remove(); }
}

function go(view) {
  State.view = view;
  app().querySelectorAll("[data-nav]").forEach((b) =>
    b.classList.toggle("active", b.dataset.nav === view));
  renderView();
}

function screen() { return document.getElementById("screen"); }
function loading() { screen().innerHTML = `<div class="spinner"></div>`; }

function renderView() {
  switch (State.view) {
    case "home":     return viewHome();
    case "calendar": return viewCalendar();
    case "myshifts": return viewMyShifts();
    case "messages": return viewMessages();
    case "admin":    return viewAdmin();
    case "profile":  return viewProfile();
  }
}

// ------------------------------------------------------------------ slot grouping + cards
function groupSlots(slots) {
  // group into class cards keyed by date|start|level
  const map = new Map();
  for (const s of slots) {
    const isDuty = s.level_id == null;
    const key = isDuty
      ? `${s.date}|${s.start_time}|duty`
      : `${s.date}|${s.start_time}|${s.level_id}`;
    if (!map.has(key)) {
      map.set(key, {
        date: s.date, start: s.start_time, end: s.end_time,
        level_id: s.level_id, level_name: s.level_name,
        isDuty, slots: [],
      });
    }
    map.get(key).slots.push(s);
  }
  return [...map.values()].sort((a, b) => a.start.localeCompare(b.start));
}

function statusPill(s) {
  if (s.status === "approved") return `<span class="pill approved">✓ Approved</span>`;
  if (s.status === "requested") return `<span class="pill requested">⏳ Pending</span>`;
  return `<span class="pill open">Open</span>`;
}

function slotActions(s) {
  const today = isoToday();
  const mine = s.assigned_user_id === State.user.id;
  const future = s.date >= today;
  const acts = [];
  if (s.status === "open" && future) {
    if (userHasRole(s.role_id) || State.user.is_admin) {
      acts.push(`<button class="btn green sm" data-act="request" data-id="${s.id}">Request</button>`);
    }
  }
  if (mine && (s.status === "requested" || s.status === "approved") && future) {
    const label = s.status === "requested" ? "Cancel" : "Release";
    acts.push(`<button class="btn danger sm" data-act="release" data-id="${s.id}">${label}</button>`);
  }
  return acts.join("");
}

function classCard(g, showTime = true) {
  const color = roleColor(g.slots[0].role_id);
  const title = g.isDuty ? "Pool Lifeguard" : g.level_name;
  const sub = g.isDuty ? "On duty — whole session" : "";
  const rows = g.slots.map((s) => `
    <div class="slotrow">
      <div class="who">
        <span class="role" style="color:${roleColor(s.role_id)}">${esc(roleName(s.role_id))}</span>
        ${s.assigned_name ? `· <span class="name">${esc(s.assigned_name)}</span>` : ""}
      </div>
      <div class="act">${statusPill(s)} ${slotActions(s)}</div>
    </div>`).join("");
  return `
    <div class="classcard" style="border-left-color:${color}" data-card>
      <div class="ch">
        <div><span class="t">${esc(title)}</span>${sub ? ` <span class="muted small">· ${esc(sub)}</span>` : ""}</div>
        ${showTime ? `<span class="time">${g.start}–${g.end}</span>` : ""}
      </div>
      ${rows}
    </div>`;
}

function bindSlotActions(root) {
  root.querySelectorAll("[data-act]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = b.dataset.id, act = b.dataset.act;
      b.disabled = true;
      try {
        if (act === "request") {
          await api(`/api/slots/${id}/request`, { method: "POST" });
          toast("Requested — awaiting approval", "ok");
        } else if (act === "release") {
          if (!confirm("Release this shift? It will become available for others.")) { b.disabled = false; return; }
          await api(`/api/slots/${id}/release`, { method: "POST" });
          toast("Shift released", "ok");
        }
        await refreshNotif();
        renderView();
      } catch (err) { toast(err.message, "err"); b.disabled = false; }
    }));
}

// ------------------------------------------------------------------ HOME
async function viewHome() {
  loading();
  const today = isoToday();
  if (!State._homeWeekStart) State._homeWeekStart = mondayOf(parseISO(today));
  const weekISO = toISO(State._homeWeekStart);
  const weekEnd = toISO(addDays(State._homeWeekStart, 6));

  let allSlots = [], pending = [];
  try {
    allSlots = await api(`/api/slots?from=${weekISO}&to=${weekEnd}`);
    if (State.user.is_admin) pending = await api(`/api/slots?pending=1&from=${today}`);
  } catch (err) { toast(err.message, "err"); }

  const mySlots = allSlots.filter((s) => s.assigned_user_id === State.user.id && s.status !== "open");
  const openCount = allSlots.filter((s) => s.status === "open" && (userHasRole(s.role_id) || State.user.is_admin)).length;

  const ts = State.user.training_status;
  let trainingBanner = "";
  if (ts === "expired" || ts === "missing")
    trainingBanner = `<div class="banner danger">⚠️ Your lifeguard training is ${ts}. <a href="#" data-goto="profile">Update now</a></div>`;
  else if (ts === "expiring")
    trainingBanner = `<div class="banner warn">⏰ Training expires ${fmtDate(State.user.training_expiry)} — renew soon.</div>`;

  const weekLabel = `${fmtDate(weekISO).slice(4)} – ${fmtDate(weekEnd).slice(4)}`;

  screen().innerHTML = `
    <h1 class="section-title" style="margin-bottom:10px">Hi ${esc(State.user.full_name.split(" ")[0])} 👋</h1>
    ${trainingBanner}
    ${State.user.is_admin && pending.length ? `
      <div class="banner info between">
        <span>📋 ${pending.length} request${pending.length > 1 ? "s" : ""} awaiting approval.</span>
        <a href="#" data-goto="admin">Review</a>
      </div>` : ""}
    <div class="between" style="margin-bottom:8px">
      <strong style="font-size:.95rem">My shifts</strong>
      <div style="display:flex;align-items:center;gap:6px">
        <button class="btn sub sm" id="hwPrev" style="padding:5px 10px">‹</button>
        <span class="small muted" style="white-space:nowrap">${weekLabel}</span>
        <button class="btn sub sm" id="hwNext" style="padding:5px 10px">›</button>
      </div>
    </div>
    <div id="homeGrid"></div>
    <div class="grid2" style="margin-top:12px">
      <div class="card center" data-goto="myshifts" style="cursor:pointer;margin-bottom:0;padding:12px">
        <div class="statnum" style="font-size:1.25rem">${mySlots.length}</div>
        <div class="small muted">This week</div>
      </div>
      <div class="card center" data-goto="calendar" style="cursor:pointer;margin-bottom:0;padding:12px">
        <div class="statnum" style="font-size:1.25rem;color:var(--magenta)">${openCount}</div>
        <div class="small muted">Open to grab</div>
      </div>
    </div>
  `;

  renderHomeGrid(mySlots, State._homeWeekStart);

  document.getElementById("hwPrev").onclick = () => { State._homeWeekStart = addDays(State._homeWeekStart, -7); viewHome(); };
  document.getElementById("hwNext").onclick = () => { State._homeWeekStart = addDays(State._homeWeekStart, 7); viewHome(); };
  bindGoto(screen());
}

// ---- Shared compact week grid (days = columns, shifts stacked under each day) ----
function shiftBadge(s) {
  // Lifeguard duty → red life-ring icon; a class → short level code (L1, P&T…)
  if (!s.level_id) return `<span class="ms-lg-icon" title="Pool Lifeguard">🛟</span>`;
  const code = (s.level_name || "")
    .replace("Parents & Toddlers", "P&T")
    .replace("Level ", "L");
  return `<span class="ms-lv">${esc(code)}</span>`;
}

function shiftChip(s, future) {
  const pending = s.status === "requested";
  const isDuty  = !s.level_id;
  const cls     = `ms-row ${pending ? "ms-pending" : "ms-ok"}`;
  const st      = pending ? `<span class="ms-st">⏳</span>` : `<span class="ms-st">✓</span>`;
  const rel     = future ? `<button class="ms-x" data-rel="${s.id}" title="Release shift">×</button>` : "";
  const ttip    = `${esc(isDuty ? "Pool Lifeguard" : s.level_name || "")} · ${s.start_time}${pending ? " · pending" : " · approved"}`;
  return `<div class="${cls}" title="${ttip}"><span class="ms-t">${s.start_time}</span>${shiftBadge(s)}${st}${rel}</div>`;
}

function weekGridHTML(mySlots, weekStart) {
  const today = isoToday();
  const byDay = {};
  for (const s of mySlots) (byDay[s.date] ||= []).push(s);
  for (const k in byDay) byDay[k].sort((a, b) => a.start_time.localeCompare(b.start_time));

  const cols = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekStart, i);
    const iso = toISO(d);
    const slots = byDay[iso] || [];
    const future = iso >= today;
    const body = slots.length
      ? slots.map((s) => shiftChip(s, future)).join("")
      : `<span class="ms-none">·</span>`;
    return `<div class="ms-col${iso === today ? " ms-today" : ""}${iso < today ? " ms-past" : ""}">
      <div class="ms-head"><span class="ms-dow">${DOW[i]}</span><span class="ms-dnum">${d.getDate()}</span></div>
      <div class="ms-body">${body}</div>
    </div>`;
  }).join("");

  return `<div class="ms-scroll"><div class="ms-grid">${cols}</div></div>`;
}

function bindWeekGrid(root, onDone) {
  root.querySelectorAll("[data-rel]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Release this shift? It will become available for others.")) return;
    b.disabled = true;
    try { await api(`/api/slots/${b.dataset.rel}/release`, { method: "POST" }); toast("Shift released", "ok"); onDone(); }
    catch (err) { toast(err.message, "err"); b.disabled = false; }
  }));
}

function renderHomeGrid(mySlots, weekStart) {
  const grid = document.getElementById("homeGrid");
  if (!grid) return;
  grid.innerHTML = weekGridHTML(mySlots, weekStart);
  bindWeekGrid(grid, viewHome);
}

function bindGoto(root) {
  root.querySelectorAll("[data-goto]").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); go(el.dataset.goto); }));
}

// ------------------------------------------------------------------ CALENDAR filter helpers
function applyCalendarFilter(slots) {
  const u = State.user;
  const f = State.calendarFilter;
  let out = slots;
  // role filter
  if (typeof f === "number") out = out.filter((s) => s.role_id === f);
  else if (f !== "all" && !u.is_admin) {
    const myRoleIds = new Set(u.roles.map((r) => r.id));
    out = out.filter((s) => myRoleIds.has(s.role_id));
  }
  // level / class filter
  const lf = State.calendarLevelFilter;
  if (lf === "duty") out = out.filter((s) => !s.level_id);
  else if (typeof lf === "number") out = out.filter((s) => s.level_id === lf);
  return out;
}

function renderFilterBar() {
  const u = State.user;
  const f = State.calendarFilter;
  // Chips to show: for non-admins only their own roles; for admins all roles
  const rolePool = u.is_admin ? State.roles : u.roles;
  // Only bother showing the bar if there's something to filter between
  if (!u.is_admin && u.roles.length < 2 && State.roles.length < 2) return "";
  const chips = rolePool.map((r) => {
    const active = f === r.id;
    return `<button class="filterchip${active ? " active" : ""}" data-fid="${r.id}"
        style="${active ? `background:${r.color};border-color:${r.color}` : `border-color:${r.color};color:${r.color}`}">
        ${esc(r.name)}</button>`;
  });
  // "All" chip: for non-admins shows everything; for admins it's the default — always first
  const allActive = f === "all" || (u.is_admin && f === null);
  chips.unshift(`<button class="filterchip${allActive ? " active" : ""}" data-fid="all">All roles</button>`);
  // For non-admins also offer "My roles" (null default) chip when >1 role
  if (!u.is_admin && u.roles.length > 1) {
    const myActive = f === null;
    chips.unshift(`<button class="filterchip${myActive ? " active" : ""}" data-fid="null">My roles</button>`);
  }
  return `<div class="filterbar" id="filterbar">${chips.join("")}</div>`;
}

function renderLevelFilterBar(slots) {
  const lf = State.calendarLevelFilter;
  // Gather distinct levels present in these slots
  const hasDuty = slots.some((s) => !s.level_id);
  const levelIds = [...new Set(slots.filter((s) => s.level_id).map((s) => s.level_id))];
  const levels = levelIds.map((id) => State.levels.find((l) => l.id === id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!hasDuty && levels.length === 0) return "";
  const chips = [
    `<button class="filterchip${lf === null ? " active" : ""}" data-lvl="">All</button>`,
    ...(hasDuty ? [`<button class="filterchip${lf === "duty" ? " active" : ""}" data-lvl="duty">🛟 Pool duty</button>`] : []),
    ...levels.map((l) => {
      const active = lf === l.id;
      const short = l.name.replace("Parents & Toddlers", "P&T").replace("Level ", "L");
      return `<button class="filterchip${active ? " active" : ""}" data-lvl="${l.id}">${esc(short)}</button>`;
    }),
  ];
  return `<div class="filterbar" id="levelfilterbar">${chips.join("")}</div>`;
}

async function viewCalendar() {
  if (!State.weekStart) State.weekStart = mondayOf(parseISO(isoToday()));
  if (!State.selectedDate) {
    const t = isoToday();
    const ws = toISO(State.weekStart);
    const we = toISO(addDays(State.weekStart, 6));
    State.selectedDate = t >= ws && t <= we ? t : ws;
  }
  const wsISO = toISO(State.weekStart);
  const weDate = addDays(State.weekStart, 6);
  const isDayView = State.calendarView !== "week";

  screen().innerHTML = `
    <div class="navrow">
      <button id="prevWk">‹ Prev</button>
      <strong>${fmtDate(wsISO).slice(4)} – ${fmtDate(toISO(weDate)).slice(4)}</strong>
      <button id="nextWk">Next ›</button>
    </div>
    <div class="tabs" style="margin-bottom:0;background:var(--blue-soft);padding:4px;border-radius:12px">
      <button id="viewWeek" class="${!isDayView ? "active" : ""}">Week</button>
      <button id="viewDay" class="${isDayView ? "active" : ""}">Day</button>
    </div>
    ${isDayView ? `<div class="weekbar" id="weekbar"></div>${renderFilterBar()}` : `<div id="wg-filter-role"></div><div id="wg-filter-level"></div>`}
    <div id="dayBody"><div class="spinner"></div></div>`;

  $("#prevWk").onclick = () => { State.weekStart = addDays(State.weekStart, -7); State.selectedDate = toISO(State.weekStart); viewCalendar(); };
  $("#nextWk").onclick = () => { State.weekStart = addDays(State.weekStart, 7); State.selectedDate = toISO(State.weekStart); viewCalendar(); };
  $("#viewDay").onclick = () => { State.calendarView = "day"; viewCalendar(); };
  $("#viewWeek").onclick = () => { State.calendarView = "week"; viewCalendar(); };

  if (isDayView) {
    // bind filter chips
    screen().querySelectorAll(".filterchip").forEach((b) =>
      b.addEventListener("click", () => {
        const v = b.dataset.fid;
        State.calendarFilter = v === "all" ? "all" : v === "null" ? null : Number(v);
        renderDayBody(State._cachedSlots || []);
        screen().querySelectorAll(".filterchip").forEach((c) => {
          const cv = c.dataset.fid;
          const nowActive = cv === "all"
            ? State.calendarFilter === "all" || (State.user.is_admin && State.calendarFilter === null)
            : cv === "null" ? State.calendarFilter === null && !State.user.is_admin
            : Number(cv) === State.calendarFilter;
          c.classList.toggle("active", nowActive);
          const roleObj = State.roles.find((r) => r.id === Number(cv));
          if (roleObj) {
            c.style.background = nowActive ? roleObj.color : "";
            c.style.borderColor = roleObj.color;
            c.style.color = nowActive ? "" : roleObj.color;
          } else { c.style.background = ""; }
        });
      }));

    const wb = $("#weekbar");
    for (let i = 0; i < 7; i++) {
      const d = addDays(State.weekStart, i);
      const iso = toISO(d);
      const b = document.createElement("button");
      b.className = (iso === State.selectedDate ? "active " : "") + (iso === isoToday() ? "today" : "");
      b.innerHTML = `<span class="dow">${DOW[i]}</span><span class="dnum">${d.getDate()}</span>`;
      b.addEventListener("click", () => { State.selectedDate = iso; viewCalendar(); });
      wb.appendChild(b);
    }

    try {
      const slots = await api(`/api/slots?from=${State.selectedDate}&to=${State.selectedDate}`);
      State._cachedSlots = slots;
      renderDayBody(slots);
    } catch (err) { $("#dayBody").innerHTML = `<div class="banner danger">${esc(err.message)}</div>`; }
  } else {
    // week view — fetch slots then render filters + grid
    try {
      const weekSlots = await api(`/api/slots/week?date=${State.selectedDate}`);
      State._cachedWeekSlots = weekSlots;
      renderWeekFilters(weekSlots);
      renderWeekGrid(weekSlots);
    } catch (err) { $("#dayBody").innerHTML = `<div class="banner danger">${esc(err.message)}</div>`; }
  }
}

function renderWeekFilters(allSlots) {
  const rfEl = $("#wg-filter-role");
  const lfEl = $("#wg-filter-level");
  if (!rfEl) return;

  rfEl.innerHTML = renderFilterBar();
  lfEl.innerHTML = renderLevelFilterBar(allSlots);

  // role chips
  rfEl.querySelectorAll(".filterchip[data-fid]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.fid;
      State.calendarFilter = v === "all" ? "all" : v === "null" ? null : Number(v);
      State.calendarLevelFilter = null; // reset level filter on role change
      renderWeekFilters(State._cachedWeekSlots || []);
      renderWeekGrid(State._cachedWeekSlots || []);
    }));

  // level chips
  lfEl.querySelectorAll(".filterchip[data-lvl]").forEach((b) =>
    b.addEventListener("click", () => {
      const v = b.dataset.lvl;
      State.calendarLevelFilter = v === "" ? null : v === "duty" ? "duty" : Number(v);
      renderWeekFilters(State._cachedWeekSlots || []);
      renderWeekGrid(State._cachedWeekSlots || []);
    }));
}

// ------------------------------------------------------------------ WEEK TIMETABLE GRID
function renderWeekGrid(allSlots) {
  const body = $("#dayBody");
  const today = isoToday();
  const u = State.user;

  // Apply role filter for week view too
  const slots = applyCalendarFilter(allSlots);

  // Collect all unique times that have content
  const times = [...new Set(slots.map((s) => s.start_time))].sort();
  if (!times.length) {
    body.innerHTML = `<div class="empty"><div class="big">📭</div>No shifts this week matching your filter.</div>`;
    return;
  }

  // Build map: time → isoDate → [slots]
  const map = {};
  for (const s of slots) {
    if (!map[s.start_time]) map[s.start_time] = {};
    if (!map[s.start_time][s.date]) map[s.start_time][s.date] = [];
    map[s.start_time][s.date].push(s);
  }

  // Days in this week (only those that have at least one slot)
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(State.weekStart, i);
    const iso = toISO(d);
    if (slots.some((s) => s.date === iso)) days.push({ iso, d, dow: DOW[i] });
  }

  // Determine if lifeguard slots are visible — group them specially
  const lgRoleId = State.roles.find((r) => r.name === "Lifeguard")?.id;

  const headerCells = days.map((day) => {
    const isToday = day.iso === today;
    return `<th class="wg-th${isToday ? " wg-today" : ""}">${day.dow}<br/><span class="wg-dnum">${day.d.getDate()}</span></th>`;
  }).join("");

  const rows = times.map((time) => {
    const endTime = slots.find((s) => s.start_time === time)?.end_time || "";
    const cells = days.map((day) => {
      const daySlots = map[time]?.[day.iso] || [];
      if (!daySlots.length) return `<td class="wg-cell wg-empty"></td>`;

      // Group by class (level) or lifeguard duty
      const groups = {};
      for (const s of daySlots) {
        const isDuty = !s.level_id;
        const key = isDuty ? "__duty__" : `${s.level_id}`;
        if (!groups[key]) groups[key] = { isDuty, level_name: s.level_name, slots: [] };
        groups[key].slots.push(s);
      }

      // Duty (lifeguard) groups first so coverage stays visible when capped,
      // then cap the rest with a "+N more" pill to keep row heights bounded
      // (a single busy day would otherwise stretch the whole table row).
      const groupVals = Object.values(groups).sort(
        (a, b) => (b.isDuty ? 1 : 0) - (a.isDuty ? 1 : 0)
      );
      const MAX_PILLS = 4;
      const renderGroupPill = (g) => {
        const firstSlot = g.slots[0];
        if (g.isDuty) {
          const approvedSlots  = g.slots.filter((s) => s.status === "approved");
          const requestedSlots = g.slots.filter((s) => s.status === "requested");
          const openSlots      = g.slots.filter((s) => s.status === "open" && s.date >= today);
          const total = g.slots.length;
          const ok = approvedSlots.length >= total;
          const isPartial = !ok && approvedSlots.length > 0;
          const hasPending = requestedSlots.length > 0;
          const mineApproved   = g.slots.some((s) => s.assigned_user_id === u.id && s.status === "approved");
          const mineRequested  = !mineApproved && g.slots.some((s) => s.assigned_user_id === u.id && s.status === "requested");
          const mineClass = mineApproved ? " wg-mine" : mineRequested ? " wg-mine-requested" : "";
          const cls = ok ? "wg-pill-ok" : isPartial ? "wg-pill-partial" : hasPending ? "wg-pill-pending" : "wg-pill-open";
          const names = approvedSlots.map((s) => s.assigned_name?.split(" ")[0]).filter(Boolean).join(", ");
          const openId = openSlots[0]?.id;
          const canReq = openId && userHasRole(firstSlot.role_id);
          // Show names if any approved; add open slot id when there's still a free slot to request
          let dAttr = "";
          if (ok || isPartial) {
            dAttr = `data-pill-names="${esc(names)}" data-pill-desc="Pool duty 🛟"${canReq ? ` data-pill-open="${openId}"` : ""}`;
          } else if (canReq) {
            dAttr = `data-pill-open="${openId}" data-pill-desc="Pool duty 🛟"`;
          }
          const icon = isPartial ? "⚡ " : (!ok && hasPending) ? "⏳ " : "";
          const count = isPartial && hasPending
            ? `${approvedSlots.length}/${total} ⏳`
            : !ok && hasPending
            ? `${requestedSlots.length}/${total}`
            : `${approvedSlots.length}/${total}`;
          return `<div class="wg-pill ${cls}${mineClass}" ${dAttr}>🛟 ${icon}${count}</div>`;
        }
        const assignedSlot = g.slots.find((s) => s.assigned_user_id && s.status === "approved");
        const pendingSlot  = g.slots.find((s) => s.status === "requested");
        const openSlot     = g.slots.find((s) => s.status === "open" && s.date >= today);
        const mineApproved  = g.slots.some((s) => s.assigned_user_id === u.id && s.status === "approved");
        const mineRequested = !mineApproved && g.slots.some((s) => s.assigned_user_id === u.id && s.status === "requested");
        const mineClass = mineApproved ? " wg-mine" : mineRequested ? " wg-mine-requested" : "";
        const cls  = assignedSlot ? "wg-pill-ok" : pendingSlot ? "wg-pill-pending" : "wg-pill-open";
        const shortName = (g.level_name || "").replace("Parents & Toddlers", "P&T").replace("Level ", "L");
        const who = assignedSlot ? ` · ${assignedSlot.assigned_name?.split(" ")[0]}` : pendingSlot ? " · ⏳" : "";
        const names = g.slots.filter((s) => s.status === "approved" && s.assigned_name).map((s) => s.assigned_name.split(" ")[0]).join(", ");
        const canReq = openSlot && userHasRole(openSlot.role_id);
        const dAttr = cls === "wg-pill-ok"
          ? `data-pill-names="${esc(names)}" data-pill-desc="${esc(shortName)}"`
          : (cls === "wg-pill-open" && canReq) ? `data-pill-open="${openSlot.id}" data-pill-desc="${esc(shortName)}"` : "";
        return `<div class="wg-pill ${cls}${mineClass}" ${dAttr}>${esc(shortName)}${esc(who)}</div>`;
      };

      let shownGroups = groupVals;
      let hiddenGroups = [];
      if (groupVals.length > MAX_PILLS) {
        shownGroups = groupVals.slice(0, MAX_PILLS - 1);
        hiddenGroups = groupVals.slice(MAX_PILLS - 1);
      }
      const moreCount = hiddenGroups.length;

      const pills = shownGroups.map(renderGroupPill).join("") +
        (moreCount ? `<button class="wg-pill wg-pill-more" data-wg-expand>+${moreCount} more</button>` +
          `<div class="wg-extra-pills" style="display:none">${hiddenGroups.map(renderGroupPill).join("")}</div>` : "");

      return `<td class="wg-cell" data-date="${day.iso}" data-time="${time}">${pills}</td>`;
    }).join("");

    return `<tr><td class="wg-time">${time}<span class="wg-end">${endTime}</span></td>${cells}</tr>`;
  }).join("");

  body.innerHTML = `
    <div class="wg-hint">
      <span class="wg-legend wg-pill-ok">Covered</span>
      <span class="wg-legend wg-pill-partial">⚡ Part cover</span>
      <span class="wg-legend wg-pill-pending">Pending</span>
      <span class="wg-legend wg-pill-open">Open</span>
      ${u.id ? `<span class="wg-legend wg-mine">Your shift</span><span class="wg-legend wg-mine-requested">Requested</span>` : ""}
    </div>
    <div class="wg-wrap">
      <table class="wg-table">
        <thead><tr><th class="wg-time-head"></th>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="small muted" style="margin-top:8px">Tap a day in the weekbar to switch to the day view for that date.</p>`;

  // expand "+N more" pills without navigating to day view
  body.querySelectorAll("[data-wg-expand]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.nextElementSibling.style.display = "";
      btn.remove();
    }));

  // open-only pill (no names) → request sheet
  body.querySelectorAll(".wg-pill[data-pill-open]:not([data-pill-names])").forEach((pill) =>
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      const td = pill.closest("[data-date]");
      showWeekRequestSheet(pill.dataset.pillOpen, pill.dataset.pillDesc, td?.dataset.date, td?.dataset.time);
    }));

  // covered/partial pill → names sheet (may also carry an open slot to request)
  body.querySelectorAll(".wg-pill[data-pill-names]").forEach((pill) =>
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      const td = pill.closest("[data-date]");
      showWeekNamesSheet(pill.dataset.pillNames, pill.dataset.pillDesc, td?.dataset.date, td?.dataset.time, pill.dataset.pillOpen);
    }));

  // clicking a cell switches to day view for that date
  body.querySelectorAll("[data-date]").forEach((td) =>
    td.addEventListener("click", () => {
      State.selectedDate = td.dataset.date;
      State.calendarView = "day";
      viewCalendar();
    }));
}

function renderDayBody(allSlots) {
  const slots = applyCalendarFilter(allSlots);
  const body = $("#dayBody");
  const addBtn = State.user.is_admin
    ? `<button class="btn sub sm" id="addSlotBtn">＋ Add shift</button>` : "";

  const openForMe = allSlots.filter((s) =>
    s.status === "open" && s.date >= isoToday() && userHasRole(s.role_id)).length;
  const hintHtml = (!State.user.is_admin && openForMe > 0)
    ? `<div class="open-hint">🟢 ${openForMe} open shift${openForMe > 1 ? "s" : ""} available for you today — tap <strong>Request</strong> to claim one.</div>`
    : "";

  if (!slots.length) {
    const reason = allSlots.length && slots.length === 0 ? "No shifts match the selected filter." : `No classes scheduled for ${fmtDate(State.selectedDate)}.`;
    body.innerHTML = `${hintHtml}<div class="empty"><div class="big">📭</div>${reason}<br/>${addBtn}</div>`;
  } else {
    // Group cards by time slot for the sectioned 2-col layout
    const groups = groupSlots(slots);
    const byTime = new Map();
    for (const g of groups) {
      const key = `${g.start}|${g.end}`;
      if (!byTime.has(key)) byTime.set(key, []);
      byTime.get(key).push(g);
    }
    const slotSections = [...byTime.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, cards]) => {
        const [start, end] = key.split("|");
        return `<div class="dv-slot">
          <div class="dv-slot-hdr">${start} – ${end}</div>
          <div class="dv-slot-grid">${cards.map((g) => classCard(g, false)).join("")}</div>
        </div>`;
      }).join("");

    body.innerHTML = `${hintHtml}<div class="between" style="margin-bottom:10px">
        <div class="day-head" style="margin:0">${fmtLong(State.selectedDate)}</div>
        ${addBtn}
      </div>${slotSections}`;
    bindSlotActions(body);
  }
  if (State.user.is_admin) {
    $("#addSlotBtn")?.addEventListener("click", () => addSlotSheet(State.selectedDate));
  }
}

function addSlotSheet(date) {
  const levelOpts = State.levels.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("");
  const roleOpts = State.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  openSheet(`
    <h2>Add shift</h2>
    <p class="small muted">${fmtLong(date)}</p>
    <div class="stack" style="margin-top:14px">
      <div class="field"><label>Class / level</label>
        <select id="as-level"><option value="">Pool duty (lifeguard)</option>${levelOpts}</select></div>
      <div class="field"><label>Role</label><select id="as-role">${roleOpts}</select></div>
      <div class="row">
        <div class="field" style="flex:1"><label>Start time</label>
          <input id="as-start" type="time" value="16:00" step="1800"/></div>
        <div class="field" style="flex:1"><label>End time</label>
          <input id="as-end" type="time" value="16:30" step="1800"/></div>
      </div>
      <div class="field"><label>Label (optional)</label>
        <input id="as-label" placeholder="e.g. Squad training"/></div>
      <div class="field"><label>Notes (optional)</label>
        <input id="as-notes" placeholder="Anything admins should know"/></div>
      <button class="btn block" id="as-save">Add shift</button>
    </div>`);

  $("#as-level").addEventListener("change", () => {
    const sel = $("#as-level");
    const name = sel.options[sel.selectedIndex].text;
    if (!$("#as-label").value) $("#as-label").value = name !== "Pool duty (lifeguard)" ? name : "";
  });

  $("#as-save").addEventListener("click", async () => {
    const levelId = $("#as-level").value || null;
    const roleId = parseInt($("#as-role").value);
    const startTime = $("#as-start").value;
    const endTime = $("#as-end").value;
    const label = $("#as-label").value.trim() || null;
    const notes = $("#as-notes").value.trim() || null;
    if (!startTime || !endTime || startTime >= endTime)
      return toast("Set valid start and end times", "err");
    try {
      await api("/api/slots", { method: "POST", body: {
        date, start_time: startTime, end_time: endTime,
        level_id: levelId ? parseInt(levelId) : null,
        role_id: roleId, label, notes,
      }});
      toast("Shift added", "ok");
      closeSheet();
      viewCalendar();
    } catch (err) { toast(err.message, "err"); }
  });
}

// ------------------------------------------------------------------ MY SHIFTS
async function viewMyShifts() {
  loading();
  const today = isoToday();
  if (!State._myWeekStart) State._myWeekStart = mondayOf(parseISO(today));
  const weekISO = toISO(State._myWeekStart);
  const weekEnd = toISO(addDays(State._myWeekStart, 6));

  let slots = [];
  try { slots = await api(`/api/slots?mine=1&from=${weekISO}&to=${weekEnd}`); } catch (err) { toast(err.message, "err"); }
  const mySlots = slots.filter((s) => s.assigned_user_id === State.user.id && s.status !== "open");
  const weekLabel = `${fmtDate(weekISO).slice(4)} – ${fmtDate(weekEnd).slice(4)}`;

  screen().innerHTML = `
    <div class="between" style="margin-bottom:8px">
      <h1 class="section-title" style="margin:0">My shifts</h1>
      <button class="btn sub sm" id="msToday" style="padding:5px 12px">Today</button>
    </div>
    <div class="between" style="margin-bottom:10px">
      <button class="btn sub sm" id="msPrev" style="padding:6px 14px">‹</button>
      <strong class="small" style="white-space:nowrap">${weekLabel}</strong>
      <button class="btn sub sm" id="msNext" style="padding:6px 14px">›</button>
    </div>
    <div id="msGrid"></div>
    <div class="ms-legend">
      <span>🛟 Lifeguard</span>
      <span style="color:var(--green)">✓ Approved</span>
      <span style="color:var(--amber)">⏳ Pending</span>
      <span style="color:var(--muted)">× Release</span>
    </div>`;

  const grid = $("#msGrid");
  grid.innerHTML = weekGridHTML(mySlots, State._myWeekStart);
  bindWeekGrid(grid, viewMyShifts);

  $("#msPrev").onclick = () => { State._myWeekStart = addDays(State._myWeekStart, -7); viewMyShifts(); };
  $("#msNext").onclick = () => { State._myWeekStart = addDays(State._myWeekStart, 7); viewMyShifts(); };
  $("#msToday").onclick = () => { State._myWeekStart = mondayOf(parseISO(today)); viewMyShifts(); };
}

// ------------------------------------------------------------------ ADMIN
function viewAdmin() {
  if (!State.adminTab) State.adminTab = "approvals";
  screen().innerHTML = `
    <h1 class="section-title" style="margin-top:14px">Admin</h1>
    <div class="tabs">
      <button data-atab="approvals" class="${State.adminTab==="approvals"?"active":""}">Approvals</button>
      <button data-atab="reports" class="${State.adminTab==="reports"?"active":""}">Reports</button>
      <button data-atab="manage" class="${State.adminTab==="manage"?"active":""}">Manage</button>
      <button data-atab="rota" class="${State.adminTab==="rota"?"active":""}">Rota</button>
    </div>
    <div id="adminBody"></div>`;
  const tabs = screen().querySelectorAll("[data-atab]");
  tabs.forEach((b) => b.addEventListener("click", () => {
    State.adminTab = b.dataset.atab;
    tabs.forEach((x) => x.classList.toggle("active", x === b));
    if (b.dataset.atab === "approvals") adminApprovals();
    else if (b.dataset.atab === "reports") adminReports();
    else if (b.dataset.atab === "manage") adminManage();
    else adminRotaView();
  }));
  if (State.adminTab === "approvals") adminApprovals();
  else if (State.adminTab === "reports") adminReports();
  else if (State.adminTab === "manage") adminManage();
  else adminRotaView();
}

async function adminApprovals() {
  const body = $("#adminBody");
  body.innerHTML = `<div class="spinner"></div>`;
  let pending = [];
  try { pending = await api(`/api/slots?pending=1`); } catch (err) { toast(err.message, "err"); return; }

  if (!pending.length) {
    body.innerHTML = `<div class="empty"><div class="big">✅</div>No requests waiting. All caught up!</div>`;
    return;
  }

  // Unique roles + levels present in the pending list
  const rolesInPending = [...new Map(pending.map((s) => [s.role_id, { id: s.role_id, name: s.role_name, color: s.role_color }])).values()];
  const levelsInPending = [...new Map(pending.filter((s) => s.level_name).map((s) => [s.level_id, { id: s.level_id, name: s.level_name }])).values()];
  const hasDuty = pending.some((s) => !s.level_id);

  if (State._appRoleFilter === undefined) State._appRoleFilter = null;
  if (State._appLevelFilter === undefined) State._appLevelFilter = null;
  if (State._appPersonFilter === undefined) State._appPersonFilter = null;

  function filtered() {
    let s = pending;
    if (State._appRoleFilter) s = s.filter((x) => x.role_id === State._appRoleFilter);
    if (State._appLevelFilter === "duty") s = s.filter((x) => !x.level_id);
    else if (State._appLevelFilter) s = s.filter((x) => x.level_id === State._appLevelFilter);
    if (State._appPersonFilter) s = s.filter((x) => x.assigned_user_id === State._appPersonFilter);
    return s.slice().sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  }

  function renderRows() {
    const rows = document.getElementById("apprRows");
    const countEl = document.getElementById("apprCount");
    const list = filtered();
    if (countEl) countEl.textContent = `${list.length} request${list.length !== 1 ? "s" : ""}`;
    if (!rows) return;
    if (!list.length) { rows.innerHTML = `<div class="small muted" style="padding:10px 0">No requests match this filter.</div>`; return; }
    rows.innerHTML = list.map((s) => {
      const fn = s.assigned_name?.split(" ")[0] || s.assigned_name;
      const lvl = s.level_name ? s.level_name.replace("Parents & Toddlers", "P&T").replace("Level ", "L") : "Pool duty";
      const dateStr = fmtDate(s.date).replace(/\s\d{4}/, "");
      const clashBanner = s.clash
        ? `<div class="appr-clash">⚠ Can't approve — already working as ${esc(s.clash)}</div>`
        : "";
      return `<div class="appr-row${s.clash ? " appr-row-clash" : ""}">
        <span class="appr-dot" style="background:${roleColor(s.role_id)}"></span>
        <div class="appr-info">
          <span class="appr-name">${esc(fn)}</span>
          <span class="appr-role" style="color:${roleColor(s.role_id)}">${esc(roleName(s.role_id))}</span>
          <span class="appr-sep">·</span>
          <span>${esc(lvl)}</span>
          <span class="appr-sep">·</span>
          <span class="appr-time">${dateStr} ${s.start_time}</span>
          ${clashBanner}
        </div>
        <div class="appr-btns">
          <button class="btn green sm" data-approve="${s.id}" title="Approve"${s.clash ? " disabled" : ""}>✓</button>
          <button class="btn danger sm" data-reject="${s.id}" title="Decline">✗</button>
        </div>
      </div>`;
    }).join("");

    rows.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/api/slots/${b.dataset.approve}/approve`, { method: "POST" });
        toast("Approved", "ok");
        await refreshNotif();
        const i = pending.findIndex((s) => s.id === Number(b.dataset.approve));
        if (i > -1) pending.splice(i, 1);
        renderRows();
      } catch (err) { toast(err.message, "err"); b.disabled = false; }
    }));

    rows.querySelectorAll("[data-reject]").forEach((b) => b.addEventListener("click", async () => {
      const reason = prompt("Reason for declining (optional — sent as a direct message to the person):") ?? null;
      if (reason === null && !confirm("Decline without a reason?")) return;
      b.disabled = true;
      try {
        await api(`/api/slots/${b.dataset.reject}/reject`, { method: "POST", body: { reason } });
        toast("Declined", "ok");
        const i = pending.findIndex((s) => s.id === Number(b.dataset.reject));
        if (i > -1) pending.splice(i, 1);
        renderRows();
      } catch (err) { toast(err.message, "err"); b.disabled = false; }
    }));
  }

  const peopleInPending = [...new Map(pending.map((s) => [s.assigned_user_id, { id: s.assigned_user_id, name: s.assigned_name }])).values()]
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const roleChips = [
    `<button class="filterchip${!State._appRoleFilter ? " active" : ""}" data-arole="">All roles</button>`,
    ...rolesInPending.map((r) => `<button class="filterchip${State._appRoleFilter === r.id ? " active" : ""}" data-arole="${r.id}"
       style="${State._appRoleFilter === r.id ? `background:${r.color};border-color:${r.color}` : `border-color:${r.color};color:${r.color}`}">${esc(r.name)}</button>`),
  ].join("");

  const levelChips = [
    `<button class="filterchip${!State._appLevelFilter ? " active" : ""}" data-alevel="">All classes</button>`,
    ...(hasDuty ? [`<button class="filterchip${State._appLevelFilter === "duty" ? " active" : ""}" data-alevel="duty">Pool duty</button>`] : []),
    ...levelsInPending.map((l) => `<button class="filterchip${State._appLevelFilter === l.id ? " active" : ""}" data-alevel="${l.id}">${esc(l.name.replace("Parents & Toddlers", "P&T").replace("Level ", "L"))}</button>`),
  ].join("");

  const personChips = [
    `<button class="filterchip${!State._appPersonFilter ? " active" : ""}" data-aperson="">Everyone</button>`,
    ...peopleInPending.map((p) => `<button class="filterchip${State._appPersonFilter === p.id ? " active" : ""}" data-aperson="${p.id}">${esc((p.name || "").split(" ")[0])}</button>`),
  ].join("");

  body.innerHTML = `
    <div style="margin-bottom:6px">
      <div class="filterbar" style="flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px">${personChips}</div>
      <div class="filterbar" style="flex-wrap:nowrap;overflow-x:auto;padding-bottom:2px">${roleChips}</div>
      <div class="filterbar" style="flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px">${levelChips}</div>
    </div>
    <div class="between" style="margin-bottom:8px">
      <span class="small muted" id="apprCount"></span>
      <button class="btn green sm" id="approveAllBtn">✓ Approve all</button>
    </div>
    <div id="apprRows"></div>`;

  renderRows();

  body.querySelectorAll("[data-arole]").forEach((b) => b.addEventListener("click", () => {
    State._appRoleFilter = b.dataset.arole ? Number(b.dataset.arole) : null;
    body.querySelectorAll("[data-arole]").forEach((x) => {
      const rid = x.dataset.arole ? Number(x.dataset.arole) : null;
      const active = rid === State._appRoleFilter;
      x.classList.toggle("active", active);
      const r = State.roles.find((r) => r.id === rid);
      if (r) { x.style.background = active ? r.color : ""; x.style.borderColor = r.color; x.style.color = active ? "" : r.color; }
      else { x.style.background = ""; x.style.borderColor = ""; x.style.color = ""; }
    });
    renderRows();
  }));

  body.querySelectorAll("[data-alevel]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.alevel;
    State._appLevelFilter = v === "" ? null : v === "duty" ? "duty" : Number(v);
    body.querySelectorAll("[data-alevel]").forEach((x) =>
      x.classList.toggle("active", x.dataset.alevel === (State._appLevelFilter === null ? "" : String(State._appLevelFilter))));
    renderRows();
  }));

  body.querySelectorAll("[data-aperson]").forEach((b) => b.addEventListener("click", () => {
    State._appPersonFilter = b.dataset.aperson ? Number(b.dataset.aperson) : null;
    body.querySelectorAll("[data-aperson]").forEach((x) =>
      x.classList.toggle("active", x.dataset.aperson === (State._appPersonFilter === null ? "" : String(State._appPersonFilter))));
    renderRows();
  }));

  document.getElementById("approveAllBtn").addEventListener("click", async () => {
    const list = filtered();
    if (!list.length) return toast("Nothing to approve", "err");
    if (!confirm(`Approve ${list.length} shift${list.length !== 1 ? "s" : ""}?`)) return;
    const btn = document.getElementById("approveAllBtn");
    btn.disabled = true; btn.textContent = "Approving…";
    let done = 0;
    for (const s of [...list]) {
      try {
        await api(`/api/slots/${s.id}/approve`, { method: "POST" });
        done++;
        const i = pending.findIndex((x) => x.id === s.id);
        if (i > -1) pending.splice(i, 1);
      } catch {}
    }
    toast(`Approved ${done} shifts`, "ok");
    await refreshNotif();
    renderRows();
    btn.disabled = false; btn.textContent = "✓ Approve all";
  });
}

async function adminReports() {
  const body = $("#adminBody");
  body.innerHTML = `
    <div class="tabs" style="background:#fff;border:1px solid var(--line)">
      <button data-rtab="outstanding" class="${State.reportTab === "outstanding" ? "active" : ""}">Outstanding</button>
      <button data-rtab="coverage" class="${State.reportTab === "coverage" ? "active" : ""}">Coverage</button>
      <button data-rtab="training" class="${State.reportTab === "training" ? "active" : ""}">Training</button>
      <button data-rtab="activity" class="${State.reportTab === "activity" ? "active" : ""}">Activity</button>
    </div>
    <div id="reportBody"><div class="spinner"></div></div>`;
  body.querySelectorAll("[data-rtab]").forEach((b) => b.addEventListener("click", () => {
    State.reportTab = b.dataset.rtab; adminReports();
  }));
  if (State.reportTab === "outstanding") return reportOutstanding();
  if (State.reportTab === "coverage") return reportCoverage();
  if (State.reportTab === "activity") return reportActivity();
  return reportTraining();
}

async function reportOutstanding() {
  const rb = $("#reportBody");
  try {
    const data = await api(`/api/reports/outstanding`);
    const byDate = {};
    for (const s of data.rows) (byDate[s.date] ||= []).push(s);
    rb.innerHTML = `
      <div class="between" style="margin-bottom:8px">
        <span class="muted small">${data.count} unfilled (next 4 weeks)</span>
        <button class="btn sub sm" id="csvBtn">⬇ CSV</button>
      </div>
      ${data.count === 0
        ? `<div class="empty"><div class="big">🎉</div>Every shift is approved!</div>`
        : Object.keys(byDate).sort().map((d) => `
            <div class="day-head" style="margin-top:10px;margin-bottom:2px">${fmtDate(d)}</div>
            ${byDate[d].map((s) => {
              const isPending = s.status === "requested";
              return `<div class="osr-row">
                <span class="osr-dot" style="background:${roleColor(s.role_id)}"></span>
                <span class="osr-time">${s.start_time}</span>
                <span class="osr-info">${esc(s.level_name || "Pool")} · ${esc(roleName(s.role_id))}</span>
                ${isPending
                  ? `<span class="osr-who">⏳ ${esc(s.assigned_name?.split(" ")[0] || "")}</span>
                     <button class="btn green sm" style="padding:4px 10px;font-size:.7rem" data-approve="${s.id}">✓</button>`
                  : `<span class="pill open" style="font-size:.65rem;padding:1px 6px">Open</span>`}
              </div>`;
            }).join("")}`
          ).join("")}`;

    rb.querySelectorAll("[data-approve]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try { await api(`/api/slots/${b.dataset.approve}/approve`, { method: "POST" }); toast("Approved", "ok"); await refreshNotif(); reportOutstanding(); }
      catch (err) { toast(err.message, "err"); b.disabled = false; }
    }));
    $("#csvBtn")?.addEventListener("click", async () => {
      try {
        const res = await api(`/api/reports/outstanding.csv`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a"); a.href = url; a.download = "outstanding_shifts.csv"; a.click();
        URL.revokeObjectURL(url);
      } catch (err) { toast(err.message, "err"); }
    });
  } catch (err) { rb.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`; }
}

async function reportCoverage() {
  const rb = $("#reportBody");
  try {
    const data = await api(`/api/reports/coverage`);
    if (!data.days.length) { rb.innerHTML = `<div class="empty">No scheduled shifts.</div>`; return; }
    rb.innerHTML = data.days.map((d) => {
      const pct = Math.round((d.approved / d.total) * 100);
      const col = pct === 100 ? "var(--green)" : pct >= 60 ? "var(--amber)" : "var(--red)";
      const needsWork = d.open > 0 || d.requested > 0;
      return `<div class="cov-row">
        <div class="between" style="gap:8px">
          <span class="cov-date">${fmtDate(d.date).slice(0, 6)}</span>
          <div class="cov-bar-wrap"><div class="cov-bar-fill" style="width:${pct}%;background:${col}"></div></div>
          <span style="color:${col};font-weight:800;font-size:.8rem;min-width:32px;text-align:right">${pct}%</span>
          <span class="small muted" style="min-width:44px;font-size:.7rem;text-align:right">${d.approved}/${d.total}</span>
          ${needsWork
            ? `<button class="btn sub sm cov-btn" style="padding:3px 8px;font-size:.72rem;flex-shrink:0" data-covday="${d.date}">＋</button>`
            : `<span style="width:38px;flex-shrink:0"></span>`}
        </div>
        <div class="cov-detail" id="cov-${d.date}" style="display:none;padding-top:6px"></div>
      </div>`;
    }).join("");

    rb.querySelectorAll(".cov-btn").forEach((b) => b.addEventListener("click", async () => {
      const date = b.dataset.covday;
      const detail = document.getElementById(`cov-${date}`);
      if (!detail) return;
      if (detail.style.display !== "none") { detail.style.display = "none"; b.textContent = "＋"; return; }
      b.textContent = "−"; detail.style.display = "block";
      detail.innerHTML = `<div class="spinner" style="width:18px;height:18px;border-width:2px;margin:6px auto"></div>`;
      try {
        const slots = await api(`/api/slots?from=${date}&to=${date}`);
        const unfinished = slots.filter((s) => s.status !== "approved").sort((a, b) => a.start_time.localeCompare(b.start_time));
        if (!unfinished.length) { detail.innerHTML = `<div class="small muted" style="padding:4px">All approved ✓</div>`; return; }
        detail.innerHTML = unfinished.map((s) => `
          <div class="osr-row" style="padding:4px 0">
            <span class="osr-dot" style="background:${roleColor(s.role_id)}"></span>
            <span class="osr-time">${s.start_time}</span>
            <span class="osr-info">${esc(s.level_name || "Pool")} · ${esc(s.role_name)}</span>
            ${s.status === "requested"
              ? `<span class="osr-who">⏳ ${esc(s.assigned_name?.split(" ")[0] || "")}</span>
                 <button class="btn green sm" style="padding:3px 8px;font-size:.7rem" data-approve="${s.id}">✓</button>`
              : `<span class="pill open" style="font-size:.65rem;padding:1px 6px">Open</span>`}
          </div>`).join("");
        detail.querySelectorAll("[data-approve]").forEach((ab) => ab.addEventListener("click", async () => {
          ab.disabled = true;
          try { await api(`/api/slots/${ab.dataset.approve}/approve`, { method: "POST" }); toast("Approved", "ok"); await refreshNotif(); ab.closest(".osr-row").remove(); }
          catch (err) { toast(err.message, "err"); ab.disabled = false; }
        }));
      } catch (err) { detail.innerHTML = `<div class="small muted">${esc(err.message)}</div>`; }
    }));
  } catch (err) { rb.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`; }
}

async function reportTraining() {
  const rb = $("#reportBody");
  try {
    const data = await api(`/api/reports/training`);
    rb.innerHTML = `<p class="small muted">Lifeguards must hold in-date training to be approved for lifeguard shifts.</p>` +
      data.rows.map((u) => `<div class="list-item">
        <div><strong>${esc(u.full_name)}</strong>
          <div class="small muted">${u.training_expiry ? "Expires " + fmtDate(u.training_expiry) : "No expiry recorded"}</div></div>
        <span class="pill ${u.status}">${u.status}</span>
      </div>`).join("");
  } catch (err) { rb.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`; }
}

const ACTIVITY_CATEGORIES = [
  { key: "", label: "All" },
  { key: "shifts",   label: "Shifts",   icon: "🏊" },
  { key: "users",    label: "Users",    icon: "👤" },
  { key: "messages", label: "Messages", icon: "💬" },
  { key: "channels", label: "Channels", icon: "📢" },
  { key: "roles",    label: "Roles",    icon: "🏷" },
];

const ACTIVITY_LABELS = {
  shift_request: "Requested shift", shift_release: "Released shift",
  shift_approve: "Approved shift",  shift_reject: "Rejected shift",
  shift_assign: "Assigned shift",   shift_bulk_assign: "Bulk assigned",
  slot_create: "Created slot",      slot_delete: "Deleted slot",
  slots_generated: "Generated slots",
  user_create: "Created user",      user_update: "Updated user",
  user_deactivate: "Deactivated user", user_roles_changed: "Changed roles",
  role_create: "Created role",      role_update: "Updated role",
  channel_create: "Created channel", channel_update: "Updated channel",
  channel_delete: "Deleted channel",
  message_sent: "Sent message",     message_deleted: "Deleted message",
};

const ACTIVITY_CATEGORY_COLORS = {
  shifts: "var(--green)", users: "var(--blue)", messages: "var(--magenta)",
  channels: "#f59e0b", roles: "#0E9F8E",
};

async function reportActivity(page = 0) {
  const rb = $("#reportBody");
  if (!rb) return;
  if (page === 0) {
    const catFilter = State._activityCat || "";
    rb.innerHTML = `
      <div class="filterbar" style="margin-bottom:10px">
        ${ACTIVITY_CATEGORIES.map((c) => `
          <button class="filterchip${catFilter === c.key ? " active" : ""}" data-acat="${c.key}">
            ${c.icon ? c.icon + " " : ""}${c.label}
          </button>`).join("")}
      </div>
      <div id="activityFeed"><div class="spinner"></div></div>`;
    rb.querySelectorAll("[data-acat]").forEach((b) => b.addEventListener("click", () => {
      State._activityCat = b.dataset.acat;
      reportActivity(0);
    }));
  }
  const feed = $("#activityFeed");
  if (!feed) return;
  if (page === 0) feed.innerHTML = `<div class="spinner"></div>`;
  try {
    const cat = State._activityCat || "";
    const data = await api(`/api/activity?page=${page}${cat ? "&category=" + cat : ""}`);
    const rows = data.rows;
    const hasMore = (page + 1) * data.limit < data.total;
    const html = rows.map((r) => {
      const color = ACTIVITY_CATEGORY_COLORS[r.category] || "var(--muted)";
      const label = ACTIVITY_LABELS[r.action] || r.action;
      const ts = r.ts ? r.ts.replace("T", " ").slice(0, 16) : "";
      return `<div class="list-item" style="align-items:flex-start;gap:10px">
        <div style="width:6px;height:6px;border-radius:50%;background:${color};margin-top:6px;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;justify-content:space-between;gap:6px">
            <strong style="font-size:.82rem">${esc(label)}</strong>
            <span class="small muted" style="white-space:nowrap;font-size:.72rem">${esc(ts)}</span>
          </div>
          ${r.actor_name ? `<div class="small muted">${esc(r.actor_name)}</div>` : ""}
          ${r.detail ? `<div class="small" style="color:var(--ink);opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.detail)}</div>` : ""}
        </div>
      </div>`;
    }).join("");
    if (page === 0) {
      feed.innerHTML = rows.length ? html : `<div class="empty">No activity yet.</div>`;
    } else {
      feed.querySelector("[data-load-more]")?.remove();
      feed.insertAdjacentHTML("beforeend", html);
    }
    if (hasMore) {
      feed.insertAdjacentHTML("beforeend",
        `<button class="btn ghost block" data-load-more style="margin-top:8px">Load more</button>`);
      feed.querySelector("[data-load-more]").addEventListener("click", () => reportActivity(page + 1));
    }
  } catch (err) {
    if (page === 0) feed.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`;
  }
}

// ---- manage (users / roles / classes / rota / day view)
function adminManage() {
  const body = $("#adminBody");
  const tabs = ["users","roles","classes"];
  const labels = ["People","Roles","Classes"];
  if (!tabs.includes(State.manageTab)) State.manageTab = "users";
  body.innerHTML = `
    <div class="tabs" style="background:#fff;border:1px solid var(--line);flex-wrap:wrap">
      ${tabs.map((t,i) => `<button data-mtab="${t}" class="${State.manageTab===t?"active":""}">${labels[i]}</button>`).join("")}
    </div>
    <div id="manageBody"><div class="spinner"></div></div>`;
  body.querySelectorAll("[data-mtab]").forEach((b) => b.addEventListener("click", () => {
    State.manageTab = b.dataset.mtab; adminManage();
  }));
  if (State.manageTab === "users") manageUsers();
  else if (State.manageTab === "roles") manageRoles();
  else manageClasses();
}

function adminRotaView() {
  if (!State.rotaSubTab) State.rotaSubTab = "builder";
  const body = $("#adminBody");
  body.innerHTML = `
    <div class="tabs" style="background:#fff;border:1px solid var(--line)">
      <button data-rstab="builder" class="${State.rotaSubTab==="builder"?"active":""}">Rota</button>
      <button data-rstab="dayview" class="${State.rotaSubTab==="dayview"?"active":""}">Day View</button>
    </div>
    <div id="manageBody"><div class="spinner"></div></div>`;
  body.querySelectorAll("[data-rstab]").forEach((b) => b.addEventListener("click", () => {
    State.rotaSubTab = b.dataset.rstab; adminRotaView();
  }));
  if (State.rotaSubTab === "builder") rotaBuilder();
  else adminDayView();
}

// ------------------------------------------------------------------ ROTA BUILDER
async function rotaBuilder() {
  const mb = $("#manageBody");
  mb.innerHTML = `<div class="spinner"></div>`;
  const [users, allSlots] = await Promise.all([
    api("/api/users"),
    api(`/api/slots/week?date=${isoToday()}`),
  ]);
  State._rotaWeekStart = State._rotaWeekStart || mondayOf(parseISO(isoToday()));

  // Which role tab is active? null = "All roles"
  if (State.rotaRole === undefined) State.rotaRole = State.roles.find((r) => r.name === "Lifeguard")?.id || State.roles[0]?.id;
  const roleObj = State.rotaRole ? State.roles.find((r) => r.id === State.rotaRole) : null;
  const isAllView = !State.rotaRole;

  const weekISO = toISO(State._rotaWeekStart);
  const weekEnd = toISO(addDays(State._rotaWeekStart, 6));

  let weekSlots;
  try { weekSlots = await api(`/api/slots/week?date=${weekISO}`); }
  catch { weekSlots = []; }

  // Filter to active role (or all)
  const roleSlots = isAllView ? weekSlots : weekSlots.filter((s) => s.role_id === State.rotaRole);

  // Level filter (null = all, "duty" = pool duty, number = level_id)
  if (State._rotaLevelFilter === undefined) State._rotaLevelFilter = null;
  const gridSlots = State._rotaLevelFilter === "duty"
    ? roleSlots.filter((s) => !s.level_id)
    : State._rotaLevelFilter
    ? roleSlots.filter((s) => s.level_id === State._rotaLevelFilter)
    : roleSlots;

  // All active staff (All view) or just those qualified for the selected role
  const qualified = isAllView
    ? users.filter((u) => u.active !== false)
    : users.filter((u) => u.active !== false && u.roles.some((r) => r.id === State.rotaRole));

  // Build level filter chips from unique levels in roleSlots
  const hasDuty = roleSlots.some((s) => !s.level_id);
  const levelsInSlots = [...new Map(roleSlots.filter((s) => s.level_id).map((s) => [s.level_id, { id: s.level_id, name: s.level_name }])).values()]
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const levelChipsHtml = (hasDuty || levelsInSlots.length) ? [
    `<button class="filterchip${!State._rotaLevelFilter ? " active" : ""}" data-rlevel="">All</button>`,
    ...(hasDuty ? [`<button class="filterchip${State._rotaLevelFilter === "duty" ? " active" : ""}" data-rlevel="duty">🛟 Pool duty</button>`] : []),
    ...levelsInSlots.map((l) => {
      const code = (l.name || "").replace("Parents & Toddlers", "P&T").replace("Level ", "L");
      return `<button class="filterchip${State._rotaLevelFilter === l.id ? " active" : ""}" data-rlevel="${l.id}">${esc(code)}</button>`;
    }),
  ].join("") : "";

  const times = [...new Set(gridSlots.map((s) => s.start_time))].sort();

  // Role tab badge: lifeguard → 🛟, others → shortcode or first letter
  function roleTabBadge(r) {
    if (r.requires_training) return `<span class="rtab-icon">🛟</span>`;
    const code = r.shortcode || r.name[0].toUpperCase();
    return `<span class="rtab-badge" style="background:${r.color}">${esc(code)}</span>`;
  }

  const roleTabsHtml = [
    `<button class="filterchip${isAllView ? " active" : ""}" data-rtab="0">All</button>`,
    ...State.roles.map((r) =>
      `<button class="filterchip${r.id === State.rotaRole ? " active" : ""}" data-rtab="${r.id}"
        style="${r.id === State.rotaRole ? `background:${r.color};border-color:${r.color}` : `border-color:${r.color};color:${r.color}`}">${roleTabBadge(r)} ${esc(r.name)}</button>`),
  ].join("");

  mb.innerHTML = `
    <p class="small muted">Pick a person, then tick the slots you want to assign them to.${isAllView ? " Unqualified slots will be skipped with a reason." : " Assignments are approved immediately."}</p>
    <div class="filterbar" style="margin-bottom:4px">${roleTabsHtml}</div>
    ${levelChipsHtml ? `<div class="filterbar" style="margin-bottom:10px">${levelChipsHtml}</div>` : ""}

    <div class="card" style="margin-bottom:12px">
      <div class="between">
        <div class="field" style="margin:0;flex:1">
          <label>Assign to</label>
          <select id="rb-person">
            <option value="">— choose a person —</option>
            ${qualified.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join("")}
          </select>
        </div>
        <div style="display:flex;gap:6px;align-items:flex-end;padding-bottom:0">
          <button class="btn sub sm" id="rb-prev">‹</button>
          <span class="small" style="white-space:nowrap;padding:0 4px">${fmtDate(weekISO).slice(4)}–${fmtDate(weekEnd).slice(4)}</span>
          <button class="btn sub sm" id="rb-next">›</button>
        </div>
      </div>
    </div>

    <div id="rb-grid">
      ${times.length === 0 ? `<div class="empty">No slots this week.</div>` : buildRotaGrid(gridSlots, times, State._rotaWeekStart, isAllView, State.roles)}
    </div>

    <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn green" id="rb-apply" disabled>Assign selected slots</button>
      <button class="btn ghost sm" id="rb-clearsel">Clear selection</button>
      <span class="small muted" id="rb-selcount" style="align-self:center"></span>
    </div>`;

  // Level filter chips
  mb.querySelectorAll("[data-rlevel]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.rlevel;
    State._rotaLevelFilter = v === "" ? null : v === "duty" ? "duty" : Number(v);
    mb.querySelectorAll("[data-rlevel]").forEach((x) =>
      x.classList.toggle("active", x.dataset.rlevel === (State._rotaLevelFilter === null ? "" : String(State._rotaLevelFilter))));
    // Rebuild grid with new filter without full re-render
    const filtered = State._rotaLevelFilter === "duty"
      ? roleSlots.filter((s) => !s.level_id)
      : State._rotaLevelFilter
      ? roleSlots.filter((s) => s.level_id === State._rotaLevelFilter)
      : roleSlots;
    const newTimes = [...new Set(filtered.map((s) => s.start_time))].sort();
    document.getElementById("rb-grid").innerHTML =
      newTimes.length === 0 ? `<div class="empty">No slots this week.</div>` : buildRotaGrid(filtered, newTimes, State._rotaWeekStart, isAllView, State.roles);
    bindWeekGrid ? null : null; // re-bind cell click handlers
    mb.querySelectorAll(".rb-cell[data-sid]").forEach((cell) =>
      cell.addEventListener("click", () => {
        if (cell.dataset.taken) {
          const slot = roleSlots.find((s) => s.id === Number(cell.dataset.sid));
          if (slot) showSlotRemoveSheet(slot);
          return;
        }
        cell.classList.toggle("rb-sel");
        updateRotaCount();
      }));
    mb.querySelectorAll("[data-wg-expand]").forEach((btn) =>
      btn.addEventListener("click", (e) => { e.stopPropagation(); btn.nextElementSibling.style.display = ""; btn.remove(); }));
  }));

  // Role tab switching
  mb.querySelectorAll("[data-rtab]").forEach((b) => b.addEventListener("click", () => {
    State._rotaLevelFilter = null; // reset level filter on role change
    State.rotaRole = Number(b.dataset.rtab) || null; rotaBuilder();
  }));

  // Week nav
  $("#rb-prev").onclick = () => { State._rotaWeekStart = addDays(State._rotaWeekStart, -7); rotaBuilder(); };
  $("#rb-next").onclick = () => { State._rotaWeekStart = addDays(State._rotaWeekStart, 7); rotaBuilder(); };

  // Person change — refresh grid to highlight their existing assignments
  $("#rb-person").addEventListener("change", () => refreshRotaGrid(roleSlots, times, State._rotaWeekStart));

  // Cell toggle / admin removal
  mb.querySelectorAll(".rb-cell[data-sid]").forEach((cell) =>
    cell.addEventListener("click", () => {
      if (cell.dataset.taken) {
        const slot = roleSlots.find((s) => s.id === Number(cell.dataset.sid));
        if (slot) showSlotRemoveSheet(slot);
        return;
      }
      cell.classList.toggle("rb-sel");
      updateRotaCount();
    }));

  // Apply button
  $("#rb-apply").addEventListener("click", async () => {
    const uid = Number($("#rb-person").value);
    if (!uid) return toast("Choose a person first", "err");
    const ids = [...mb.querySelectorAll(".rb-sel[data-sid]")].map((c) => Number(c.dataset.sid));
    if (!ids.length) return toast("Select some slots first", "err");
    const btn = $("#rb-apply"); btn.disabled = true; btn.textContent = "Assigning…";
    try {
      const r = await api("/api/slots/bulk-assign", { method: "POST", body: { user_id: uid, slot_ids: ids, auto_approve: true } });
      if (r.assigned) toast(`Assigned ${r.assigned} slot${r.assigned !== 1 ? "s" : ""}`, "ok");
      // Show skipped details as a persistent panel
      const existing = document.getElementById("rb-skipped-panel");
      if (existing) existing.remove();
      if (r.skipped_details?.length) {
        const DOW_FULL = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
        const panel = document.createElement("div");
        panel.id = "rb-skipped-panel";
        panel.className = "rb-skip-panel";
        panel.innerHTML = `<strong>⚠ ${r.skipped_details.length} shift${r.skipped_details.length !== 1 ? "s" : ""} could not be assigned:</strong>
          <ul class="rb-skip-list">${r.skipped_details.map((d) => {
            if (!d.date) return `<li>${esc(d.reason)}</li>`;
            const dt = parseISO(d.date);
            const dow = DOW_FULL[dt.getDay() === 0 ? 6 : dt.getDay() - 1];
            const dateStr = `${dow} ${d.date.slice(8, 10)} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(d.date.slice(5,7))-1]}`;
            const lvl = d.level_name ? d.level_name.replace("Parents & Toddlers","P&T") : "Pool duty";
            return `<li><span class="rb-skip-slot">${dateStr} ${d.start_time} · ${esc(d.role_name)} ${esc(lvl)}</span><span class="rb-skip-reason">${esc(d.reason)}</span></li>`;
          }).join("")}</ul>`;
        mb.insertAdjacentElement("beforebegin", panel);
      }
      rotaBuilder();
    } catch (err) { toast(err.message, "err"); btn.disabled = false; btn.textContent = "Assign selected slots"; }
  });

  $("#rb-clearsel").addEventListener("click", () => {
    mb.querySelectorAll(".rb-sel").forEach((c) => c.classList.remove("rb-sel"));
    updateRotaCount();
  });
}

function buildRotaGrid(roleSlots, times, weekStart, allView = false, allRoles = []) {
  const today = isoToday();
  const DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const days = Array.from({length: 7}, (_, i) => {
    const d = addDays(weekStart, i);
    return { iso: toISO(d), label: DAYS_SHORT[i], num: d.getDate() };
  });

  const activeDays = days.filter((day) => roleSlots.some((s) => s.date === day.iso));
  if (!activeDays.length) return `<div class="empty">No slots this week.</div>`;

  const header = `<tr><th class="rg-time"></th>${activeDays.map((d) =>
    `<th class="rg-th${d.iso === today ? " rg-today" : ""}">${d.label}<br/><span class="rg-dnum">${d.num}</span></th>`
  ).join("")}</tr>`;

  const slotMap = {};
  for (const s of roleSlots) {
    const k = `${s.start_time}|${s.date}`;
    if (!slotMap[k]) slotMap[k] = [];
    slotMap[k].push(s);
  }

  // In all-view, sort each cell's slots by role sort_order then level
  const roleOrder = Object.fromEntries(allRoles.map((r, i) => [r.id, i]));

  const bodyRows = times.map((time) => {
    const cells = activeDays.map((day) => {
      const key = `${time}|${day.iso}`;
      let ss = slotMap[key] || [];
      if (!ss.length) return `<td class="rg-cell rg-empty"></td>`;
      if (allView) ss = [...ss].sort((a, b) => (roleOrder[a.role_id] ?? 99) - (roleOrder[b.role_id] ?? 99));
      return `<td class="rg-cell">${ss.map((s) => {
        const isPast = day.iso < today;
        const taken = s.status !== "open";
        const name = s.assigned_name ? s.assigned_name.split(" ")[0] : null;
        const cls = taken ? (s.status === "approved" ? "rg-taken-ok" : "rg-taken-pending") : isPast ? "rg-past" : "rg-open";
        const lvl = s.level_id
          ? (s.level_name || "").replace("Parents & Toddlers", "P&T").replace("Level ", "L")
          : "🛟";
        // In all-view, prefix each cell with a coloured role badge
        const role = allView ? allRoles.find((r) => r.id === s.role_id) : null;
        const roleBadge = role
          ? `<span class="rg-role-badge" style="background:${role.color}">${esc(role.requires_training ? "🛟" : (role.shortcode || role.name[0]))}</span>`
          : "";
        const label = taken
          ? `${roleBadge}${esc(name || s.status)} <span class="rg-lvl">${esc(lvl)}</span>`
          : `${roleBadge}<span class="rg-lvl">${esc(lvl)}</span>`;
        return `<div class="rb-cell ${cls}${allView ? "" : ""}" data-sid="${s.id}"${taken ? ` data-taken="1"` : ""} title="${taken ? (name || s.status) + " · " : ""}${role ? role.name + " · " : ""}${s.level_name || "Pool duty"}" style="margin-bottom:2px">${label}</div>`;
      }).join("")}</td>`;
    }).join("");
    return `<tr><td class="rg-time">${time}</td>${cells}</tr>`;
  }).join("");

  const legend = allView
    ? allRoles.map((r) => `<span class="rg-legend-role"><span class="rg-role-badge" style="background:${r.color}">${esc(r.requires_training ? "🛟" : (r.shortcode || r.name[0]))}</span> ${esc(r.name)}</span>`).join("")
    : `<span class="rb-cell rg-taken-ok" style="display:inline-block;padding:2px 8px">Approved</span>
       <span class="rb-cell rg-taken-pending" style="display:inline-block;padding:2px 8px">Pending</span>
       <span class="rb-cell rg-open" style="display:inline-block;padding:2px 8px">Open</span>
       <span class="rb-cell rg-sel" style="display:inline-block;padding:2px 8px">Selected</span>`;

  return `<div class="rg-scroll"><table class="rg-table"><thead>${header}</thead><tbody>${bodyRows}</tbody></table></div>
    <div class="rg-legend">${legend}</div>`;
}

function refreshRotaGrid(roleSlots, times, weekStart) {
  // Just visually update the grid — highlight the selected person's existing slots
  const uid = Number($("#rb-person")?.value);
  document.querySelectorAll(".rb-cell[data-sid]").forEach((cell) => {
    const slot = roleSlots.find((s) => s.id === Number(cell.dataset.sid));
    if (!slot) return;
    const isMine = slot.assigned_user_id === uid;
    if (isMine && !cell.dataset.taken) cell.classList.add("rb-sel");
  });
  updateRotaCount();
}

function updateRotaCount() {
  const sel = document.querySelectorAll(".rb-sel[data-sid]").length;
  const el = document.getElementById("rb-selcount");
  if (el) el.textContent = sel ? `${sel} slot${sel !== 1 ? "s" : ""} selected` : "";
  const applyBtn = document.getElementById("rb-apply");
  if (applyBtn) applyBtn.disabled = sel === 0;
}

async function manageUsers() {
  const mb = $("#manageBody");
  const users = await api("/api/users");
  mb.innerHTML = `
    <button class="btn block sub" id="addUser" style="margin-bottom:12px">＋ Add person</button>
    ${users.map((u) => `
      <div class="card" data-user="${u.id}" style="cursor:pointer">
        <div class="between">
          <div><strong>${esc(u.full_name)}</strong> ${u.is_admin ? `<span class="tag" style="background:var(--magenta)">Admin</span>` : ""}
            <div class="small muted">@${esc(u.username)} · ${u.roles.map((r) => esc(r.name)).join(", ") || "no roles"}</div></div>
          ${u.training_status !== "n/a" ? `<span class="pill ${u.training_status}">${u.training_status}</span>` : ""}
        </div>
      </div>`).join("")}`;
  $("#addUser").addEventListener("click", () => userSheet(null));
  mb.querySelectorAll("[data-user]").forEach((c) =>
    c.addEventListener("click", () => userSheet(users.find((u) => u.id == c.dataset.user))));
}

async function manageRoles() {
  const mb = $("#manageBody");
  const roles = await api("/api/roles");
  mb.innerHTML = `
    <p class="small muted">Add poolside roles as your team grows (e.g. Assistant Teacher, Duty Manager).</p>
    <button class="btn block sub" id="addRole" style="margin-bottom:12px">＋ Add role</button>
    ${roles.map((r) => `<div class="list-item">
      <div><span class="tag" style="background:${r.color}">${esc(r.name)}</span>
        ${r.requires_training ? `<span class="small muted"> · requires in-date training</span>` : ""}</div>
      <button class="btn sub sm" data-role="${r.id}">Edit</button>
    </div>`).join("")}`;
  $("#addRole").addEventListener("click", () => roleSheet(null));
  mb.querySelectorAll("[data-role]").forEach((b) =>
    b.addEventListener("click", () => roleSheet(roles.find((r) => r.id == b.dataset.role))));
}

async function manageLevels() {
  const mb = $("#manageBody");
  const [levels, staffing, roles] = await Promise.all([
    api("/api/bootstrap").then((b) => b.levels), api("/api/staffing"), api("/api/roles"),
  ]);
  State.roles = roles;
  mb.innerHTML = `
    <p class="small muted">Each class has default staffing. e.g. Parents & Toddlers = 1 Teacher + 1 Assistant.</p>
    <button class="btn block sub" id="addLevel" style="margin-bottom:12px">＋ Add class / level</button>
    ${levels.map((l) => {
      const st = staffing[l.id] || [];
      const desc = st.map((s) => `${s.count}× ${roleName(s.role_id)}`).join(" + ") || "no staffing set";
      return `<div class="card" data-level="${l.id}" style="cursor:pointer">
        <div class="between"><strong>${esc(l.name)}</strong><span class="small muted">›</span></div>
        <div class="small muted">${esc(desc)}</div></div>`;
    }).join("")}`;
  $("#addLevel").addEventListener("click", () => levelSheet(null, roles, {}));
  mb.querySelectorAll("[data-level]").forEach((c) =>
    c.addEventListener("click", () => levelSheet(
      levels.find((l) => l.id == c.dataset.level), roles, staffing[c.dataset.level] || [])));
}

// ------------------------------------------------------------------ CLASSES (levels + schedules)
async function manageClasses() {
  const mb = $("#manageBody");
  mb.innerHTML = `<div class="spinner"></div>`;
  const [bootstrap, staffing, roles, schedules] = await Promise.all([
    api("/api/bootstrap"),
    api("/api/staffing"),
    api("/api/roles"),
    api("/api/class-schedules"),
  ]);
  const levels = bootstrap.levels;
  State.roles = roles;

  // Group schedule sessions by level_id ("duty" for null)
  const schedByLevel = {};
  for (const s of schedules) {
    const key = s.level_id == null ? "duty" : s.level_id;
    (schedByLevel[key] ||= []).push(s);
  }

  function schedSummary(key) {
    const ss = schedByLevel[key] || [];
    if (!ss.length) return `<span class="small muted" style="color:var(--amber)">No schedule set</span>`;
    const days = [...new Set(ss.map((s) => DOW[s.weekday]))].join(", ");
    return `<span class="small muted">${ss.length} session${ss.length !== 1 ? "s" : ""} · ${days}</span>`;
  }

  mb.innerHTML = `
    <p class="small muted">Set up class schedules and assign default teachers. Sessions auto-generate 6 months forward.</p>
    <button class="btn block sub" id="addLevel" style="margin-bottom:12px">＋ Add class / level</button>

    <div class="card" style="border-left:4px solid var(--magenta);margin-bottom:10px">
      <div class="between">
        <div>
          <strong>Pool Duty (Lifeguards)</strong>
          <div style="margin-top:2px">${schedSummary("duty")}</div>
        </div>
        <button class="btn sub sm" id="dutySchedBtn">Schedule</button>
      </div>
    </div>

    ${levels.map((l) => {
      const st = staffing[l.id] || [];
      const desc = st.map((s) => `${s.count}× ${roleName(s.role_id)}`).join(" + ") || "no staffing";
      return `<div class="card" style="margin-bottom:10px">
        <div class="between">
          <div style="flex:1;min-width:0">
            <strong>${esc(l.name)}</strong>
            <div class="small muted">${esc(desc)}</div>
            <div style="margin-top:2px">${schedSummary(l.id)}</div>
          </div>
          <div style="display:flex;gap:8px;flex-shrink:0;margin-left:10px">
            <button class="btn ghost sm" data-level-edit="${l.id}">Edit</button>
            <button class="btn sub sm" data-level-sched="${l.id}">Schedule</button>
          </div>
        </div>
      </div>`;
    }).join("")}

    <div class="card" style="margin-top:16px">
      <strong>Generate shifts</strong>
      <p class="small muted" style="margin:6px 0 12px">Extend all scheduled shifts 6 months forward. Safe to run repeatedly — never duplicates.</p>
      <button class="btn block" id="genBtn">Extend to 6 months</button>
    </div>`;

  $("#addLevel").addEventListener("click", () => levelSheet(null, roles, {}));
  $("#dutySchedBtn").addEventListener("click", () =>
    classScheduleSheet(null, roles, schedByLevel["duty"] || []));

  mb.querySelectorAll("[data-level-edit]").forEach((b) =>
    b.addEventListener("click", () => {
      const l = levels.find((x) => x.id === Number(b.dataset.levelEdit));
      levelSheet(l, roles, staffing[l.id] || []);
    }));

  mb.querySelectorAll("[data-level-sched]").forEach((b) =>
    b.addEventListener("click", () => {
      const l = levels.find((x) => x.id === Number(b.dataset.levelSched));
      classScheduleSheet(l, roles, schedByLevel[l.id] || []);
    }));

  $("#genBtn").addEventListener("click", async () => {
    const btn = $("#genBtn");
    btn.disabled = true; btn.textContent = "Generating…";
    try {
      const r = await api("/api/generate", { method: "POST", body: { weeks: 26 } });
      toast(`${r.created} new shifts created (through ${r.to})`, "ok");
    } catch (err) { toast(err.message, "err"); }
    btn.disabled = false; btn.textContent = "Extend to 6 months";
  });
}

function classScheduleSheet(level, roles, existingSessions) {
  const levelRef = level ? level.id : "duty";
  const title = level ? `${esc(level.name)} — Schedule` : "Pool Duty — Schedule";
  const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

  // Local state: flat list of session objects
  // {weekday, start_time, end_time, role_id, role_name, user_id, user_name, count}
  let sessions = (existingSessions || []).map((s) => ({
    weekday: s.weekday, start_time: s.start_time, end_time: s.end_time,
    role_id: s.role_id, role_name: s.role_name,
    user_id: s.user_id, user_name: s.user_name || null,
    count: s.count || 1,
  }));

  const defaultRole = level
    ? (roles.find((r) => r.name === "Teacher") || roles[0])
    : (roles.find((r) => r.name === "Lifeguard") || roles[0]);
  const dayOpts = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("");
  const roleOpts = roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");

  openSheet(`
    <h2>${title}</h2>
    <div id="cs-list" style="margin:12px 0 6px"></div>
    <div style="background:var(--blue-soft);border-radius:12px;padding:14px;margin-bottom:14px">
      <div class="small" style="font-weight:700;margin-bottom:10px">Add session</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div class="field" style="margin:0;min-width:120px;flex:1.5">
          <label>Day</label><select id="cs-day">${dayOpts}</select>
        </div>
        <div class="field" style="margin:0;flex:1;min-width:90px">
          <label>Start</label><input id="cs-start" type="time" value="09:00" step="1800"/>
        </div>
        <div class="field" style="margin:0;flex:1;min-width:90px">
          <label>End</label><input id="cs-end" type="time" value="09:30" step="1800"/>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <div class="field" style="margin:0;flex:1;min-width:110px">
          <label>Role</label><select id="cs-role">${roleOpts}</select>
        </div>
        <div class="field" style="margin:0;flex:2;min-width:130px">
          <label>Assign to</label>
          <select id="cs-user"><option value="">Open — anyone</option></select>
        </div>
        <div class="field" style="margin:0;width:68px">
          <label>Count</label>
          <input id="cs-count" type="number" min="1" max="6" value="1" style="padding:10px 8px"/>
        </div>
      </div>
      <button class="btn sub block" id="cs-add" style="margin-top:10px">＋ Add this session</button>
    </div>
    <div style="display:flex;gap:10px">
      <button class="btn ghost block" id="cs-save">Save</button>
      <button class="btn block" id="cs-generate">Save + Generate 6 months</button>
    </div>`);

  function renderList() {
    const el = document.getElementById("cs-list");
    if (!el) return;
    if (!sessions.length) {
      el.innerHTML = `<div class="small muted" style="text-align:center;padding:10px">No sessions yet.</div>`;
      return;
    }
    // Group by weekday for display
    const byDay = {};
    sessions.forEach((s, i) => (byDay[s.weekday] ||= []).push({ ...s, _i: i }));
    el.innerHTML = Object.keys(byDay).sort((a, b) => a - b).map((wd) => `
      <div style="margin-bottom:10px">
        <div class="small" style="font-weight:700;color:var(--blue);margin-bottom:4px">${DAYS[wd]}</div>
        ${byDay[wd].map((s) => `
          <div style="display:flex;align-items:center;gap:8px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin-bottom:6px">
            <div style="flex:1">
              <span style="font-weight:700">${s.start_time}–${s.end_time}</span>
              <span class="small muted" style="margin-left:8px">${esc(s.role_name || "")}</span>
              ${s.user_name ? `<span class="small" style="margin-left:6px;color:var(--green);font-weight:700">→ ${esc(s.user_name.split(" ")[0])}</span>` : `<span class="small muted" style="margin-left:6px">Open</span>`}
              ${s.count > 1 ? `<span class="small muted"> ×${s.count}</span>` : ""}
            </div>
            <button class="btn danger sm" data-rm="${s._i}">✕</button>
          </div>`).join("")}
      </div>`).join("");
    el.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => { sessions.splice(Number(b.dataset.rm), 1); renderList(); }));
  }
  renderList();

  // Load qualified users when role changes
  const roleEl = document.getElementById("cs-role");
  const userEl = document.getElementById("cs-user");
  if (defaultRole) roleEl.value = defaultRole.id;

  async function loadUsers() {
    const rid = Number(roleEl.value);
    try {
      const users = await api("/api/users");
      const q = users.filter((u) => u.active !== false && u.roles.some((r) => r.id === rid));
      userEl.innerHTML = `<option value="">Open — anyone</option>` +
        q.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join("");
    } catch {}
  }
  loadUsers();
  roleEl.addEventListener("change", loadUsers);

  document.getElementById("cs-add").addEventListener("click", () => {
    const start = document.getElementById("cs-start").value;
    const end = document.getElementById("cs-end").value;
    if (!start || !end || start >= end) return toast("Set valid start and end times", "err");
    const rid = Number(roleEl.value);
    const uid = userEl.value ? Number(userEl.value) : null;
    const count = Number(document.getElementById("cs-count").value) || 1;
    const role = roles.find((r) => r.id === rid);
    const userName = uid ? userEl.options[userEl.selectedIndex].text : null;
    sessions.push({
      weekday: Number(document.getElementById("cs-day").value),
      start_time: start, end_time: end,
      role_id: rid, role_name: role?.name || "",
      user_id: uid, user_name: userName, count,
    });
    renderList();
  });

  async function save(andGenerate) {
    const saveBtn = document.getElementById("cs-save");
    const genBtn = document.getElementById("cs-generate");
    if (saveBtn) saveBtn.disabled = true;
    if (genBtn) genBtn.disabled = true;
    try {
      await api(`/api/class-schedules/level/${levelRef}`, {
        method: "PUT",
        body: {
          sessions: sessions.map((s) => ({
            weekday: s.weekday, start_time: s.start_time, end_time: s.end_time,
            role_id: s.role_id, user_id: s.user_id, count: s.count,
          })),
        },
      });
      if (andGenerate) {
        const r = await api("/api/generate", { method: "POST", body: { weeks: 26 } });
        toast(`Saved · ${r.created} new shifts created through ${r.to}`, "ok");
      } else {
        toast("Schedule saved", "ok");
      }
      closeSheet();
      manageClasses();
    } catch (err) {
      toast(err.message, "err");
      if (saveBtn) saveBtn.disabled = false;
      if (genBtn) genBtn.disabled = false;
    }
  }

  document.getElementById("cs-save").addEventListener("click", () => save(false));
  document.getElementById("cs-generate").addEventListener("click", () => save(true));
}

// ------------------------------------------------------------------ ADMIN DAY VIEW
async function adminDayView() {
  const mb = $("#manageBody");
  if (!State._adminDayDate) State._adminDayDate = isoToday();

  mb.innerHTML = `
    <p class="small muted">Overview of all classes for a given day.</p>
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <input type="date" id="adv-date" value="${State._adminDayDate}" style="flex:1;padding:10px 12px"/>
      <button class="btn sub sm" id="adv-today">Today</button>
    </div>
    <div id="adv-body"><div class="spinner"></div></div>`;

  async function loadDay(isoDate) {
    const body = document.getElementById("adv-body");
    if (!body) return;
    try {
      const slots = await api(`/api/slots?from=${isoDate}&to=${isoDate}`);
      if (!slots.length) {
        body.innerHTML = `<div class="empty">No shifts on ${fmtDate(isoDate)}.</div>`;
        return;
      }
      // Group by time slot
      const byTime = {};
      for (const s of slots) (byTime[s.start_time] ||= []).push(s);

      body.innerHTML = `<div class="day-head" style="margin-top:0">${fmtLong(isoDate)}</div>` +
        Object.keys(byTime).sort().map((time) => {
          const ss = byTime[time];
          const end = ss[0].end_time;
          const duty = ss.filter((s) => !s.level_id);
          const dutyApproved = duty.filter((s) => s.status === "approved").length;
          // Get distinct classes (lessons) at this time
          const classMap = new Map();
          ss.filter((s) => s.level_id).forEach((s) => {
            if (!classMap.has(s.level_id)) classMap.set(s.level_id, []);
            classMap.get(s.level_id).push(s);
          });
          const classRows = [...classMap.entries()].map(([lid, cslots]) => {
            const name = cslots[0].level_name;
            const approved = cslots.filter((s) => s.status === "approved");
            const teachers = approved.map((s) => s.assigned_name?.split(" ")[0]).filter(Boolean);
            const covered = approved.length > 0;
            return `<div class="list-item" style="padding:8px 0">
              <div>
                <span style="color:var(--blue);font-weight:700">${esc(name)}</span>
                ${teachers.length ? `<span class="small muted"> · ${teachers.join(", ")}</span>` : ""}
              </div>
              <span class="pill ${covered ? "approved" : "open"}">${covered ? "✓ Covered" : "Open"}</span>
            </div>`;
          }).join("");

          const lgShort = duty.length > 0 && dutyApproved < duty.length;
          return `<div class="card" style="margin-bottom:6px;padding:10px 14px${lgShort ? ";border-left:4px solid var(--red)" : ""}">
            <div class="between" style="margin-bottom:${classMap.size ? "6px" : "0"}">
              <strong style="font-size:.88rem">${time}–${end}</strong>
              ${duty.length
                ? `<span style="font-size:.78rem;font-weight:700;color:${lgShort ? "var(--red)" : "var(--green)"}">
                     ${lgShort ? "⚠️" : "✓"} ${dutyApproved}/${duty.length} LG
                   </span>`
                : ""}
            </div>
            ${classMap.size ? `<div style="border-top:1px solid var(--line);padding-top:4px">${classRows}</div>` : ""}
          </div>`;
        }).join("");
    } catch (err) {
      const body = document.getElementById("adv-body");
      if (body) body.innerHTML = `<div class="banner danger">${esc(err.message)}</div>`;
    }
  }

  document.getElementById("adv-date").addEventListener("change", (e) => {
    State._adminDayDate = e.target.value;
    loadDay(e.target.value);
  });
  document.getElementById("adv-today").addEventListener("click", () => {
    State._adminDayDate = isoToday();
    document.getElementById("adv-date").value = State._adminDayDate;
    loadDay(State._adminDayDate);
  });

  loadDay(State._adminDayDate);
}

// ------------------------------------------------------------------ PROFILE
async function viewProfile() {
  const u = State.user;
  const needsTraining = u.roles.some((r) => r.requires_training);
  screen().innerHTML = `
    <h1 class="section-title">My profile</h1>
    <div class="card stack">
      <div class="field"><label>Full name</label><input id="pf-name" value="${esc(u.full_name)}"/></div>
      <div class="field"><label>Email</label><input id="pf-email" type="email" value="${esc(u.email || "")}"/></div>
      <div class="field"><label>Phone</label><input id="pf-phone" value="${esc(u.phone || "")}"/></div>
      ${needsTraining ? `
        <div class="field"><label>Lifeguard training expiry ${
          u.training_status !== "valid" && u.training_status !== "n/a"
            ? `<span class="pill ${u.training_status}">${u.training_status}</span>` : ""}</label>
          <input id="pf-train" type="date" value="${esc(u.training_expiry || "")}"/>
          <p class="small muted" style="margin-top:6px">You must keep this in date to work lifeguard shifts.</p></div>` : ""}
      <button class="btn block" id="pf-save">Save changes</button>
    </div>
    <div class="card stack">
      <strong>Change password</strong>
      <div class="field"><label>New password</label><input id="pf-pass" type="password" placeholder="Leave blank to keep current"/></div>
      <button class="btn ghost block" id="pf-passbtn">Update password</button>
    </div>
    <div class="card">
      <div class="between"><strong>My roles</strong><span class="muted small">set by admin</span></div>
      <div class="chips" style="margin-top:10px">${u.roles.map((r) => `<span class="tag" style="background:${r.color}">${esc(r.name)}</span>`).join("") || `<span class="muted small">No roles assigned</span>`}</div>
    </div>
    <button class="btn danger block" id="pf-logout" style="margin-bottom:14px">Sign out</button>
    <div class="center small muted" id="installArea"></div>`;

  $("#pf-save").addEventListener("click", async () => {
    try {
      const body = { full_name: $("#pf-name").value, email: $("#pf-email").value, phone: $("#pf-phone").value };
      if (needsTraining) body.training_expiry = $("#pf-train").value || null;
      State.user = await api("/api/me", { method: "PATCH", body });
      toast("Profile saved", "ok"); renderShell();
    } catch (err) { toast(err.message, "err"); }
  });
  $("#pf-passbtn").addEventListener("click", async () => {
    const pw = $("#pf-pass").value;
    if (pw.length < 4) return toast("Password too short", "err");
    try { await api("/api/me", { method: "PATCH", body: { password: pw } }); $("#pf-pass").value = ""; toast("Password updated", "ok"); }
    catch (err) { toast(err.message, "err"); }
  });
  $("#pf-logout").addEventListener("click", () => { if (confirm("Sign out?")) logout(); });
  renderInstall();
}

// ------------------------------------------------------------------ MESSAGES
async function viewMessages() {
  loading();
  try {
    State._channels = await api("/api/channels");
  } catch (err) { screen().innerHTML = `<div class="banner danger">${esc(err.message)}</div>`; return; }

  // Sync global badge with server-reported unreads
  const totalUnread = State._channels.reduce((s, c) => s + (c.unread || 0), 0);
  State.msgUnread = 0;
  updateMsgBadge(totalUnread);

  if (State.activeChannel) {
    const ch = State._channels.find((c) => c.id === State.activeChannel);
    if (ch) { openChannel(ch); return; }
    State.activeChannel = null;
  }
  renderChannelList();
}

function chRow(ch) {
  const avatar = ch.type === "dm" ? "💬" : esc(ch.name[0]);
  const preview = ch.last_message
    ? esc(ch.last_message.full_name.split(" ")[0] + ": " + ch.last_message.body.slice(0, 60))
    : `<span class="muted">No messages yet</span>`;
  const badge = ch.unread
    ? `<span class="ch-unread" data-ch-unread="${ch.id}">${ch.unread > 99 ? "99+" : ch.unread}</span>`
    : "";
  return `
    <div class="ch-row" data-ch="${ch.id}">
      <div class="ch-avatar${ch.type === "dm" ? " ch-avatar-dm" : ""}" style="background:${ch.color}">${avatar}</div>
      <div class="ch-info">
        <div class="between">
          <strong>${esc(ch.name)}</strong>
          ${badge}
        </div>
        <div class="ch-preview" data-ch-preview="${ch.id}">${preview}</div>
      </div>
    </div>`;
}

function renderChannelList() {
  State.activeChannel = null;
  const chs = State._channels;
  const dms = chs.filter((c) => c.type === "dm");
  const channels = chs.filter((c) => c.type !== "dm");
  const hasBoth = dms.length > 0 && channels.length > 0;

  let body = "";
  if (!chs.length) {
    body = `<div class="empty"><div class="big">💬</div>You're not in any channels yet.<br/><span class="small muted">Ask an admin to add you.</span></div>`;
  } else {
    if (channels.length) {
      body += `${hasBoth ? `<div class="ch-section">Channels</div>` : ""}${channels.map(chRow).join("")}`;
    }
    if (dms.length) {
      body += `${hasBoth ? `<div class="ch-section">Direct Messages</div>` : ""}${dms.map(chRow).join("")}`;
    }
  }

  screen().innerHTML = `
    <div class="between" style="margin-bottom:14px">
      <h1 class="section-title" style="margin:0">Messages</h1>
      ${State.user.is_admin ? `<button class="btn sub sm" id="newChBtn">＋ New channel</button>` : ""}
    </div>
    ${body}
    ${State.user.is_admin ? `<div class="divider"></div><button class="btn ghost block" id="manageChBtn" style="margin-top:4px">Manage channels</button>` : ""}
  `;
  screen().querySelectorAll("[data-ch]").forEach((el) =>
    el.addEventListener("click", () => {
      const ch = chs.find((c) => c.id === Number(el.dataset.ch));
      if (ch) openChannel(ch);
    }));
  $("#newChBtn")?.addEventListener("click", () => channelSheet(null));
  $("#manageChBtn")?.addEventListener("click", () => adminChannels());
}

async function openChannel(ch) {
  State.activeChannel = ch.id;
  // Clear per-channel unread and adjust global badge
  const cached = State._channels.find((c) => c.id === ch.id);
  if (cached && cached.unread) {
    updateMsgBadge(-cached.unread);
    cached.unread = 0;
  }
  const isDm = ch.type === "dm";
  const avatarLabel = isDm ? "💬" : esc(ch.name[0]);
  const subtitle = isDm
    ? (ch.dm_user_id === State.user.id ? "Your direct line to admins" : "Direct message thread")
    : `${ch.member_count} member${ch.member_count !== 1 ? "s" : ""}`;
  screen().innerHTML = `
    <div class="chat-header">
      <button class="btn sub sm" id="chatBack">‹ Back</button>
      <div class="ch-avatar sm${isDm ? " ch-avatar-dm" : ""}" style="background:${ch.color}">${avatarLabel}</div>
      <div>
        <strong>${esc(ch.name)}</strong>
        <div class="small muted">${subtitle}</div>
      </div>
      ${State.user.is_admin && !isDm ? `<button class="btn sub sm" style="margin-left:auto" id="chEditBtn">Edit</button>` : ""}
    </div>
    <div class="chat-body" id="chatBody"><div class="spinner"></div></div>
    <div class="chat-input-bar">
      <textarea id="chatInput" placeholder="Type a message…" rows="1"></textarea>
      <button class="chat-send" id="chatSend" disabled>➤</button>
    </div>`;

  $("#chatBack").addEventListener("click", () => { State.activeChannel = null; renderChannelList(); });
  $("#chEditBtn")?.addEventListener("click", () => channelSheet(ch));

  const input = $("#chatInput");
  const sendBtn = $("#chatSend");

  // auto-resize textarea
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
    sendBtn.disabled = !input.value.trim();
  });

  // send on Enter (Shift+Enter = newline)
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(ch.id, input, sendBtn); }
  });
  sendBtn.addEventListener("click", () => sendMessage(ch.id, input, sendBtn));

  // load history
  try {
    const msgs = await api(`/api/channels/${ch.id}/messages`);
    const body = $("#chatBody");
    if (!msgs.length) {
      body.innerHTML = `<div class="empty" style="padding:40px 20px"><div class="big">💬</div>Be the first to say something!</div>`;
    } else {
      body.innerHTML = "";
      msgs.forEach((m) => appendBubble(m));
      scrollChatBottom(true);
    }
  } catch (err) {
    $("#chatBody").innerHTML = `<div class="banner danger">${esc(err.message)}</div>`;
  }
}

function appendBubble(msg) {
  const body = document.getElementById("chatBody");
  if (!body) return;
  const mine = msg.user_id === State.user?.id;
  const time = new Date(msg.sent_at + (msg.sent_at.includes("Z") ? "" : "Z"))
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const div = document.createElement("div");
  div.className = `bubble-wrap ${mine ? "mine" : "theirs"}`;
  div.dataset.mid = msg.id;
  div.innerHTML = `
    ${!mine ? `<div class="bubble-name">${esc(msg.full_name)}</div>` : ""}
    <div class="bubble">${esc(msg.body).replace(/\n/g, "<br/>")}</div>
    <div class="bubble-time">${time}</div>`;
  body.appendChild(div);
}

function scrollChatBottom(instant) {
  const body = document.getElementById("chatBody");
  if (body) body.scrollTo({ top: body.scrollHeight, behavior: instant ? "instant" : "smooth" });
}

async function sendMessage(channelId, input, btn) {
  const body = input.value.trim();
  if (!body) return;
  btn.disabled = true;
  input.value = "";
  input.style.height = "auto";
  try {
    await api(`/api/channels/${channelId}/messages`, { method: "POST", body: { body } });
    // SSE will deliver it back to us — we add the bubble there
  } catch (err) { toast(err.message, "err"); input.value = body; }
  btn.disabled = false;
  input.focus();
}

// ---- admin channel management ----
async function adminChannels() {
  const chs = await api("/api/channels");
  const allUsers = await api("/api/users");
  screen().innerHTML = `
    <div class="between" style="margin-bottom:14px">
      <h1 class="section-title" style="margin:0">Channels</h1>
      <button class="btn sub sm" id="newChBtn2">＋ New channel</button>
    </div>
    <button class="btn ghost sm" id="backToMsgs" style="margin-bottom:14px">‹ Back to messages</button>
    ${chs.filter((c) => c.type !== "dm").map((ch) => {
      const linkedRole = ch.role_id ? State.roles.find((r) => r.id === ch.role_id) : null;
      return `
      <div class="card" style="margin-bottom:10px;border-left:4px solid ${ch.color}">
        <div class="between">
          <div><strong>${esc(ch.name)}</strong>
            <div class="small muted">${ch.member_count} members${linkedRole ? ` · <span style="color:${linkedRole.color}">⚙ ${esc(linkedRole.name)}</span>` : ""}${ch.description ? " · " + esc(ch.description) : ""}</div>
          </div>
          <button class="btn sub sm" data-edit-ch="${ch.id}">Edit</button>
        </div>
      </div>`;
    }).join("")}`;
  $("#backToMsgs").addEventListener("click", () => renderChannelList());
  $("#newChBtn2").addEventListener("click", () => channelSheet(null, allUsers));
  screen().querySelectorAll("[data-edit-ch]").forEach((b) =>
    b.addEventListener("click", () => channelSheet(chs.find((c) => c.id === Number(b.dataset.editCh)), allUsers)));
}

async function channelSheet(ch, allUsers) {
  if (!allUsers) allUsers = await api("/api/users");
  const isNew = !ch;
  let members = [];
  if (!isNew) {
    try { members = await api(`/api/channels/${ch.id}/members`); } catch {}
  }
  const memberIds = new Set(members.map((m) => m.id));
  const viaRoleIds = new Set(members.filter((m) => m.via_role).map((m) => m.id));
  const userChecks = allUsers.map((u) => `
    <label class="checkrow ${memberIds.has(u.id) ? "on" : ""}">
      <input type="checkbox" value="${u.id}" ${memberIds.has(u.id) ? "checked" : ""}/>
      ${esc(u.full_name)} <span class="muted small">· ${esc(u.roles.map(r=>r.name).join(", ") || "no roles")}</span>
      ${viaRoleIds.has(u.id) ? `<span class="pill small" style="font-size:.65rem;padding:1px 6px;margin-left:4px">auto</span>` : ""}
    </label>`).join("");

  const roleOpts = `<option value="">None (manual members only)</option>` +
    State.roles.map((r) => `<option value="${r.id}" ${ch?.role_id === r.id ? "selected" : ""}>${esc(r.name)}</option>`).join("");

  const sheet = openSheet(`
    <h2>${isNew ? "New channel" : "Edit: " + esc(ch.name)}</h2>
    <div class="stack" style="margin-top:14px">
      <div class="field"><label>Channel name</label><input id="cs-name" value="${esc(ch?.name||"")}" placeholder="e.g. Lifeguards"/></div>
      <div class="field"><label>Description (optional)</label><input id="cs-desc" value="${esc(ch?.description||"")}" placeholder="What this channel is for"/></div>
      <div class="field"><label>Colour</label><input id="cs-color" type="color" value="${ch?.color||"#26358B"}" style="height:48px;padding:4px"/></div>
      <div class="field">
        <label>Linked role</label>
        <select id="cs-role-link">${roleOpts}</select>
        <p class="small muted" style="margin-top:4px">Users get added/removed from this channel automatically when the role is assigned or removed.</p>
      </div>
      <div class="field"><label>Additional members</label><div id="cs-members" class="stack">${userChecks}</div></div>
      <button class="btn block" id="cs-save">${isNew ? "Create channel" : "Save changes"}</button>
      ${!isNew ? `<button class="btn danger block" id="cs-del" style="margin-top:6px">Delete channel</button>` : ""}
    </div>`);

  sheet.querySelectorAll(".checkrow input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", () => cb.closest(".checkrow").classList.toggle("on", cb.checked)));

  $("#cs-save").addEventListener("click", async () => {
    const name = $("#cs-name").value.trim();
    if (!name) return toast("Name required", "err");
    const member_ids = [...sheet.querySelectorAll("#cs-members input:checked")].map((c) => Number(c.value));
    const roleLink = $("#cs-role-link").value;
    const body = { name, description: $("#cs-desc").value.trim(), color: $("#cs-color").value, member_ids,
                   role_id: roleLink ? Number(roleLink) : null };
    try {
      if (isNew) await api("/api/channels", { method: "POST", body });
      else await api(`/api/channels/${ch.id}`, { method: "PATCH", body });
      closeSheet();
      toast("Saved", "ok");
      State._channels = await api("/api/channels");
      adminChannels();
    } catch (err) { toast(err.message, "err"); }
  });

  $("#cs-del")?.addEventListener("click", async () => {
    if (!confirm(`Delete channel "${ch.name}"? This cannot be undone.`)) return;
    try {
      await api(`/api/channels/${ch.id}`, { method: "DELETE" });
      closeSheet(); toast("Channel deleted", "ok");
      State._channels = await api("/api/channels");
      renderChannelList();
    } catch (err) { toast(err.message, "err"); }
  });
}

function showWeekRequestSheet(slotId, desc, date, time) {
  const dateStr = date ? fmtDate(date) : "";
  openSheet(`
    <h2 style="margin-bottom:12px">Request this shift?</h2>
    <div class="detail-rows">
      <div class="detail-row"><span>Class</span><strong>${esc(desc || "")}</strong></div>
      <div class="detail-row"><span>Date</span><strong>${esc(dateStr)}</strong></div>
      <div class="detail-row"><span>Time</span><strong>${esc(time || "")}</strong></div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px">
      <button class="btn green" id="wkr-confirm">Confirm request</button>
      <button class="btn ghost" id="wkr-cancel">Cancel</button>
    </div>`);
  document.getElementById("wkr-confirm").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Requesting…";
    try {
      await api(`/api/slots/${slotId}/request`, { method: "POST" });
      closeSheet(); toast("Requested — awaiting approval", "ok");
      await refreshNotif(); renderView();
    } catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "Confirm request"; }
  });
  document.getElementById("wkr-cancel").addEventListener("click", closeSheet);
}

function showWeekNamesSheet(names, desc, date, time, openSlotId) {
  const dateStr = date ? fmtDate(date) : "";
  const nameList = (names || "").split(", ").filter(Boolean);
  openSheet(`
    <h2 style="margin-bottom:4px">${esc(desc || "Shift")}</h2>
    <p class="small muted" style="margin-bottom:14px">${esc(dateStr)}${time ? " · " + esc(time) : ""}</p>
    <div class="detail-rows">
      ${nameList.map((n) => `<div class="detail-row"><span>Staff</span><strong>${esc(n)}</strong></div>`).join("")}
    </div>
    ${openSlotId ? `
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--line)"/>
    <p class="small muted" style="margin-bottom:12px">There is still an open slot — would you like to request it?</p>
    <div style="display:flex;gap:10px">
      <button class="btn green" id="wkn-req">Request this shift</button>
      <button class="btn ghost" id="wkn-close">Cancel</button>
    </div>` : `<button class="btn ghost block" id="wkn-close" style="margin-top:20px">Close</button>`}`);
  document.getElementById("wkn-close").addEventListener("click", closeSheet);
  if (openSlotId) {
    document.getElementById("wkn-req").addEventListener("click", async (e) => {
      e.target.disabled = true; e.target.textContent = "Requesting…";
      try {
        await api(`/api/slots/${openSlotId}/request`, { method: "POST" });
        closeSheet(); toast("Requested — awaiting approval", "ok");
        await refreshNotif(); renderView();
      } catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "Request this shift"; }
    });
  }
}

function showSlotRemoveSheet(slot) {
  const lvl = slot.level_name || "Pool duty (Lifeguard)";
  const firstName = (slot.assigned_name || "them").split(" ")[0];
  const dateStr = fmtDate(slot.date);
  openSheet(`
    <h2 style="margin-bottom:16px">Remove shift?</h2>
    <div class="detail-rows">
      <div class="detail-row"><span>Person</span><strong>${esc(slot.assigned_name || "")}</strong></div>
      <div class="detail-row"><span>Date</span><strong>${esc(dateStr)}</strong></div>
      <div class="detail-row"><span>Time</span><strong>${slot.start_time}–${slot.end_time}</strong></div>
      <div class="detail-row"><span>Role</span><strong>${esc(slot.role_name || "")}</strong></div>
      <div class="detail-row"><span>Class</span><strong>${esc(lvl)}</strong></div>
    </div>
    <div class="field" style="margin-top:16px">
      <label>Reason <span class="muted" style="font-weight:400;font-size:.78rem">(optional — leave blank if no reason)</span></label>
      <textarea id="sr-reason" rows="2" placeholder="e.g. Schedule change" style="resize:none"></textarea>
      <p class="small muted" style="margin-top:4px">This reason will be sent as a direct message to ${esc(firstName)} automatically.</p>
    </div>
    <div style="margin-top:16px;display:flex;gap:10px">
      <button class="btn danger" id="sr-confirm">Yes, remove</button>
      <button class="btn ghost" id="sr-cancel">Cancel</button>
    </div>`);
  document.getElementById("sr-confirm").addEventListener("click", async (e) => {
    e.target.disabled = true; e.target.textContent = "Removing…";
    const reason = document.getElementById("sr-reason")?.value.trim() || "";
    try {
      await api(`/api/slots/${slot.id}/release`, { method: "POST", body: { reason } });
      closeSheet();
      toast(`${firstName}'s shift removed`, "ok");
      rotaBuilder();
    } catch (err) { toast(err.message, "err"); e.target.disabled = false; e.target.textContent = "Yes, remove"; }
  });
  document.getElementById("sr-cancel").addEventListener("click", closeSheet);
}

// ------------------------------------------------------------------ sheets/modals
function openSheet(html) {
  closeSheet();
  const bd = document.createElement("div");
  bd.className = "sheet-backdrop"; bd.id = "sheetBackdrop";
  bd.innerHTML = `<div class="sheet"><div class="grip"></div>${html}</div>`;
  bd.addEventListener("click", (e) => { if (e.target === bd) closeSheet(); });
  document.body.appendChild(bd);
  return bd;
}
function closeSheet() { document.getElementById("sheetBackdrop")?.remove(); }

function userSheet(u) {
  const isNew = !u;
  const roleChecks = State.roles.map((r) => `
    <label class="checkrow ${u?.roles?.some((x) => x.id === r.id) ? "on" : ""}">
      <input type="checkbox" value="${r.id}" ${u?.roles?.some((x) => x.id === r.id) ? "checked" : ""}/>
      <span class="tag" style="background:${r.color}">${esc(r.name)}</span>
    </label>`).join("");
  const sheet = openSheet(`
    <h2>${isNew ? "Add person" : esc(u.full_name)}</h2>
    <div class="stack" style="margin-top:14px">
      <div class="field"><label>Full name</label><input id="u-name" value="${esc(u?.full_name || "")}"/></div>
      <div class="field"><label>Username</label><input id="u-username" value="${esc(u?.username || "")}" ${isNew ? "" : "disabled"} autocapitalize="none"/></div>
      <div class="field"><label>Email</label><input id="u-email" type="email" value="${esc(u?.email || "")}"/></div>
      <div class="field"><label>Phone</label><input id="u-phone" value="${esc(u?.phone || "")}"/></div>
      <div class="field"><label>${isNew ? "Password" : "Reset password (blank = unchanged)"}</label><input id="u-pass" type="password" placeholder="${isNew ? "default: password" : ""}"/></div>
      <div class="field"><label>Lifeguard training expiry</label><input id="u-train" type="date" value="${esc(u?.training_expiry || "")}"/></div>
      <div class="field"><label>Roles / qualifications</label>${roleChecks}</div>
      <label class="checkrow ${u?.is_admin ? "on" : ""}"><input type="checkbox" id="u-admin" ${u?.is_admin ? "checked" : ""}/> Administrator access</label>
      ${!isNew ? `<label class="checkrow ${u?.active === false ? "" : "on"}"><input type="checkbox" id="u-active" ${u?.active === false ? "" : "checked"}/> Active (can sign in)</label>` : ""}
      <button class="btn block" id="u-save">${isNew ? "Create person" : "Save changes"}</button>
    </div>`);
  sheet.querySelectorAll(".checkrow input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", () => cb.closest(".checkrow").classList.toggle("on", cb.checked)));
  $("#u-save").addEventListener("click", async () => {
    const role_ids = [...sheet.querySelectorAll('.field input[type=checkbox]:checked')].map((c) => Number(c.value)).filter(Boolean);
    const body = {
      full_name: $("#u-name").value, email: $("#u-email").value, phone: $("#u-phone").value,
      training_expiry: $("#u-train").value || null, is_admin: $("#u-admin").checked, role_ids,
    };
    if ($("#u-pass").value) body.password = $("#u-pass").value;
    try {
      if (isNew) { body.username = $("#u-username").value; await api("/api/users", { method: "POST", body }); }
      else { if ($("#u-active")) body.active = $("#u-active").checked; await api(`/api/users/${u.id}`, { method: "PATCH", body }); }
      closeSheet(); toast("Saved", "ok"); manageUsers();
    } catch (err) { toast(err.message, "err"); }
  });
}

function roleSheet(r) {
  const isNew = !r;
  const sheet = openSheet(`
    <h2>${isNew ? "Add role" : "Edit role"}</h2>
    <div class="stack" style="margin-top:14px">
      <div class="field"><label>Role name</label><input id="r-name" value="${esc(r?.name || "")}" placeholder="e.g. Assistant Teacher"/></div>
      <div class="field"><label>Short code <span class="muted" style="font-weight:400;font-size:.78rem">(1–2 letters shown on rota tabs, e.g. T or AT)</span></label><input id="r-code" value="${esc(r?.shortcode || "")}" maxlength="2" placeholder="e.g. T" style="max-width:80px;text-transform:uppercase"/></div>
      <div class="field"><label>Colour</label><input id="r-color" type="color" value="${r?.color || "#0E9F8E"}" style="height:48px;padding:4px"/></div>
      <label class="checkrow ${r?.requires_training ? "on" : ""}"><input type="checkbox" id="r-train" ${r?.requires_training ? "checked" : ""}/> Requires in-date training (like lifeguards)</label>
      <button class="btn block" id="r-save">Save</button>
    </div>`);
  $("#r-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });
  $("#r-train").addEventListener("change", (e) => e.target.closest(".checkrow").classList.toggle("on", e.target.checked));
  $("#r-save").addEventListener("click", async () => {
    const body = { name: $("#r-name").value, color: $("#r-color").value, requires_training: $("#r-train").checked, shortcode: $("#r-code").value.toUpperCase() || null };
    if (!body.name) return toast("Name required", "err");
    try {
      if (isNew) await api("/api/roles", { method: "POST", body });
      else await api(`/api/roles/${r.id}`, { method: "PATCH", body });
      State.roles = await api("/api/roles");
      closeSheet(); toast("Saved", "ok"); manageRoles();
    } catch (err) { toast(err.message, "err"); }
  });
}

function levelSheet(l, roles, staffing) {
  const isNew = !l;
  const rows = roles.map((r) => {
    const cur = staffing.find((s) => s.role_id === r.id)?.count || 0;
    return `<div class="row" style="justify-content:space-between;margin-bottom:8px">
      <span class="tag" style="background:${r.color}">${esc(r.name)}</span>
      <input type="number" min="0" max="6" value="${cur}" data-role="${r.id}" style="max-width:84px"/></div>`;
  }).join("");
  const sheet = openSheet(`
    <h2>${isNew ? "Add class / level" : esc(l.name)}</h2>
    <div class="stack" style="margin-top:14px">
      <div class="field"><label>Class name</label><input id="l-name" value="${esc(l?.name || "")}" placeholder="e.g. Level 11"/></div>
      <div class="field"><label>Default staffing per class</label>${rows}</div>
      <button class="btn block" id="l-save">Save</button>
    </div>`);
  $("#l-save").addEventListener("click", async () => {
    const name = $("#l-name").value;
    if (!name) return toast("Name required", "err");
    const items = [...sheet.querySelectorAll("input[data-role]")]
      .map((i) => ({ role_id: Number(i.dataset.role), count: Number(i.value) }))
      .filter((x) => x.count > 0);
    try {
      let id = l?.id;
      if (isNew) { const r = await api("/api/levels", { method: "POST", body: { name } }); id = r.id; }
      else if (name !== l.name) await api(`/api/levels/${id}`, { method: "PATCH", body: { name } });
      await api(`/api/levels/${id}/staffing`, { method: "PUT", body: { items } });
      closeSheet(); toast("Saved", "ok"); manageLevels();
    } catch (err) { toast(err.message, "err"); }
  });
}

// ------------------------------------------------------------------ notifications
async function refreshNotif() {
  try {
    const n = await api("/api/notifications");
    State.notifUnread = n.unread;
    const btn = document.getElementById("notifBtn");
    if (btn) btn.innerHTML = `🔔${State.notifUnread ? `<span class="dot">${State.notifUnread}</span>` : ""}`;
    return n;
  } catch { return { rows: [] }; }
}

async function openNotifications() {
  const n = await refreshNotif();
  const sheet = openSheet(`
    <h2>Notifications</h2>
    <div class="stack" style="margin-top:12px">
      ${n.rows?.length ? n.rows.map((r) => `
        <div class="card" style="margin:0;${r.read ? "" : "border-left:4px solid var(--magenta)"}">
          <div>${esc(r.message)}</div>
          <div class="small muted" style="margin-top:4px">${new Date(r.created_at + "Z").toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</div>
        </div>`).join("") : `<div class="empty">No notifications.</div>`}
    </div>`);
  await api("/api/notifications/read-all", { method: "POST" });
  refreshNotif();
}

// ------------------------------------------------------------------ PWA install
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; });
function renderInstall() {
  const area = document.getElementById("installArea");
  if (!area) return;
  if (deferredPrompt) {
    area.innerHTML = `<button class="btn sub" id="installBtn">📲 Install app on this device</button>`;
    $("#installBtn").addEventListener("click", async () => {
      deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; renderInstall();
    });
  } else {
    area.innerHTML = `Add to Home Screen via your browser's share menu for the full app experience.`;
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  if (!State.token) { renderLogin(); return; }
  try {
    const data = await api("/api/bootstrap");
    State.user = data.user;
    State.roles = data.roles;
    State.levels = data.levels;
    State.serverDate = data.server_date;
    State.view = "home";
    renderShell();
    refreshNotif();
    connectSSE();
  } catch (err) {
    logout();
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Re-fetch shift data when the user returns to the app, and every 3 minutes while it's open.
// Only Home and My Shifts are refreshed; admin/messages/profile are left alone.
// Skips when the page is hidden so no wasted requests while the phone is locked.
function refreshShiftViews() {
  if (document.visibilityState !== "visible") return;
  if (!State.token || !State.user) return;
  if (State.view === "home") viewHome();
  else if (State.view === "myshifts") viewMyShifts();
  else if (State.view === "calendar") viewCalendar();
}
document.addEventListener("visibilitychange", refreshShiftViews);
setInterval(refreshShiftViews, 3 * 60 * 1000);

boot();
