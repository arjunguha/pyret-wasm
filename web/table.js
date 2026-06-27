// Pyret table rendering (minimal JS glue: turn a printed table value into an HTML
// <table> in the Interactions pane). A Pyret table renders to text in the
// header/rows form
//
//     table: name, age
//       row: "Bob", 12
//       row: "Alice", 17
//     end
//
// which this module parses into a grid. NOTE: the TS *seed* does not yet support
// `table-expr` (compiling one errors with "unsupported expression: table-expr"),
// so tables don't reach here automatically YET — wiring is in place so they render
// the moment the seed/runtime emits a table value. Until then this path is
// exercised directly (see scripts/ide-test.ts). To make it automatic, the seed
// needs table-expr support + a table tostring in this exact shape.
//
// Exposes window.PyretTable = { isTableString, toTable }.
(function () {
  "use strict";

  // A table value spans multiple lines: `table:` header, `row:` lines, then `end`.
  function isTableString(s) {
    return /^\s*table:\s*.*\n[\s\S]*\bend\s*$/.test(s) && /\brow:/.test(s);
  }

  // split on top-level commas/semicolons, respecting nested ()[]{} and quotes
  function splitCells(inner) {
    var out = [], depth = 0, start = 0, q = null;
    for (var i = 0; i < inner.length; i++) {
      var c = inner[i];
      if (q) { if (c === q && inner[i - 1] !== "\\") q = null; continue; }
      if (c === '"' || c === "'") { q = c; }
      else if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if ((c === "," || c === ";") && depth === 0) { out.push(inner.slice(start, i)); start = i + 1; }
    }
    if (inner.slice(start).trim().length) out.push(inner.slice(start));
    return out.map(function (s) { return unquote(s.trim()); });
  }

  function unquote(s) {
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
      return s.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    return s;
  }

  // Parse the header/rows text into { cols: [...], rows: [[...], ...] } or null.
  function parse(s) {
    var lines = s.split("\n").map(function (l) { return l.trim(); }).filter(function (l) { return l.length; });
    if (!lines.length) return null;
    var head = lines[0].match(/^table:\s*(.*)$/);
    if (!head) return null;
    var cols = head[1].length ? splitCells(head[1]) : [];
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var m = lines[i].match(/^row:\s*(.*)$/);
      if (m) rows.push(splitCells(m[1]));
      else if (/^end$/.test(lines[i])) break;
    }
    return { cols: cols, rows: rows };
  }

  // Build an HTMLTableElement (class "pyret-table") from a table string, or null.
  function toTable(s) {
    var t = parse(s);
    if (!t) return null;
    var table = document.createElement("table");
    table.className = "pyret-table";
    if (t.cols.length) {
      var thead = document.createElement("thead");
      var htr = document.createElement("tr");
      t.cols.forEach(function (c) {
        var th = document.createElement("th");
        th.textContent = c;
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      table.appendChild(thead);
    }
    var tbody = document.createElement("tbody");
    t.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell) {
        var td = document.createElement("td");
        td.textContent = cell;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  window.PyretTable = { isTableString: isTableString, toTable: toTable };
})();
