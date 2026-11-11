const STAGES = [
  { id: "new_lead", label: "New Lead" },
  { id: "contact_attempted", label: "Contact Attempted" },
  { id: "connected", label: "Connected" },
  { id: "interested", label: "Interested" },
  { id: "walkthrough_scheduled", label: "Walkthrough Scheduled" },
  { id: "walkthrough_completed", label: "Walkthrough Completed" },
  { id: "proposal_sent", label: "Proposal Sent" },
  { id: "follow_up", label: "Follow-Up" },
  { id: "verbal_approval", label: "Verbal Approval" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
  { id: "nurture", label: "Nurture" },
];

const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));

const state = {
  view: "dashboard",
  opportunities: [],
  detail: null,
  pendingLost: null, // { id, after }
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    location.href = "/login";
    throw new Error("unauthorized");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showFlash(msg, isError = false) {
  const el = $("#flash");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(showFlash._t);
  showFlash._t = setTimeout(() => el.classList.add("hidden"), 4000);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: iso.includes("T") ? "numeric" : undefined,
    minute: iso.includes("T") ? "2-digit" : undefined,
  });
}

function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function fmtMoney(cents) {
  if (cents == null || cents === "") return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    Number(cents) / 100,
  );
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function setView(view) {
  state.view = view;
  $$("#nav [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  [
    "dashboard",
    "opportunities",
    "detail",
    "contacts",
    "activities",
    "followups",
    "customers",
    "settings",
  ].forEach((v) => {
    $(`#view-${v}`)?.classList.toggle("hidden", view !== v);
  });
}

function fillStageSelect(sel, selected = "new_lead") {
  sel.innerHTML = STAGES.map(
    (s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${s.label}</option>`,
  ).join("");
}

/* ---------- dashboard ---------- */

async function loadDashboard() {
  const from = $("#dash-from").value;
  const to = $("#dash-to").value;
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const d = await api(`/api/dashboard?${qs}`);
  $("#dash-metrics").innerHTML = `
    <div class="metric"><div class="label">Open opps</div><div class="value">${d.open_opportunities}</div></div>
    <div class="metric"><div class="label">Commercial</div><div class="value">${d.commercial}</div></div>
    <div class="metric"><div class="label">Residential</div><div class="value">${d.residential}</div></div>
    <div class="metric"><div class="label">Est. MRR</div><div class="value">${escapeHtml(fmtMoney(d.estimated_mrr_cents))}</div></div>
    <div class="metric"><div class="label">Quoted MRR</div><div class="value">${escapeHtml(fmtMoney(d.quoted_mrr_cents))}</div></div>
    <div class="metric"><div class="label">Follow-ups overdue</div><div class="value">${d.followups_overdue}</div></div>
    <div class="metric"><div class="label">Follow-ups today</div><div class="value">${d.followups_today}</div></div>
    <div class="metric"><div class="label">Activities</div><div class="value">${d.activities}</div></div>`;
}

/* ---------- opportunities ---------- */

function oppQuery() {
  const qs = new URLSearchParams();
  const q = $("#opp-search").value.trim();
  const type = $("#opp-filter-type").value;
  const stage = $("#opp-filter-stage").value;
  const source = $("#opp-filter-source").value.trim();
  if (q) qs.set("q", q);
  if (type) qs.set("type", type);
  if (stage) qs.set("stage", stage);
  if (source) qs.set("source", source);
  return qs.toString();
}

async function loadPipeline() {
  const { opportunities } = await api(`/api/opportunities?${oppQuery()}`);
  state.opportunities = opportunities;
  const board = $("#pipeline-board");
  board.innerHTML = "";
  for (const stage of STAGES) {
    const col = document.createElement("div");
    col.className = "column";
    col.dataset.stage = stage.id;
    const items = opportunities.filter((d) => d.stage === stage.id);
    col.innerHTML = `<h3>${stage.label} <span>${items.length}</span></h3>`;
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.style.outline = "2px dashed var(--brand)";
    });
    col.addEventListener("dragleave", () => {
      col.style.outline = "";
    });
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.style.outline = "";
      const id = e.dataTransfer.getData("text/opp-id");
      if (!id) return;
      await moveStage(Number(id), stage.id);
    });

    for (const d of items) {
      const card = document.createElement("div");
      card.className = "deal";
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/opp-id", String(d.id));
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-move]")) return;
        openOpportunity(d.id);
      });
      const site = [d.address, d.city].filter(Boolean).join(", ");
      const follow = d.next_follow_up_at ? ` · FU ${fmtDay(d.next_follow_up_at)}` : "";
      card.innerHTML = `
        <strong>${escapeHtml(d.account_name)}</strong>
        <div class="meta">${escapeHtml(site || d.cleaning_type || d.account_type)} · ${escapeHtml(fmtMoney(d.quoted_mrr_cents || d.estimated_mrr_cents))}${escapeHtml(follow)}</div>
        <div class="actions">
          ${STAGES.filter((s) => s.id !== d.stage)
            .slice(0, 4)
            .map(
              (s) =>
                `<button type="button" data-move="${d.id}" data-stage="${s.id}">→ ${s.label}</button>`,
            )
            .join("")}
        </div>`;
      col.appendChild(card);
    }
    board.appendChild(col);
  }
}

async function moveStage(id, stage) {
  if (stage === "lost") {
    state.pendingLost = {
      id,
      after: async () => {
        await loadPipeline();
        if (state.view === "detail" && state.detail?.opportunity?.id === id) await openOpportunity(id);
      },
    };
    $("#lost-modal-reason").value = "";
    $("#lost-modal").classList.remove("hidden");
    return;
  }
  await api(`/api/opportunities/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify({ stage }),
  });
  showFlash(stage === "won" ? "Won — customer created" : `Moved to ${STAGE_LABEL[stage]}`);
  await loadPipeline();
  if (state.view === "detail" && state.detail?.opportunity?.id === id) await openOpportunity(id);
}

async function openOpportunity(id) {
  const data = await api(`/api/opportunities/${id}`);
  state.detail = data;
  setView("detail");
  const o = data.opportunity;
  $("#detail-name").textContent = o.account_name;
  $("#detail-meta").textContent = `${STAGE_LABEL[o.stage] || o.stage} · ${o.account_type}`;
  $("#detail-notes").textContent = o.notes || "";
  const site = [o.address, o.city].filter(Boolean).join(", ") || "—";
  $("#detail-pills").innerHTML = `
    <span class="pill">Site: <strong>${escapeHtml(site)}</strong></span>
    <span class="pill">Last contact: <strong>${escapeHtml(fmtDate(o.last_contact_at))}</strong></span>
    <span class="pill">Est: <strong>${escapeHtml(fmtMoney(o.estimated_mrr_cents))}</strong></span>
    <span class="pill">Quoted: <strong>${escapeHtml(fmtMoney(o.quoted_mrr_cents))}</strong></span>
    ${o.lost_reason ? `<span class="pill">Lost: <strong>${escapeHtml(o.lost_reason)}</strong></span>` : ""}
    ${data.customer ? `<span class="pill badge">Customer #${data.customer.id}</span>` : ""}`;

  const ff = $("#followup-form");
  ff.next_action.value = o.next_action || "";
  ff.next_follow_up_at.value = (o.next_follow_up_at || "").slice(0, 10);

  $("#followup-chips").innerHTML = [
    ["Today", addDays(0)],
    ["Tomorrow", addDays(1)],
    ["+3 days", addDays(3)],
    ["Next week", addDays(7)],
    ["Clear", ""],
  ]
    .map(
      ([label, date]) =>
        `<button type="button" class="chip" data-fu-date="${date}">${label}</button>`,
    )
    .join("");

  const cbody = $("#contacts-table tbody");
  cbody.innerHTML = "";
  for (const c of data.contacts) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.name)}${c.is_primary ? ' <span class="badge">primary</span>' : ""}</td>
      <td>${escapeHtml(c.email || "—")}</td>
      <td>${escapeHtml(c.phone || "—")}</td>
      <td title="${escapeHtml(c.last_subject || "")}">${escapeHtml(fmtDate(c.last_contact_at))}</td>
      <td>
        <button type="button" data-edit-contact="${c.id}">Edit</button>
        <button type="button" data-del-contact="${c.id}">Delete</button>
      </td>`;
    cbody.appendChild(tr);
  }

  renderTimeline($("#activity-timeline"), data.activities, false);
}

function renderTimeline(el, activities, showOpp) {
  if (!activities.length) {
    el.innerHTML = `<div class="empty">No activities yet.</div>`;
    return;
  }
  el.innerHTML = activities
    .map(
      (a) => `
      <article class="timeline-item">
        <div class="when">${escapeHtml(fmtDate(a.happened_at))} · ${escapeHtml(a.type || "note")}</div>
        <div class="summary"><strong>${escapeHtml(a.summary)}</strong>
          ${showOpp && a.account_name ? ` <span class="muted">· ${escapeHtml(a.account_name)}</span>` : ""}
        </div>
        <div class="muted">${[a.person, a.outcome, a.next_action].filter(Boolean).map(escapeHtml).join(" · ") || ""}</div>
      </article>`,
    )
    .join("");
}

function resetOppForm() {
  const form = $("#opp-form");
  form.reset();
  form.id.value = "";
  form.account_id.value = "";
  fillStageSelect(form.stage, "new_lead");
  $("#opp-form-title").textContent = "New opportunity";
  $("#opp-contact-fields").classList.remove("hidden");
  $("#lost-reason-wrap").classList.add("hidden");
}

function fillOppForm(o) {
  const form = $("#opp-form");
  form.id.value = o.id;
  form.account_id.value = o.account_id;
  form.account_name.value = o.account_name || "";
  form.account_type.value = o.account_type || "residential";
  fillStageSelect(form.stage, o.stage);
  form.lead_source.value = o.lead_source || "";
  form.cleaning_type.value = o.cleaning_type || "";
  form.frequency.value = o.frequency || "";
  form.estimated_mrr_dollars.value =
    o.estimated_mrr_cents != null ? (Number(o.estimated_mrr_cents) / 100).toFixed(2) : "";
  form.quoted_mrr_dollars.value =
    o.quoted_mrr_cents != null ? (Number(o.quoted_mrr_cents) / 100).toFixed(2) : "";
  form.expected_start.value = (o.expected_start || "").slice(0, 10);
  form.next_follow_up_at.value = (o.next_follow_up_at || "").slice(0, 10);
  form.next_action.value = o.next_action || "";
  form.lost_reason.value = o.lost_reason || "";
  form.address.value = o.address || "";
  form.city.value = o.city || "";
  form.property_type.value = o.property_type || "";
  form.sq_ft.value = o.sq_ft ?? "";
  form.notes.value = o.notes || "";
  $("#opp-form-title").textContent = "Edit opportunity";
  $("#opp-contact-fields").classList.add("hidden");
  $("#lost-reason-wrap").classList.toggle("hidden", o.stage !== "lost");
}

/* ---------- contacts / activities / followups / customers ---------- */

async function loadContacts() {
  const q = $("#contact-search").value.trim();
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const { contacts } = await api(`/api/contacts${qs}`);
  const tbody = $("#contacts-list-table tbody");
  const empty = $("#contacts-empty");
  const table = $("#contacts-list-table");
  tbody.innerHTML = "";
  if (!contacts.length) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  for (const c of contacts) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(c.name)}</strong>${c.is_primary ? ' <span class="badge">primary</span>' : ""}</td>
      <td>${escapeHtml(c.account_name)}</td>
      <td>${escapeHtml(c.email || "—")}</td>
      <td>${escapeHtml(c.phone || "—")}</td>
      <td title="${escapeHtml(c.last_subject || "")}">${escapeHtml(fmtDate(c.last_contact_at))}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadActivities() {
  const oppId = $("#activity-opp-filter").value;
  const qs = oppId ? `?opportunity_id=${oppId}` : "";
  const { activities } = await api(`/api/activities${qs}`);
  renderTimeline($("#activities-list"), activities, !oppId);
}

async function refreshActivityOppFilter() {
  const { opportunities } = await api("/api/opportunities");
  const sel = $("#activity-opp-filter");
  const cur = sel.value;
  sel.innerHTML =
    `<option value="">All opportunities</option>` +
    opportunities
      .map(
        (o) =>
          `<option value="${o.id}" ${String(o.id) === cur ? "selected" : ""}>${escapeHtml(o.account_name)} (${STAGE_LABEL[o.stage] || o.stage})</option>`,
      )
      .join("");
}

function bucketFor(dateStr, today) {
  if (!dateStr) return "none";
  const day = dateStr.slice(0, 10);
  const t = ymd(today);
  if (day < t) return "overdue";
  if (day === t) return "today";
  const tomorrow = addDays(1);
  if (day === tomorrow) return "tomorrow";
  const weekEnd = new Date(today);
  weekEnd.setDate(today.getDate() + (7 - today.getDay())); // end of week Sunday-ish; fine for buckets
  // This week = remaining days through +6 from today (ponytail)
  const weekLimit = addDays(6);
  if (day <= weekLimit) return "week";
  return "upcoming";
}

async function loadFollowups() {
  const { opportunities } = await api("/api/follow-ups");
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const buckets = [
    { id: "overdue", label: "Overdue" },
    { id: "today", label: "Today" },
    { id: "tomorrow", label: "Tomorrow" },
    { id: "week", label: "This Week" },
    { id: "upcoming", label: "Upcoming" },
    { id: "none", label: "None" },
  ];
  const grouped = Object.fromEntries(buckets.map((b) => [b.id, []]));
  for (const o of opportunities) {
    grouped[bucketFor(o.next_follow_up_at, today)].push(o);
  }

  $("#followup-buckets").innerHTML = buckets
    .map((b) => {
      const items = grouped[b.id];
      return `<div class="panel">
        <h2>${b.label} <span class="muted">(${items.length})</span></h2>
        ${
          items.length
            ? `<div class="stack">${items
                .map((o) => {
                  const site = [o.address, o.city].filter(Boolean).join(", ");
                  return `<div class="followup-row">
                    <div>
                      <button type="button" class="linkish" data-open-opp="${o.id}"><strong>${escapeHtml(o.account_name)}</strong></button>
                      <div class="muted">${escapeHtml(STAGE_LABEL[o.stage] || o.stage)}${site ? ` · ${escapeHtml(site)}` : ""}</div>
                      <div class="muted">${escapeHtml(o.next_action || "No next action")}${o.next_follow_up_at ? ` · ${escapeHtml(fmtDay(o.next_follow_up_at))}` : ""}</div>
                    </div>
                    <div class="chip-row">
                      <button type="button" class="chip" data-fu-opp="${o.id}" data-fu-date="${addDays(0)}">Today</button>
                      <button type="button" class="chip" data-fu-opp="${o.id}" data-fu-date="${addDays(1)}">Tomorrow</button>
                      <button type="button" class="chip" data-fu-opp="${o.id}" data-fu-date="${addDays(3)}">+3</button>
                      <button type="button" class="chip" data-fu-opp="${o.id}" data-fu-date="${addDays(7)}">+7</button>
                      <button type="button" class="chip" data-fu-opp="${o.id}" data-fu-date="">Clear</button>
                    </div>
                  </div>`;
                })
                .join("")}</div>`
            : `<div class="empty">Nothing here.</div>`
        }
      </div>`;
    })
    .join("");
}

async function setFollowUp(id, date, nextAction) {
  const payload = { next_follow_up_at: date || null };
  if (nextAction !== undefined) payload.next_action = nextAction;
  await api(`/api/opportunities/${id}`, { method: "PUT", body: JSON.stringify(payload) });
}

async function loadCustomers() {
  const q = $("#customer-search").value.trim();
  const qs = q ? `?q=${encodeURIComponent(q)}` : "";
  const { customers } = await api(`/api/customers${qs}`);
  const tbody = $("#customers-table tbody");
  const empty = $("#customers-empty");
  const table = $("#customers-table");
  tbody.innerHTML = "";
  if (!customers.length) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  for (const c of customers) {
    const site = [c.service_address, c.city].filter(Boolean).join(", ") || "—";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(c.name)}</strong></td>
      <td><span class="badge ${c.type}">${escapeHtml(c.type)}</span></td>
      <td>${escapeHtml(site)}</td>
      <td>${escapeHtml(c.frequency || "—")}</td>
      <td>${escapeHtml(fmtMoney(c.mrr_cents))}</td>
      <td>${escapeHtml(fmtDay(c.start_date))}</td>`;
    tbody.appendChild(tr);
  }
}

async function loadGmail() {
  const status = await api("/api/gmail/status");
  $("#gmail-status").textContent = status.connected ? "Connected" : "Not connected";
  $("#gmail-last-sync").textContent = status.last_sync_at ? fmtDate(status.last_sync_at) : "Never";
}

async function loadView(view) {
  setView(view);
  if (view === "dashboard") await loadDashboard();
  if (view === "opportunities") await loadPipeline();
  if (view === "contacts") await loadContacts();
  if (view === "activities") {
    await refreshActivityOppFilter();
    await loadActivities();
  }
  if (view === "followups") await loadFollowups();
  if (view === "customers") await loadCustomers();
  if (view === "settings") await loadGmail();
}

function wire() {
  fillStageSelect($("#opp-stage-select"));
  const stageFilter = $("#opp-filter-stage");
  stageFilter.innerHTML =
    `<option value="">All stages</option>` +
    STAGES.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");

  $$("#nav [data-view]").forEach((btn) => {
    btn.addEventListener("click", () => loadView(btn.dataset.view));
  });

  $("#logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  $("#dash-refresh").addEventListener("click", () => loadDashboard());

  let searchTimer;
  const debouncePipeline = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadPipeline(), 200);
  };
  $("#opp-search").addEventListener("input", debouncePipeline);
  $("#opp-filter-type").addEventListener("change", () => loadPipeline());
  $("#opp-filter-stage").addEventListener("change", () => loadPipeline());
  $("#opp-filter-source").addEventListener("input", debouncePipeline);

  $("#new-opp-btn").addEventListener("click", () => {
    resetOppForm();
    $("#opp-form-panel").classList.remove("hidden");
  });
  $("#cancel-opp-btn").addEventListener("click", () => {
    $("#opp-form-panel").classList.add("hidden");
  });
  $("#opp-form").stage.addEventListener("change", (e) => {
    $("#lost-reason-wrap").classList.toggle("hidden", e.target.value !== "lost");
  });

  $("#opp-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      account_name: form.account_name.value,
      account_type: form.account_type.value,
      stage: form.stage.value,
      lead_source: form.lead_source.value || null,
      cleaning_type: form.cleaning_type.value || null,
      frequency: form.frequency.value || null,
      estimated_mrr_dollars: form.estimated_mrr_dollars.value
        ? Number(form.estimated_mrr_dollars.value)
        : null,
      quoted_mrr_dollars: form.quoted_mrr_dollars.value
        ? Number(form.quoted_mrr_dollars.value)
        : null,
      expected_start: form.expected_start.value || null,
      next_follow_up_at: form.next_follow_up_at.value || null,
      next_action: form.next_action.value || null,
      lost_reason: form.lost_reason.value || null,
      address: form.address.value || null,
      city: form.city.value || null,
      property_type: form.property_type.value || null,
      sq_ft: form.sq_ft.value ? Number(form.sq_ft.value) : null,
      notes: form.notes.value || null,
    };
    try {
      if (form.id.value) {
        await api(`/api/opportunities/${form.id.value}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        showFlash("Opportunity updated");
        $("#opp-form-panel").classList.add("hidden");
        await openOpportunity(Number(form.id.value));
      } else {
        payload.contact_name = form.contact_name.value || null;
        payload.contact_email = form.contact_email.value || null;
        payload.contact_phone = form.contact_phone.value || null;
        const { id } = await api("/api/opportunities", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        showFlash("Opportunity created");
        $("#opp-form-panel").classList.add("hidden");
        await openOpportunity(id);
      }
    } catch (err) {
      showFlash(err.message, true);
    }
  });

  $("#back-opps").addEventListener("click", () => loadView("opportunities"));

  $("#edit-opp-btn").addEventListener("click", () => {
    if (!state.detail) return;
    fillOppForm(state.detail.opportunity);
    setView("opportunities");
    $("#opp-form-panel").classList.remove("hidden");
  });

  $("#delete-opp-btn").addEventListener("click", async () => {
    if (!state.detail) return;
    if (!confirm(`Delete ${state.detail.opportunity.account_name}?`)) return;
    await api(`/api/opportunities/${state.detail.opportunity.id}`, { method: "DELETE" });
    showFlash("Opportunity deleted");
    await loadView("opportunities");
  });

  $("#followup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    await setFollowUp(
      state.detail.opportunity.id,
      form.next_follow_up_at.value || null,
      form.next_action.value || null,
    );
    showFlash("Follow-up saved");
    await openOpportunity(state.detail.opportunity.id);
  });

  $("#followup-chips").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-fu-date]");
    if (!btn || !state.detail) return;
    const date = btn.dataset.fuDate;
    $("#followup-form").next_follow_up_at.value = date;
    await setFollowUp(state.detail.opportunity.id, date || null);
    showFlash(date ? `Follow-up set to ${fmtDay(date)}` : "Follow-up cleared");
    await openOpportunity(state.detail.opportunity.id);
  });

  $("#add-contact-btn").addEventListener("click", () => {
    const form = $("#contact-form");
    form.reset();
    form.id.value = "";
    form.classList.remove("hidden");
  });
  $("#cancel-contact-btn").addEventListener("click", () => {
    $("#contact-form").classList.add("hidden");
  });
  $("#contact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const accountId = state.detail.opportunity.account_id;
    const payload = {
      name: form.name.value,
      email: form.email.value || null,
      phone: form.phone.value || null,
      is_primary: form.is_primary.checked,
    };
    if (form.id.value) {
      await api(`/api/contacts/${form.id.value}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api(`/api/accounts/${accountId}/contacts`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    form.classList.add("hidden");
    await openOpportunity(state.detail.opportunity.id);
  });

  $("#contacts-table").addEventListener("click", async (e) => {
    const editId = e.target.dataset?.editContact;
    const delId = e.target.dataset?.delContact;
    if (editId) {
      const c = state.detail.contacts.find((x) => String(x.id) === editId);
      if (!c) return;
      const form = $("#contact-form");
      form.id.value = c.id;
      form.name.value = c.name || "";
      form.email.value = c.email || "";
      form.phone.value = c.phone || "";
      form.is_primary.checked = Boolean(c.is_primary);
      form.classList.remove("hidden");
    }
    if (delId) {
      if (!confirm("Delete this contact?")) return;
      await api(`/api/contacts/${delId}`, { method: "DELETE" });
      await openOpportunity(state.detail.opportunity.id);
    }
  });

  $("#add-activity-btn").addEventListener("click", () => {
    const form = $("#activity-form");
    form.reset();
    form.classList.remove("hidden");
  });
  $("#cancel-activity-btn").addEventListener("click", () => {
    $("#activity-form").classList.add("hidden");
  });
  $("#activity-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const happened = form.happened_at.value
      ? new Date(form.happened_at.value).toISOString()
      : undefined;
    await api("/api/activities", {
      method: "POST",
      body: JSON.stringify({
        opportunity_id: state.detail.opportunity.id,
        happened_at: happened,
        type: form.type.value || "note",
        person: form.person.value || null,
        summary: form.summary.value,
        outcome: form.outcome.value || null,
        next_action: form.next_action.value || null,
        next_follow_up_at: form.next_follow_up_at.value || null,
      }),
    });
    form.classList.add("hidden");
    showFlash("Activity logged");
    await openOpportunity(state.detail.opportunity.id);
  });

  $("#pipeline-board").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-move]");
    if (!btn) return;
    e.stopPropagation();
    await moveStage(Number(btn.dataset.move), btn.dataset.stage);
  });

  $("#lost-modal-cancel").addEventListener("click", () => {
    state.pendingLost = null;
    $("#lost-modal").classList.add("hidden");
  });
  $("#lost-modal-save").addEventListener("click", async () => {
    const reason = $("#lost-modal-reason").value.trim();
    if (!reason) {
      showFlash("Lost reason required", true);
      return;
    }
    if (!state.pendingLost) return;
    const { id, after } = state.pendingLost;
    await api(`/api/opportunities/${id}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ stage: "lost", lost_reason: reason }),
    });
    state.pendingLost = null;
    $("#lost-modal").classList.add("hidden");
    showFlash("Marked Lost");
    await after();
  });

  $("#contact-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadContacts(), 200);
  });
  $("#activity-opp-filter").addEventListener("change", () => loadActivities());
  $("#customer-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadCustomers(), 200);
  });

  $("#followup-buckets").addEventListener("click", async (e) => {
    const open = e.target.closest("[data-open-opp]");
    if (open) {
      await openOpportunity(Number(open.dataset.openOpp));
      return;
    }
    const chip = e.target.closest("[data-fu-opp]");
    if (!chip) return;
    await setFollowUp(Number(chip.dataset.fuOpp), chip.dataset.fuDate || null);
    showFlash("Follow-up updated");
    await loadFollowups();
  });

  $("#password-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      await api("/api/settings/password", {
        method: "PUT",
        body: JSON.stringify({
          current_password: form.current_password.value,
          password: form.password.value,
        }),
      });
      form.reset();
      showFlash("Password updated");
    } catch (err) {
      showFlash(err.message, true);
    }
  });

  $("#gmail-sync-btn").addEventListener("click", async () => {
    try {
      const r = await api("/api/gmail/sync", { method: "POST" });
      showFlash(`Synced ${r.synced} emails (${r.skipped} with no match)`);
      await loadGmail();
    } catch (err) {
      showFlash(err.message, true);
    }
  });
  $("#gmail-disconnect-btn").addEventListener("click", async () => {
    if (!confirm("Disconnect Gmail?")) return;
    await api("/api/gmail/disconnect", { method: "POST" });
    showFlash("Gmail disconnected");
    await loadGmail();
  });
}

async function boot() {
  wire();
  // Default activity date filter = this month
  const now = new Date();
  $("#dash-from").value = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
  $("#dash-to").value = ymd(now);

  const params = new URLSearchParams(location.search);
  if (params.get("gmail") === "connected") {
    showFlash("Gmail connected");
    history.replaceState({}, "", "/");
    await loadView("settings");
    return;
  }
  try {
    await api("/api/me");
    await loadView("dashboard");
  } catch {
    /* redirect handled */
  }
}

boot();
