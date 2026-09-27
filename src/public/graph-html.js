import fs from "node:fs/promises";
import path from "node:path";
import { readPublicIndexV1 } from "./v1.js";
import { locateNodeInPublicIndex } from "./locate.js";

const KIND_PRIORITY = new Map([
  ["entry", 0],
  ["route", 1],
  ["symbol", 2],
  ["data_object", 3],
  ["document", 4],
  ["reference", 5],
  ["unknown", 6]
]);

function boundedInteger(value, fallback, min, max, label) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new Error(label + " must be an integer between " + min + " and " + max);
  }
  return resolved;
}

function degreeMap(edges) {
  const degree = new Map();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  return degree;
}

function sortedEdges(edges) {
  return [...edges].sort((a, b) =>
    String(a.type).localeCompare(String(b.type))
      || String(a.from).localeCompare(String(b.from))
      || String(a.to).localeCompare(String(b.to))
      || String(a.id).localeCompare(String(b.id))
  );
}

function selectedNodeIds(publicIndex, focusNodeId, maxNodes, maxHops) {
  const nodeIds = new Set(publicIndex.nodes.map((node) => node.id));
  if (focusNodeId) {
    if (!nodeIds.has(focusNodeId)) {
      throw new Error("focus node not found in Public Index v1: " + focusNodeId);
    }
    const adjacency = new Map();
    for (const edge of sortedEdges(publicIndex.edges)) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
      adjacency.get(edge.from).push({ edge, next: edge.to });
      adjacency.get(edge.to).push({ edge, next: edge.from });
    }

    const selected = new Set([focusNodeId]);
    const queue = [{ id: focusNodeId, hop: 0 }];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor];
      if (current.hop >= maxHops) continue;
      const incident = [...(adjacency.get(current.id) ?? [])].sort((a, b) =>
        String(a.edge.id).localeCompare(String(b.edge.id))
          || String(a.next).localeCompare(String(b.next))
      );
      for (const item of incident) {
        if (selected.size >= maxNodes) break;
        if (selected.has(item.next)) continue;
        selected.add(item.next);
        queue.push({ id: item.next, hop: current.hop + 1 });
      }
      if (selected.size >= maxNodes) break;
    }
    return selected;
  }

  const degree = degreeMap(publicIndex.edges);
  const ordered = [...publicIndex.nodes].sort((a, b) =>
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)
      || (KIND_PRIORITY.get(a.kind) ?? 99) - (KIND_PRIORITY.get(b.kind) ?? 99)
      || String(a.id).localeCompare(String(b.id))
  );
  return new Set(ordered.slice(0, maxNodes).map((node) => node.id));
}

function labelForNode(node) {
  if (node.kind === "symbol") return node.qualified_name ?? node.name ?? node.id;
  if (node.kind === "entry") return (node.entry_kind ?? "entry") + ": " + (node.entry_name ?? node.id);
  if (node.kind === "route") return (node.method ?? "ANY") + " " + (node.route_path ?? node.id);
  if (node.kind === "data_object") return (node.object_type ?? "data") + ": " + (node.object_name ?? node.id);
  if (node.kind === "document") return node.path ?? node.id;
  if (node.kind === "reference") return node.id.replace(/^ref:/, "");
  return node.id;
}

function layoutNodes(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = node.kind ?? "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const kindOrder = [...groups.keys()].sort((a, b) =>
    (KIND_PRIORITY.get(a) ?? 99) - (KIND_PRIORITY.get(b) ?? 99)
      || a.localeCompare(b)
  );
  const positioned = [];
  for (let column = 0; column < kindOrder.length; column++) {
    const kind = kindOrder[column];
    const items = groups.get(kind).sort((a, b) => a.id.localeCompare(b.id));
    for (let row = 0; row < items.length; row++) {
      positioned.push({
        ...items[row],
        x: 120 + column * 240,
        y: 80 + row * 84
      });
    }
  }
  return positioned.sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildGraphViewModel({
  repoRoot,
  indexDir,
  focusNodeId = null,
  maxNodes = 250,
  maxHops = 3
}) {
  if (!repoRoot || !indexDir) throw new Error("repoRoot and indexDir are required");
  const nodeLimit = boundedInteger(maxNodes, 250, 1, 1000, "maxNodes");
  const hopLimit = boundedInteger(maxHops, 3, 1, 6, "maxHops");
  const publicIndex = await readPublicIndexV1(indexDir);
  const selected = selectedNodeIds(publicIndex, focusNodeId, nodeLimit, hopLimit);
  const maxEdges = Math.min(8000, nodeLimit * 12);

  const rawNodes = publicIndex.nodes
    .filter((node) => selected.has(node.id))
    .map((node) => {
      const located = locateNodeInPublicIndex(publicIndex, {
        repoRoot,
        nodeId: node.id,
        editor: "vscode"
      });
      return {
        ...node,
        label: labelForNode(node),
        locations: located.locations
      };
    });

  const edges = sortedEdges(publicIndex.edges)
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .slice(0, maxEdges);

  const nodes = layoutNodes(rawNodes);
  const edgeTypes = [...new Set(edges.map((edge) => edge.type))].sort();
  const width = Math.max(900, ...nodes.map((node) => node.x + 180));
  const height = Math.max(600, ...nodes.map((node) => node.y + 100));

  return {
    format: "cce-graph-view",
    version: "0.1.0",
    public_index: {
      format: publicIndex.manifest.format,
      version: publicIndex.manifest.version,
      indexed_at: publicIndex.manifest.indexed_at ?? null
    },
    focus_node_id: focusNodeId,
    limits: {
      max_nodes: nodeLimit,
      max_hops: hopLimit,
      max_edges: maxEdges
    },
    stats: {
      source_nodes: publicIndex.nodes.length,
      source_edges: publicIndex.edges.length,
      selected_nodes: nodes.length,
      selected_edges: edges.length,
      truncated_nodes: publicIndex.nodes.length > nodes.length,
      truncated_edges: publicIndex.edges.length > edges.length
    },
    canvas: { width, height },
    edge_types: edgeTypes,
    nodes,
    edges
  };
}

function escapeEmbeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function viewerHtml(model) {
  const data = escapeEmbeddedJson(model);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'">
<title>CCE Graph Viewer</title>
<style>
:root{font-family:system,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1f2937;background:#f8fafc}
*{box-sizing:border-box}body{margin:0;min-height:100vh}.shell{display:grid;grid-template-columns:minmax(0,1fr) 340px;height:100vh}
.main{display:flex;flex-direction:column;min-width:0}.toolbar{padding:12px 14px;background:#fff;border-bottom:1px solid #dbe3ed;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.toolbar input{min-width:260px;max-width:520px;flex:1;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px}.filters{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}
.filters label{display:flex;gap:4px;align-items:center}.meta{font-size:12px;color:#64748b}.viewport{flex:1;overflow:auto;background:#f1f5f9}
svg{display:block}.edge{stroke:#94a3b8;stroke-width:1.4;opacity:.65}.edge.unresolved{stroke-dasharray:6 4;opacity:.45}.edge.hidden{display:none}
.node rect{fill:#fff;stroke:#94a3b8;stroke-width:1.2;rx:8}.node.entry rect{stroke:#7c3aed}.node.route rect{stroke:#2563eb}.node.symbol rect{stroke:#059669}.node.data_object rect{stroke:#b45309}.node.reference rect{stroke-dasharray:5 4}.node text{font-size:11px;pointer-events:none}.node .kind{font-size:9px;fill:#64748b}.node.match rect{stroke-width:3}.node.hidden{display:none}.sidebar{border-left:1px solid #dbe3ed;background:#fff;padding:16px;overflow:auto}.sidebar h2{font-size:16px;margin:0 0 10px}.sidebar pre{white-space:pre-wrap;word-break:break-word;font-size:11px;background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #e2e8f0}.locations a{display:block;margin:6px 0;font-size:12px;word-break:break-all}.empty{color:#64748b;font-size:13px}
@media(max-width:900px){ .shell{grid-template-columns:1fr}.sidebar{position:fixed;right:0;top:0;bottom:0;width:min(88vw,340px);box-shadow:-4px 0 20px #0002}.toolbar input{min-width:180px} }
</style>
</head>
<body>
<div class="shell">
  <section class="main">
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search node id, name, path...">
      <div id="filters" class="filters"></div>
      <div id="meta" class="meta"></div>
    </div>
    <div class="viewport"><svg id="graph" aria-label="CCE code graph"></svg></div>
  </section>
  <aside class="sidebar">
    <h2>Node details</h2>
    <div id="details" class="empty">Select a node.</div>
  </aside>
</div>
<script id="cce-data" type="application/json">${data}</script>
<script>
(function(){
  "use strict";
  const model=JSON.parse(document.getElementById("cce-data").textContent);
  const svg=document.getElementById("graph");
  const details=document.getElementById("details");
  const search=document.getElementById("search");
  const filters=document.getElementById("filters");
  const meta=document.getElementById("meta");
  const NS="http://www.w3.org/2000/svg";
  const nodeById=new Map(model.nodes.map(n=>[n.id,n]));
  const enabled=new Set(model.edge_types);
  svg.setAttribute("width",model.canvas.width);
  svg.setAttribute("height",model.canvas.height);
  svg.setAttribute("viewBox","0 0 "+model.canvas.width+" "+model.canvas.height);
  meta.textContent=model.stats.selected_nodes+" nodes · "+model.stats.selected_edges+" edges";

  function el(name,attrs){
    const n=document.createElementNS(NS,name);
    for(const [k,v] of Object.entries(attrs||{}))n.setAttribute(k,String(v));
    return n;
  }
  function short(value,n){value=String(value||"");return value.length>n?value.slice(0,n-1)+"…":value}
  function updateVisibility(){
    const q=search.value.trim().toLowerCase();
    document.querySelectorAll(".edge").forEach(line=>{
      line.classList.toggle("hidden",!enabled.has(line.dataset.type));
    });
    document.querySelectorAll(".node").forEach(g=>{
      const hit=!q ||String(g.dataset.search).includes(q);
      g.classList.toggle("match",Boolean(q&&hit));
      g.classList.toggle("hidden",Boolean(q&&!hit));
    });
  }
  for(const type of model.edge_types){
    const label=document.createElement("label");
    const cb=document.createElement("input");cb.type="checkbox";cb.checked=true;
    cb.addEventListener("change",()=>{cb.checked?enabled.add(type):enabled.delete(type);updateVisibility()});
    label.append(cb,document.createTextNode(type));filters.append(label);
  }

  const edgeLayer=el("g",{"aria-label":"edges"});svg.append(edgeLayer);
  for(const edge of model.edges){
    const a=nodeById.get(edge.from),b=nodeById.get(edge.to);if(!a||!b)continue;
    const line=el("line",{x1:a.x+84,y1:a.y,x2:b.x-84,y2:b.y});
    line.classList.add("edge");if(edge.confidence==="unresolved")line.classList.add("unresolved");
    line.dataset.type=edge.type;line.dataset.id=edge.id;
    const title=el("title");title.textContent=edge.type+" · "+edge.confidence+"\n"+edge.from+" → "+edge.to;
    line.append(title);edgeLayer.append(line);
  }

  const nodeLayer=el("g",{"aria-label":"nodes"});svg.append(nodeLayer);
  function showNode(node){
    details.textContent="";
    const title=document.createElement("strong");title.textContent=node.label;details.append(title);
    const loc=document.createElement("div");loc.className="locations";
    for(const item of node.locations||[]){
      const a=document.createElement("a");a.href=item.open_uri;a.textContent=item.document+":"+item.line;a.title=item.absolute_path;loc.append(a);
    }
    if(loc.childNodes.length)details.append(loc);
    const pre=document.createElement("pre");pre.textContent=JSON.stringify(node,null,2);details.append(pre);
    const incident=model.edges.filter(e=>e.from===node.id||e.to===node.id);
    if(incident.length){
      const h=document.createElement("h2");h.textContent="Incident edges";details.append(h);
      const ep=document.createElement("pre");ep.textContent=JSON.stringify(incident,null,2);details.append(ep);
    }
  }
  for(const node of model.nodes){
    const g=el("g",{transform:"translate("+node.x+" "+node.y+")",tabindex:"0"});
    g.classList.add("node",node.kind||"unknown");g.dataset.search=(node.id+" "+node.label+" "+(node.document||node.path||"")).toLowerCase();
    const rect=el("rect",{x:-84,y:-28,width:168,height:56});
    const kind=el("text",{x:-74,y:-10,class:"kind"});kind.textContent=node.kind||"unknown";
    const label=el("text",{x:-74,y:8});label.textContent=short(node.label,26);
    const id=el("text",{x:-74,y:21,class:"kind"});id.textContent=short(node.id,28);
    g.append(rect,kind,label,id);g.addEventListener("click",()=>showNode(node));
    g.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();showNode(node)}});
    const title=el("title");title.textContent=node.id;g.append(title);nodeLayer.append(g);
  }
  search.addEventListener("input",updateVisibility);
  if(model.focus_node_id&&nodeById.has(model.focus_node_id))showNode(nodeById.get(model.focus_node_id));
})();
</script>
</body>
</html>
`;
}

export async function exportGraphHtml({
  repoRoot,
  indexDir,
  outFile,
  focusNodeId = null,
  maxNodes = 250,
  maxHops = 3
}) {
  if (!outFile) throw new Error("outFile is required");
  const model = await buildGraphViewModel({
    repoRoot,
    indexDir,
    focusNodeId,
    maxNodes,
    maxHops
  });
  const output = path.resolve(outFile);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, viewerHtml(model), "utf8");
  return {
    ok: true,
    path: output,
    focus_node_id: focusNodeId,
    nodes: model.nodes.length,
    edges: model.edges.length,
    edge_types: model.edge_types,
    truncated_nodes: model.stats.truncated_nodes,
    truncated_edges: model.stats.truncated_edges
  };
}
