// A small directed graph the policy and group calculators build while they explain a result, drawn as Mermaid flowchart text.
// The same facts are written out as plain text by each calculator, so the diagram and the text never disagree about what exists.
//
//   const g = new Graph();
//   g.node('u1', { label: 'alice', kind: 'user' });
//   g.edge('u1', 'g4', { label: 'direct member' });
//   g.toMermaid();   // "flowchart LR ..."

// Mermaid reads these as entities inside a quoted label. Anything else is safe between quotes.
const escapeLabel = (text) => String(text)
  .replace(/&/g, '#amp;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');

// A box's label: line breaks in the text become line breaks in the box (the one tag we emit ourselves, after everything else is escaped).
const boxLabel = (text) => String(text).split(/\r?\n/).map(escapeLabel).join('<br/>');

// Node shapes by what a node stands for. Anything else is a rounded box.
const SHAPES = {
  user: ['([', '])'], app: ['[[', ']]'], rule: ['{{', '}}'], outcome: ['[/', '/]'], role: ['(', ')'],
};

// The class a node is styled with. The console colors these (see CalculatorDiagram.jsx).
const CLASSES = ['user', 'role', 'basis', 'reference', 'application', 'policy', 'global', 'app', 'ok', 'warn', 'bad', 'muted', 'rule', 'target'];

class Graph {
  constructor({ direction = 'LR', limit = 400 } = {}) {
    this.direction = direction;
    this.limit = limit;
    this.nodes = new Map();
    this.edges = [];
    this.links = {};
    this.truncated = false;
  }

  /** Adds a node, or merges into the one with this id. `details` is the hover text; `link` is a console path to open on click. */
  node(id, { label, kind = 'plain', cls = null, details = '', link = null } = {}) {
    const old = this.nodes.get(id);
    if (old) {
      if (cls) old.cls = cls;
      if (details) old.details = details;
      return id;
    }
    if (this.nodes.size >= this.limit) { this.truncated = true; return id; }
    this.nodes.set(id, { id, label: label ?? id, kind, cls, details });
    if (link) this.links[id] = link;
    return id;
  }

  /** Adds an edge from `from` to `to`. `style` is 'solid' (default), 'dotted' or 'thick'. The same edge is added once. */
  edge(from, to, { label = '', style = 'solid', tone = null } = {}) {
    if (!this.nodes.has(from) || !this.nodes.has(to)) return;
    if (this.edges.some((e) => e.from === from && e.to === to && e.label === label)) return;
    this.edges.push({ from, to, label, style, tone });
  }

  toJSON() {
    return {
      nodes: [...this.nodes.values()].map((n) => ({ id: n.id, label: n.label, kind: n.kind, cls: n.cls, details: n.details })),
      edges: this.edges.map((e) => ({ from: e.from, to: e.to, label: e.label, style: e.style, tone: e.tone })),
      links: this.links,
      truncated: this.truncated,
    };
  }

  /** Draws the graph as Mermaid text. `direction` is 'LR' (left to right) or 'TD' (top down, the vertical layout). */
  toMermaid(direction = this.direction) {
    const lines = [`flowchart ${direction}`];
    for (const n of this.nodes.values()) {
      const [open, close] = SHAPES[n.kind] || ['(', ')'];
      lines.push(`  ${n.id}${open}"${boxLabel(n.label)}"${close}`);
    }
    const bad = [];
    this.edges.forEach((e, i) => {
      const arrow = e.style === 'dotted' ? '-.->' : e.style === 'thick' ? '==>' : '-->';
      const label = e.label ? (e.style === 'dotted' ? `-. "${escapeLabel(e.label)}" .->` : e.style === 'thick' ? `== "${escapeLabel(e.label)}" ==>` : `-->|"${escapeLabel(e.label)}"|`) : arrow;
      lines.push(`  ${e.from} ${label} ${e.to}`);
      if (e.tone === 'bad') bad.push(i);
    });
    for (const n of this.nodes.values()) if (n.cls && CLASSES.includes(n.cls)) lines.push(`  class ${n.id} ${n.cls}`);
    if (bad.length) lines.push(`  linkStyle ${bad.join(',')} stroke:#d32f2f,stroke-width:2px`);
    return lines.join('\n');
  }
}

/** A title with bullet lines beneath it, for a box that says what it requires or yielded. */
const detail = (title, lines = []) => [title, ...lines.map((l) => `• ${l}`)].join('\n');

module.exports = { Graph, escapeLabel, detail, CLASSES };
