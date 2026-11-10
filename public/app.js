const STAGES = [
  { id: "lead", label: "Lead" },
  { id: "quoted", label: "Quoted" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

const state = {
  view: "accounts",
  accounts: [],
  detail: null,
  deals: [],
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

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtMoney(cents) {
  if (cents == null || cents === "") return "—";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(
    Number(cents) / 100,
  );
}

function setView(view) {
  state.view = view;
  $$("#nav [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#view-accounts").classList.toggle("hidden", view !== "accounts");
  $("#view-detail").classList.toggle("hidden", view !== "detail");
  $("#view-pipeline").classList.toggle("hidden", view !== "pipeline");
  $("#view-gmail").classList.toggle("hidden", view !== "gmail");
}

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  state.accounts = accounts;
  const tbody = $("#accounts-table tbody");
  const empty = $("#accounts-empty");
  const table = $("#accounts-table");
  tbody.innerHTML = "";
  if (!accounts.length) {
    empty.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  table.classList.remove("hidden");
  for (const a of accounts) {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td><strong>${escapeHtml(a.name)}</strong></td>
      <td><span class="badge ${a.type}">${a.type}</span></td>
      <td>${escapeHtml(a.city || "—")}</td>
      <td>${escapeHtml(fmtDate(a.last_contact_at))}</td>`;
    tr.addEventListener("click", () => openAccount(a.id));
    tbody.appendChild(tr);
  }
}

async function openAccount(id) {
  const data = await api(`/api/accounts/${id}`);
  state.detail = data;
  setView("detail");
  const a = data.account;
  $("#detail-name").textContent = a.name;
  $("#detail-meta").textContent = [
    a.type,
    a.property_type,
    a.address,
    a.city,
    a.sq_ft ? `${a.sq_ft} sq ft` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  $("#detail-notes").textContent = a.notes || "";
  $("#detail-last-contact").textContent = fmtDate(a.last_contact_at);

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

  const dbody = $("#deals-table tbody");
  dbody.innerHTML = "";
  for (const d of data.deals) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(d.stage)}</td>
      <td>${escapeHtml(d.cleaning_type || "—")}</td>
      <td>${escapeHtml(d.frequency || "—")}</td>
      <td>${escapeHtml(fmtMoney(d.value_cents))}</td>
      <td><button type="button" data-del-deal="${d.id}">Delete</button></td>`;
    dbody.appendChild(tr);
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resetAccountForm() {
  const form = $("#account-form");
  form.reset();
  form.id.value = "";
  $("#account-form-title").textContent = "New account";
}

function fillAccountForm(a) {
  const form = $("#account-form");
  form.id.value = a.id;
  form.name.value = a.name || "";
  form.type.value = a.type || "residential";
  form.property_type.value = a.property_type || "";
  form.address.value = a.address || "";
  form.city.value = a.city || "";
  form.sq_ft.value = a.sq_ft ?? "";
  form.notes.value = a.notes || "";
  $("#account-form-title").textContent = "Edit account";
}

async function loadPipeline() {
  const { deals } = await api("/api/deals");
  state.deals = deals;
  const board = $("#pipeline-board");
  board.innerHTML = "";
  for (const stage of STAGES) {
    const col = document.createElement("div");
    col.className = "column";
    col.dataset.stage = stage.id;
    const items = deals.filter((d) => d.stage === stage.id);
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
      const id = e.dataTransfer.getData("text/deal-id");
      if (!id) return;
      await api(`/api/deals/${id}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ stage: stage.id }),
      });
      await loadPipeline();
    });

    for (const d of items) {
      const card = document.createElement("div");
      card.className = "deal";
      card.draggable = true;
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/deal-id", String(d.id));
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      const other = STAGES.filter((s) => s.id !== d.stage);
      card.innerHTML = `
        <strong>${escapeHtml(d.account_name)}</strong>
        <div class="meta">${escapeHtml(d.cleaning_type || "Cleaning")} · ${escapeHtml(fmtMoney(d.value_cents))}</div>
        <div class="actions">
          ${other.map((s) => `<button type="button" data-move="${d.id}" data-stage="${s.id}">→ ${s.label}</button>`).join("")}
        </div>`;
      col.appendChild(card);
    }
    board.appendChild(col);
  }
}

async function loadGmail() {
  const status = await api("/api/gmail/status");
  $("#gmail-status").textContent = status.connected ? "Connected" : "Not connected";
  $("#gmail-last-sync").textContent = status.last_sync_at ? fmtDate(status.last_sync_at) : "Never";
}

function wire() {
  $$("#nav [data-view]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const view = btn.dataset.view;
      setView(view);
      if (view === "accounts") await loadAccounts();
      if (view === "pipeline") await loadPipeline();
      if (view === "gmail") await loadGmail();
    });
  });

  $("#logout-btn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    location.href = "/login";
  });

  $("#new-account-btn").addEventListener("click", () => {
    resetAccountForm();
    $("#account-form-panel").classList.remove("hidden");
  });
  $("#cancel-account-btn").addEventListener("click", () => {
    $("#account-form-panel").classList.add("hidden");
  });

  $("#account-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value,
      type: form.type.value,
      property_type: form.property_type.value || null,
      address: form.address.value || null,
      city: form.city.value || null,
      sq_ft: form.sq_ft.value ? Number(form.sq_ft.value) : null,
      notes: form.notes.value || null,
    };
    const id = form.id.value;
    if (id) {
      await api(`/api/accounts/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      showFlash("Account updated");
      $("#account-form-panel").classList.add("hidden");
      if (state.view === "detail") await openAccount(Number(id));
      else await loadAccounts();
    } else {
      const { id: newId } = await api("/api/accounts", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showFlash("Account created");
      $("#account-form-panel").classList.add("hidden");
      await openAccount(newId);
    }
  });

  $("#back-accounts").addEventListener("click", async () => {
    setView("accounts");
    await loadAccounts();
  });

  $("#edit-account-btn").addEventListener("click", () => {
    if (!state.detail) return;
    fillAccountForm(state.detail.account);
    setView("accounts");
    $("#account-form-panel").classList.remove("hidden");
  });

  $("#delete-account-btn").addEventListener("click", async () => {
    if (!state.detail) return;
    if (!confirm(`Delete ${state.detail.account.name}?`)) return;
    await api(`/api/accounts/${state.detail.account.id}`, { method: "DELETE" });
    showFlash("Account deleted");
    setView("accounts");
    await loadAccounts();
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
    const accountId = state.detail.account.id;
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
    await openAccount(accountId);
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
      await openAccount(state.detail.account.id);
    }
  });

  $("#add-deal-btn").addEventListener("click", () => {
    $("#deal-form").reset();
    $("#deal-form").classList.remove("hidden");
  });
  $("#cancel-deal-btn").addEventListener("click", () => {
    $("#deal-form").classList.add("hidden");
  });

  $("#deal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const dollars = form.value_dollars.value ? Number(form.value_dollars.value) : null;
    await api("/api/deals", {
      method: "POST",
      body: JSON.stringify({
        account_id: state.detail.account.id,
        stage: form.stage.value,
        cleaning_type: form.cleaning_type.value || null,
        frequency: form.frequency.value || null,
        value_cents: dollars == null ? null : Math.round(dollars * 100),
        preferred_at: form.preferred_at.value || null,
        notes: form.notes.value || null,
      }),
    });
    form.classList.add("hidden");
    await openAccount(state.detail.account.id);
  });

  $("#deals-table").addEventListener("click", async (e) => {
    const id = e.target.dataset?.delDeal;
    if (!id) return;
    if (!confirm("Delete this deal?")) return;
    await api(`/api/deals/${id}`, { method: "DELETE" });
    await openAccount(state.detail.account.id);
  });

  $("#pipeline-board").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-move]");
    if (!btn) return;
    await api(`/api/deals/${btn.dataset.move}/stage`, {
      method: "PATCH",
      body: JSON.stringify({ stage: btn.dataset.stage }),
    });
    await loadPipeline();
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
  const params = new URLSearchParams(location.search);
  if (params.get("gmail") === "connected") {
    showFlash("Gmail connected");
    history.replaceState({}, "", "/");
    setView("gmail");
    await loadGmail();
    return;
  }
  try {
    await api("/api/me");
    await loadAccounts();
  } catch {
    /* redirect handled */
  }
}

boot();
