const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const labels = { overview: "概览", requests: "请求记录", effects: "收益计量", settings: "设置与隐私" };
const eventLabels = {
  request_started: "请求开始", request_completed: "请求结束",
  index_status_checked: "检查索引", index_started: "开始索引",
  index_completed: "索引完成", query_expanded: "展开查询",
  candidates_retrieved: "检索候选", graph_expanded: "扩展图谱",
  context_selected: "选择上下文", query_completed: "查询完成",
  query_failed: "查询失败"
};
const state = {
  view: "overview", status: null, metrics: null, requests: [],
  nextCursor: null, loading: false
};

function put(selector, value) { $(selector).textContent = value ?? "—"; }
function formatTime(value) {
  if (!value) return "不可用";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "不可用"
    : new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit",
      minute: "2-digit", second: "2-digit"
    }).format(date);
}
function duration(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.round(value * 10) / 10} ms` : "—";
}
function operation(value) {
  return ({ query: "上下文查询", index: "构建索引", status: "索引状态" })[value] ?? "未知操作";
}
function statusText(value) {
  return ({ success: "成功", failure: "失败", running: "进行中" })[value] ?? "未知";
}
function clientText(value) {
  return value === "mcp" ? "MCP · 应用未识别" : value === "cli" ? "CLI" : "不可用";
}
function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = String(content);
  return element;
}
function clear(element) { element.replaceChildren(); }
function errorPanel(message) {
  const box = node("div", "error-box", message);
  box.setAttribute("role", "alert");
  return box;
}
async function json(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
function connection(online) {
  $("#connection-badge").classList.toggle("offline", !online);
  put("#connection-label", online ? "本地 API 已连接" : "本地 API 不可达");
  $("#runtime-dot").classList.toggle("offline", !online);
  put("#runtime-state", online ? "Online" : "Offline");
  put("#runtime-chip", online ? "运行中" : "离线");
}
function renderStatus(data) {
  state.status = data;
  connection(true);
  put("#runtime-version", data.runtime?.package_version);
  put("#runtime-head", data.runtime?.runtime_git_head?.slice(0, 12) ?? "不可用");
  put("#client-identity", data.client_identity === "unavailable" ? "不可用" : data.client_identity);
  put("#index-state", data.index_freshness === "unavailable" ? "尚未检查" : data.index_freshness);
  put("#active-repo", data.active_repository ?? "未提供");
  put("#index-freshness", data.index_freshness === "unavailable" ? "不可用" : data.index_freshness);
  put("#last-indexed", "不可用");
  put("#setting-address", data.listen ? `${data.listen.host}:${data.listen.port}` : "不可用");
  put("#setting-version", data.runtime?.package_version);
  put("#setting-capture", data.telemetry?.capture === "inactive" ? "未启用" : "不可用");
  put("#setting-days", data.telemetry?.retention_days != null ? `${data.telemetry.retention_days} 天` : "不可用");
  put("#setting-max", data.telemetry?.max_requests != null ? `${data.telemetry.max_requests} 条` : "不可用");
  $("#capture-notice").hidden = data.telemetry?.capture !== "inactive";
  put("#updated-at", `更新于 ${formatTime(new Date())}`);
}
function renderMetrics(data) {
  state.metrics = data;
  put("#metric-requests", data.requests);
  put("#metric-queries", data.queries);
  put("#metric-duration", duration(data.average_query_duration_ms));
  put("#metric-failures", data.failures);
}
function resetOnError() {
  state.status = null;
  state.metrics = null;
  connection(false);
  for (const target of [
    "#runtime-version", "#runtime-head", "#client-identity",
    "#index-state", "#active-repo", "#index-freshness",
    "#last-indexed", "#setting-address", "#setting-version",
    "#setting-capture", "#setting-days", "#setting-max",
    "#metric-requests", "#metric-queries", "#metric-duration",
    "#metric-failures"
  ]) put(target, "不可用");
  put("#updated-at", "连接失败");
  $("#capture-notice").hidden = true;
}
async function refreshCommon() {
  try { renderStatus(await json("/status")); }
  catch { resetOnError(); return; }
  try { renderMetrics(await json("/metrics")); }
  catch {
    for (const target of ["#metric-requests", "#metric-queries", "#metric-duration", "#metric-failures"]) {
      put(target, "不可用");
    }
  }
}
function badge(value) {
  const tag = node("span", `state-tag ${["success", "failure", "running"].includes(value) ? value : "running"}`, statusText(value));
  return tag;
}
function createRow(request) {
  const row = node("tr");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `查看 ${formatTime(request.timestamp)} ${operation(request.operation)} 的详情`);
  const cell = (content) => {
    const td = node("td");
    if (typeof content === "string") td.textContent = content;
    else td.append(content);
    row.append(td);
  };
  cell(formatTime(request.timestamp));
  cell(operation(request.operation));
  cell(badge(request.status));
  cell(duration(request.duration_ms));
  cell(clientText(request.client_transport));
  cell("→");
  row.addEventListener("click", () => openDrawer(request.request_id));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDrawer(request.request_id);
    }
  });
  return row;
}
function renderRequests() {
  const body = $("#request-rows");
  body.replaceChildren(...state.requests.map(createRow));
  $("#requests-empty").hidden = state.requests.length > 0;
  $(".table-scroll").hidden = state.requests.length === 0;
  put("#request-total", `${state.requests.length} 条已加载`);
  put("#requests-footnote", state.requests.length
    ? `已加载 ${state.requests.length} 条 · 仅显示真实存储记录` : "尚未采集到请求");
  $("#load-more").hidden = !state.nextCursor;
  renderRecent();
}
function renderRecent() {
  const target = $("#recent-content");
  clear(target);
  if (!state.requests.length) {
    const empty = node("div", "empty compact");
    empty.append(
      node("span", "empty-illustration", "◎"),
      node("strong", "", "等待请求记录"),
      node("p", "", "采集接入后，真实请求会出现在这里。")
    );
    target.append(empty);
    return;
  }
  const wrapper = node("div", "table-scroll");
  const table = node("table");
  const head = node("thead");
  const heading = node("tr");
  for (const label of ["时间", "操作", "状态", "耗时", "来源", ""]) heading.append(node("th", "", label));
  head.append(heading);
  const body = node("tbody");
  body.append(...state.requests.slice(0, 5).map(createRow));
  table.append(head, body);
  wrapper.append(table);
  target.append(wrapper);
}
async function loadRequests(append = false) {
  if (state.loading) return;
  state.loading = true;
  const button = $("#load-more");
  button.disabled = true;
  try {
    const url = new URL("/requests", location.origin);
    url.searchParams.set("limit", "25");
    if (append && state.nextCursor) url.searchParams.set("cursor", state.nextCursor);
    const page = await json(url);
    $$(".table-panel > .error-box, #recent-content > .error-box").forEach((box) => box.remove());
    state.requests = append ? [...state.requests, ...page.requests] : page.requests;
    state.nextCursor = page.next_cursor;
    renderRequests();
  } catch {
    if (!append) { state.requests = []; state.nextCursor = null; renderRequests(); }
    const target = state.view === "overview" ? $("#recent-content") : $(".table-panel");
    target.prepend(errorPanel("请求记录读取失败。请确认本地服务仍在运行，然后重试。"));
  } finally {
    state.loading = false;
    button.disabled = false;
  }
}
function drawerRow(label, value) {
  const row = node("div", "drawer-row");
  row.append(node("span", "", label), node("strong", "", value ?? "不可用"));
  return row;
}
function drawerSection(title, children) {
  const section = node("section", "drawer-section");
  section.append(node("h3", "", title), ...children);
  return section;
}
async function openDrawer(requestId) {
  const drawer = $("#request-drawer");
  const body = $("#drawer-body");
  drawer.hidden = false;
  $("#drawer-backdrop").hidden = false;
  document.body.classList.add("drawer-open");
  clear(body);
  body.append(node("p", "panel-note", "正在读取请求详情…"));
  $("#drawer-close").focus();
  try {
    const { request } = await json(`/requests/${encodeURIComponent(requestId)}`);
    if (drawer.hidden) return;
    const events = request.events ?? [];
    const expansion = events.find((event) => event.event_type === "query_expanded")?.payload;
    const selected = events.find((event) => event.event_type === "context_selected")?.payload;
    const output = events.find((event) => event.event_type === "query_completed")?.payload;
    const timeline = node("ol", "event-list");
    for (const event of events) {
      const item = node("li", "", eventLabels[event.event_type] ?? event.event_type);
      const time = node("time", "", formatTime(event.timestamp));
      item.append(time);
      timeline.append(item);
    }
    clear(body);
    body.append(
      drawerSection("基本信息", [
        drawerRow("时间", formatTime(request.timestamp)),
        drawerRow("操作", operation(request.operation)),
        drawerRow("状态", statusText(request.status)),
        drawerRow("耗时", duration(request.duration_ms)),
        drawerRow("传输方式", clientText(request.client_transport)),
        drawerRow("请求 ID", request.request_id)
      ]),
      drawerSection("查询与选择", [
        node("div", "drawer-explain", "原始查询文本与返回文件路径在当前隐私契约中未保存，无法在此展示。"),
        drawerRow("意图", expansion?.detected_intents?.length ? expansion.detected_intents.join(" · ") : "不可用"),
        drawerRow("must_read", selected?.must_read_count != null ? `${selected.must_read_count} 个文件` : "不可用"),
        drawerRow("maybe_read", selected?.maybe_read_count != null ? `${selected.maybe_read_count} 个文件` : "不可用"),
        drawerRow("tests", selected?.test_count != null ? `${selected.test_count} 个文件` : "不可用"),
        drawerRow("Full 输出", output?.full_bytes != null ? `${output.full_bytes} bytes` : "不可用"),
        drawerRow("Compact 输出", output?.compact_bytes != null ? `${output.compact_bytes} bytes` : "不可用")
      ]),
      drawerSection("事件顺序", [timeline])
    );
  } catch {
    clear(body);
    body.append(errorPanel("无法读取这条请求。它可能已被保留策略清理。"));
  }
}
function closeDrawer() {
  $("#request-drawer").hidden = true;
  $("#drawer-backdrop").hidden = true;
  document.body.classList.remove("drawer-open");
}
function switchView(view) {
  if (!(view in labels)) view = "overview";
  state.view = view;
  $$(".view").forEach((section) => {
    section.hidden = section.dataset.view !== view;
  });
  $$("[data-nav]").forEach((item) => {
    const active = item.dataset.nav === view;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  put("#breadcrumb-page", labels[view]);
  document.title = `${labels[view]} · CCE 本地观测台`;
  closeDrawer();
  window.scrollTo({ top: 0, behavior: "auto" });
  if (view === "requests" && !state.requests.length) loadRequests();
  if (view === "effects") refreshEffects();
}
async function refreshEffects() {
  try {
    const effects = await json("/effects");
    put("#effects-note", effects.status === "unavailable"
      ? "计量尚未实现。这里不会把输出字节压缩率写成真实模型 Token 节省。"
      : "请查看已记录的测量来源与方法。");
  } catch {
    put("#effects-note", "收益接口暂时无法读取。当前不显示任何估算数字。");
  }
}
async function refreshView() {
  await refreshCommon();
  if (state.view === "overview" || state.view === "requests") await loadRequests();
  if (state.view === "effects") await refreshEffects();
}
$$("[data-nav]").forEach((button) =>
  button.addEventListener("click", () => { location.hash = button.dataset.nav; }));
$$("[data-goto]").forEach((button) =>
  button.addEventListener("click", () => { location.hash = button.dataset.goto; }));
$("#refresh-button").addEventListener("click", refreshView);
$("#request-refresh").addEventListener("click", () => loadRequests());
$("#load-more").addEventListener("click", () => loadRequests(true));
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-backdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#request-drawer").hidden) closeDrawer();
});
window.addEventListener("hashchange", () => switchView(location.hash.slice(1)));
switchView(location.hash.slice(1));
refreshView();
setInterval(refreshCommon, 20000);
