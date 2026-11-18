// The installed Ryugi hook only exports its reminder functions. Keep the private
// selection formatters aligned with hooks/selection-context.cjs (Ryugi 1.81).
const fs = require("node:fs");
const path = require("node:path");
const { plugin, checkouts } = require("./upstream.cjs");
const { load } = require("./store.cjs");
const { transport } = require("./watch.cjs");
const { autoPublishContext, commentReminders } = require(
  path.join(plugin, "hooks/selection-context.cjs"),
);
const MAX_CONTEXT = 8000;
const MAX_HTML = 600;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function selectionFiles(state) {
  const files = [];
  let types;
  try {
    types = fs.readdirSync(state);
  } catch {
    return files;
  }
  for (const type of types) {
    let ids;
    try {
      ids = fs.readdirSync(path.join(state, type));
    } catch {
      continue;
    }
    for (const id of ids) {
      const file = path.join(state, type, id, "selection.json");
      const value = readJson(file);
      if (
        value &&
        Array.isArray(value.selected) &&
        Array.isArray(value.tweaks) &&
        Array.isArray(value.nodes)
      )
        files.push({ file, value });
    }
  }
  return files;
}

const where = (node) => `${node.id} <${node.tag}> in ${node.file} at \`${node.path}\``;
const change = (item) => `${item.property}: ${item.from} → ${item.value}`;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

function typedNodes(nodes, prompt) {
  const boards = [...new Set(nodes.map((node) => node.board))];
  const typed = new Set();
  for (const board of boards) {
    for (const match of prompt.matchAll(
      new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(board)}#(\\d+)(?!\\d)`, "g"),
    ))
      typed.add(`${board}#${match[1]}`);
  }
  return nodes.filter((node) => typed.has(node.id));
}

function describe(session, { file, value }, prompt, budget) {
  const named = typedNodes(value.nodes, prompt);
  if (!value.selected.length && !value.tweaks.length && !named.length) return "";
  const head = [`Artboard ${value.artifact}, open in the viewer (updated ${value.updatedAt}):`];
  if (named.length) {
    head.push("Nodes named in this message:");
    for (const node of named) head.push(`- ${where(node)}${node.name ? ` "${node.name}"` : ""}`);
  }
  const tail = `Full selection and node map: ${path.relative(session, file)}`;
  const body = [];
  if (value.selected.length) {
    const html = Math.max(80, Math.min(MAX_HTML, Math.floor(budget / 2 / value.selected.length)));
    body.push("Selected nodes:");
    for (const node of value.selected) {
      body.push(`- ${where(node)}${node.text ? ` "${clip(node.text, 120)}"` : ""}`);
      if (node.html) body.push(`  html: ${clip(node.html, html)}`);
      if (node.tweaks.length) body.push(`  preview tweaks: ${node.tweaks.map(change).join("; ")}`);
    }
    if (value.more) body.push(`(${value.more} more selected, listed in the file below)`);
  }
  if (value.tweaks.length) {
    body.push("Preview tweaks on other nodes (not in the source yet):");
    for (const tweak of value.tweaks) body.push(`- ${where(tweak)}: ${change(tweak)}`);
  }
  const fixed = head.join("\n").length + tail.length + 2;
  const room = Math.max(0, budget - fixed);
  const middle = body.join("\n");
  const kept =
    middle.length > room
      ? `${middle.slice(0, Math.max(0, room - 40))}\n(more in the file below)`
      : middle;
  return [head.join("\n"), kept, tail].filter(Boolean).join("\n");
}

function documentIds(root) {
  try {
    return fs.readdirSync(path.join(root, "document")).sort();
  } catch {
    return [];
  }
}

function artifactIds(root, type) {
  try {
    return fs.readdirSync(path.join(root, type)).sort();
  } catch {
    return [];
  }
}

function documentSelections(session, root, budget) {
  const sections = [];
  let left = budget;
  for (const id of documentIds(root)) {
    const file = path.join(root, ".state", "document", id, "selection.json");
    const value = readJson(file);
    if (!value || typeof value.quote !== "string" || !value.quote || !Array.isArray(value.blockIds))
      continue;
    const blocks = value.blockIds.length
      ? `${value.heading ? "," : " in"} blocks ${value.blockIds.join(", ")}`
      : "";
    const where = `${value.heading ? ` under "${value.heading}"` : ""}${blocks}`;
    const head = `Document document/${id}, open in the viewer (updated ${value.updatedAt}):\nSelected${where}:`;
    const tail = `Full selection: ${path.relative(session, file)}`;
    const room = left - head.length - tail.length - 4;
    if (room < 40) break;
    const quote = clip(value.quote, room)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    const section = [head, quote, tail].join("\n");
    sections.push(section);
    left -= section.length + 2;
  }
  return sections;
}

const element = (item) =>
  `- ${item.id} ${item.type}${item.text ? ` "${clip(item.text, 120)}"` : ""}${item.frameId ? ` in frame ${item.frameId}` : ""}${item.author ? ` · ${item.author}` : ""}`;

function whiteboardSelections(session, root, budget) {
  const sections = [];
  let left = budget;
  for (const id of artifactIds(path.join(root, ".state"), "whiteboard")) {
    const file = path.join(root, ".state", "whiteboard", id, "selection.json");
    const value = readJson(file);
    if (!value || !Array.isArray(value.selected) || !value.selected.length) continue;
    const head = `Whiteboard whiteboard/${id}, open in the viewer (updated ${value.updatedAt}):\nSelected elements:`;
    const tail = `Full selection: ${path.relative(session, file)}`;
    const room = left - head.length - tail.length - 4;
    if (room < 40) break;
    const section = [head, clip(value.selected.map(element).join("\n"), room), tail].join("\n");
    sections.push(section);
    left -= section.length + 2;
  }
  return sections;
}

function selectionContext(project, session, host, prompt = "", owner) {
  const root = path.join(project, ".ryugi/artifacts");
  const state = path.join(root, ".state");
  if (!fs.existsSync(path.join(state, "server-info"))) return "";
  const db = load();
  const { base } = transport();
  const related = new Set(checkouts(project));
  const byProject = new Map();
  for (const sub of db.subscriptions) {
    if (sub.project === project || sub.deadline <= Date.now() || sub.base !== base) continue;
    if (owner ? sub.thread !== owner : !related.has(sub.project)) continue;
    if (!byProject.has(sub.project)) byProject.set(sub.project, new Set());
    byProject.get(sub.project).add(sub.artifact);
  }
  const elsewhere = [...byProject].map(([other, artifacts]) =>
    commentReminders(other, path.join(other, ".ryugi/artifacts"), host, artifacts),
  );
  // Unread counts are per host review key; without one every comment would look unread.
  const reminders = [
    ...(host ? [commentReminders(project, root, host), ...elsewhere] : []),
    autoPublishContext(project, process.env, ""),
  ]
    .filter(Boolean)
    .join("\n\n");
  const files = selectionFiles(state).sort((a, b) =>
    String(b.value.updatedAt).localeCompare(String(a.value.updatedAt)),
  );
  const sections = [];
  // Reminders are capped at MAX_REMINDERS and reserved first so a large artboard selection cannot crowd them out.
  let left = MAX_CONTEXT - (reminders ? reminders.length + 2 : 0);
  for (const entry of files) {
    if (left <= 0) break;
    const section = describe(session, entry, prompt, left);
    if (!section) continue;
    sections.push(section);
    left -= section.length + 2;
  }
  const documents = documentSelections(session, root, left);
  sections.push(...documents);
  for (const section of documents) left -= section.length + 2;
  sections.push(...whiteboardSelections(session, root, left));
  if (reminders) sections.push(reminders);
  return sections.join("\n\n");
}
module.exports = { selectionContext };
