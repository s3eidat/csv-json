/* CSV ⇄ JSON — RFC 4180 parser/writer written here; JSON via JSON.parse. Everything stays local. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var PREVIEW_ROWS = 200;

  // ---------- CSV ----------
  // RFC 4180 + real-world leniency: CR, LF or CRLF line ends, "" escapes, quotes only special at field start.
  function parseCSV(text, delim) {
    var rows = [], row = [], field = "", i = 0, n = text.length, quoted = false, line = 1, quoteLine = 0;
    if (text.charCodeAt(0) === 0xFEFF) i = 1; // strip BOM
    while (i < n) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        if (c === "\n") line++;
        field += c; i++; continue;
      }
      if (c === '"' && field === "") { quoted = true; quoteLine = line; i++; continue; }
      if (c === delim) { row.push(field); field = ""; i++; continue; }
      if (c === "\r" || c === "\n") {
        row.push(field); rows.push(row); row = []; field = "";
        if (c === "\r" && text[i + 1] === "\n") i++;
        i++; line++; continue;
      }
      field += c; i++;
    }
    if (quoted) throw new Error("Unclosed quote that starts on line " + quoteLine);
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function detectDelimiter(text) {
    var sample = text.slice(0, 20000), best = ",", bestScore = -1;
    [",", ";", "\t", "|"].forEach(function (d) {
      var rows;
      try { rows = parseCSV(sample, d).slice(0, 30); } catch (e) { rows = parseCSV(sample + '"', d).slice(0, 30); }
      if (rows.length > 1 && sample.length >= 20000) rows.pop(); // last sampled row may be cut
      var counts = {}, top = 0, width = 0;
      rows.forEach(function (r) { if (r.length > 1) { counts[r.length] = (counts[r.length] || 0) + 1; } });
      Object.keys(counts).forEach(function (k) { if (counts[k] > top || (counts[k] === top && +k > width)) { top = counts[k]; width = +k; } });
      var score = top * 1000 + width; // most rows with the same field count, then the widest
      if (score > bestScore) { bestScore = score; best = d; }
    });
    return best;
  }
  var NUM = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
  function typed(v) {
    if (v === "") return null;
    if (NUM.test(v) && v.length < 16) return Number(v); // long digit strings (IDs, cards) stay strings
    if (v === "true" || v === "TRUE") return true;
    if (v === "false" || v === "FALSE") return false;
    if (v === "null") return null;
    return v;
  }
  function headers(row) {
    var seen = {};
    return row.map(function (h, i) {
      var k = h.trim() || "column_" + (i + 1), base = k, n = 2;
      while (seen[k]) k = base + "_" + n++;
      seen[k] = true; return k;
    });
  }
  function csvToJson(text, o) {
    var delim = o.delim === "auto" ? detectDelimiter(text) : o.delim;
    var rows = parseCSV(text, delim), conv = o.types ? typed : function (v) { return v; };
    var head = o.header && rows.length ? headers(rows.shift()) : null;
    var width = Math.max(head ? head.length : 0, rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0));
    var cols = head || Array.from({ length: width }, function (_, i) { return "column_" + (i + 1); });
    for (var c = cols.length; c < width; c++) cols.push("column_" + (c + 1));
    var data = o.shape === "arrays"
      ? (head ? [head] : []).concat(rows.map(function (r) { return r.map(conv); }))
      : rows.map(function (r) { var obj = {}; cols.forEach(function (k, i) { if (i < r.length || head) obj[k] = i < r.length ? conv(r[i]) : null; }); return obj; });
    return { data: data, rows: rows, cols: cols, delim: delim, ragged: rows.some(function (r) { return r.length !== cols.length; }) };
  }

  // ---------- JSON → CSV ----------
  function flatten(v, prefix, out) {
    if (v && typeof v === "object") {
      var keys = Object.keys(v);
      if (!keys.length) { if (prefix) out[prefix] = Array.isArray(v) ? "[]" : "{}"; return out; }
      keys.forEach(function (k) { flatten(v[k], prefix ? prefix + "." + k : k, out); });
      return out;
    }
    out[prefix || "value"] = v;
    return out;
  }
  function cell(v, delim, safe) {
    var s = v == null ? "" : typeof v === "string" ? v : String(v);
    if (safe && /^[=+\-@\t\r]/.test(s) && !NUM.test(s)) s = "'" + s; // stop Excel/Sheets running it as a formula
    return /["\r\n]|^\s|\s$/.test(s) || s.indexOf(delim) >= 0 ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function jsonToCsv(data, o) {
    var delim = o.delim === "auto" ? "," : o.delim, list = Array.isArray(data) ? data : [data], lines = [], cols = [], table;
    if (list.length && list.every(Array.isArray)) {
      table = list.map(function (r) { return r.map(function (x) { return x && typeof x === "object" ? JSON.stringify(x) : x; }); });
      cols = null;
    } else {
      var seen = {}, flat = list.map(function (item) { return flatten(item, "", {}); });
      flat.forEach(function (f) { Object.keys(f).forEach(function (k) { if (!seen[k]) { seen[k] = 1; cols.push(k); } }); });
      table = flat.map(function (f) { return cols.map(function (k) { return f[k]; }); });
    }
    if (cols && o.header) lines.push(cols.map(function (c) { return cell(c, delim, o.safe); }).join(delim));
    table.forEach(function (r) { lines.push(r.map(function (x) { return cell(x, delim, o.safe); }).join(delim)); });
    return { csv: lines.join("\r\n") + (lines.length ? "\r\n" : ""), cols: cols, table: table };
  }

  // ---------- UI ----------
  var input = $("#input"), output = $("#output");
  var saved = S3.store("cj.opts") || {};
  var st = { dir: saved.dir || "c2j", shape: saved.shape || "objects", out: "", ok: false };
  if (saved.delim) $("#delim").value = saved.delim;
  if (saved.header === false) $("#header").checked = false;
  if (saved.types === false) $("#types").checked = false;
  if (saved.safe === false) $("#safe").checked = false;
  $("#bom").checked = !!saved.bom;
  function opts() {
    var o = { dir: st.dir, shape: st.shape, delim: $("#delim").value, header: $("#header").checked, types: $("#types").checked, safe: $("#safe").checked, bom: $("#bom").checked };
    S3.store("cj.opts", o); return o;
  }
  function seg(el, value, onPick) {
    $$("button", el).forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.v === value));
      b.addEventListener("click", function () { $$("button", el).forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); onPick(b.dataset.v); });
    });
  }
  function setStatus(cls, text, info) { var s = $("#status"); s.className = "chip " + cls; s.textContent = text; $("#info").textContent = info || ""; }
  var DNAME = { ",": "comma", ";": "semicolon", "\t": "tab", "|": "pipe" };

  function preview(cols, rows) {
    var box = $("#preview"); box.textContent = "";
    if (!rows || !rows.length) { box.appendChild(S3.h("div", { "class": "empty" }, [S3.h("b", { text: "No rows yet" }), "A table of your data appears here."])); $("#pvInfo").textContent = ""; return; }
    var width = Math.max(cols ? cols.length : 0, rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0));
    var thead = S3.h("thead", null, [S3.h("tr", null, [S3.h("th", { "class": "cj-n", text: "#" })].concat(Array.from({ length: width }, function (_, i) { return S3.h("th", { text: cols && cols[i] != null ? cols[i] : String(i + 1) }); })))]);
    var tbody = S3.h("tbody");
    rows.slice(0, PREVIEW_ROWS).forEach(function (r, ri) {
      tbody.appendChild(S3.h("tr", null, [S3.h("td", { "class": "cj-n", text: String(ri + 1) })].concat(Array.from({ length: width }, function (_, i) {
        var v = r[i];
        return S3.h("td", { dir: "auto", "class": v == null ? "cj-null" : "", text: v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v) });
      }))));
    });
    box.appendChild(S3.h("table", { "class": "tbl" }, [thead, tbody]));
    $("#pvInfo").textContent = rows.length > PREVIEW_ROWS ? "first " + PREVIEW_ROWS + " of " + rows.length.toLocaleString() + " rows" : rows.length.toLocaleString() + " row" + (rows.length === 1 ? "" : "s") + " · " + width + " column" + (width === 1 ? "" : "s");
  }

  function convert(user) {
    var o = opts(), text = input.value;
    st.ok = false; output.value = "";
    if (!text.trim()) { setStatus("", "Waiting for input"); preview(null, null); return; }
    try {
      if (st.dir === "c2j") {
        var r = csvToJson(text, o);
        st.out = JSON.stringify(r.data, null, 2);
        setStatus(r.ragged ? "warn" : "ok", r.ragged ? "Converted · some rows have a different number of fields" : "✓ Converted",
          r.rows.length.toLocaleString() + " rows · delimiter: " + DNAME[r.delim] + (o.delim === "auto" ? " (detected)" : ""));
        preview(r.cols, r.rows);
      } else {
        var data;
        try { data = JSON.parse(text); } catch (e) { throw new Error("Invalid JSON: " + e.message); }
        if (data === null || typeof data !== "object") throw new Error("Expected a JSON array or object");
        var c = jsonToCsv(data, o);
        st.out = c.csv;
        setStatus("ok", "✓ Converted", c.table.length.toLocaleString() + " rows" + (c.cols ? " · " + c.cols.length + " columns" : ""));
        preview(c.cols, c.table);
      }
      output.value = st.out.length > 2e6 ? st.out.slice(0, 2e6) + "\n… (truncated in this box — Copy and Download include everything)" : st.out;
      st.ok = true;
      if (user) S3.done();
    } catch (e) { setStatus("bad", e.message); preview(null, null); }
  }
  var convertSoon = S3.debounce(function () { convert(false); }, 250);

  function setDir(d) {
    st.dir = d;
    $$("#dir button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === d)); });
    $$(".c2j-only").forEach(function (e) { e.hidden = d !== "c2j"; });
    $$(".j2c-only").forEach(function (e) { e.hidden = d !== "j2c"; });
    $("#inLabel").textContent = d === "c2j" ? "CSV input" : "JSON input";
    $("#outLabel").textContent = d === "c2j" ? "JSON output" : "CSV output";
    $("#saveExt").textContent = d === "c2j" ? ".json" : ".csv";
    $("#header").parentNode.lastChild.textContent = d === "c2j" ? " First row is a header" : " Include a header row";
    input.placeholder = d === "c2j" ? "Paste CSV here, or drop a file" : 'Paste JSON here, e.g. [{"name":"Ada","age":36}]';
    convert(false);
  }
  $$("#dir button").forEach(function (b) {
    b.addEventListener("click", function () {
      if (b.dataset.v === st.dir) return;
      if (st.ok) input.value = st.out; // carry the result over so you can round-trip
      setDir(b.dataset.v);
    });
  });
  seg($("#shape"), st.shape, function (v) { st.shape = v; convert(true); });
  ["#delim", "#header", "#types", "#safe", "#bom"].forEach(function (s) { $(s).addEventListener("change", function () { convert(true); }); });
  input.addEventListener("input", convertSoon);

  function loadText(t, name) {
    if (/\.json$/i.test(name || "") && st.dir !== "j2c") setDir("j2c");
    else if (/\.(csv|tsv)$/i.test(name || "") && st.dir !== "c2j") setDir("c2j");
    input.value = t; convert(true);
  }
  $("#open input").addEventListener("change", function (e) {
    var f = e.target.files[0]; if (!f) return;
    S3.readFile(f, "text").then(function (t) { loadText(t, f.name); }); e.target.value = "";
  });
  input.addEventListener("dragover", function (e) { e.preventDefault(); });
  input.addEventListener("drop", function (e) {
    var f = e.dataTransfer.files[0]; if (!f) return;
    e.preventDefault(); S3.readFile(f, "text").then(function (t) { loadText(t, f.name); });
  });
  $("#clear").addEventListener("click", function () { input.value = ""; convert(false); input.focus(); });
  $("#copy").addEventListener("click", function () { if (st.ok) { S3.copy(st.out); S3.done(); } else S3.toast("Nothing to copy yet", "error"); });
  $("#save").addEventListener("click", function () {
    if (!st.ok) { S3.toast("Nothing to save yet", "error"); return; }
    if (st.dir === "c2j") S3.download(st.out, "data.json", "application/json");
    else S3.download(($("#bom").checked ? "﻿" : "") + st.out, "data.csv", "text/csv;charset=utf-8");
    S3.done();
  });

  var SAMPLE_CSV = 'name,city,age,member,notes\nAda Lovelace,London,36,true,"Wrote the first program, 1843"\nOmar,Amman,29,false,"Likes ""clean"" data"\nGrace Hopper,New York,85,true,"Line one\nline two"\nخالد,عمّان,41,true,\n';
  var SAMPLE_JSON = JSON.stringify([
    { id: 1, name: "Ada", address: { city: "London", zip: "N1" }, tags: ["math", "code"] },
    { id: 2, name: "Omar", address: { city: "Amman" }, tags: ["data"], active: true }
  ], null, 2);
  $("#sample").addEventListener("click", function () { input.value = st.dir === "c2j" ? SAMPLE_CSV : SAMPLE_JSON; convert(true); });

  setDir(st.dir);

  window.S3_DEMO = function () { setDir("c2j"); input.value = SAMPLE_CSV; convert(false); };

  window.S3_SELFTEST = function () {
    var rows = parseCSV('a,b\r\n1,"x, y"\n2,"multi\nline ""q"""\n', ",");
    if (JSON.stringify(rows) !== '[["a","b"],["1","x, y"],["2","multi\\nline \\"q\\""]]') return "rfc4180 " + JSON.stringify(rows);
    if (parseCSV("a,b\n", ",").length !== 1 || JSON.stringify(parseCSV("a,,\n,b", ",")) !== '[["a","",""],["","b"]]') return "empties";
    try { parseCSV('a,"b\nc', ","); return "unclosed accepted"; } catch (e) { if (!/line 1/.test(e.message)) return "unclosed line"; }
    if (detectDelimiter("a;b;c\n1;2,5;3\n4;5;6") !== ";" || detectDelimiter("a\tb\n1\t2") !== "\t" || detectDelimiter('x|y\n"1|2"|3') !== "|") return "detect";
    var j = csvToJson("id,zip,ok,n\n1,007,true,\n2,10,false,3.5", { delim: "auto", header: true, types: true, shape: "objects" });
    if (JSON.stringify(j.data) !== '[{"id":1,"zip":"007","ok":true,"n":null},{"id":2,"zip":10,"ok":false,"n":3.5}]') return "types " + JSON.stringify(j.data);
    if (JSON.stringify(headers(["a", "a", ""])) !== '["a","a_2","column_3"]') return "headers";
    var c = jsonToCsv([{ a: { b: 1 }, t: [1, 2], s: 'say "hi", ok' }, { a: { b: 2 }, x: null }], { delim: ",", header: true, safe: true });
    if (c.csv !== 'a.b,t.0,t.1,s,x\r\n1,1,2,"say ""hi"", ok",\r\n2,,,,\r\n') return "j2c " + JSON.stringify(c.csv);
    if (jsonToCsv([{ f: "=SUM(A1)", n: -5 }], { delim: ",", header: false, safe: true }).csv !== "'=SUM(A1),-5\r\n") return "formula guard";
    // round trip
    var src = [{ name: "Ada", note: "a,b\n\"c\"" }, { name: "عمر", note: "" }];
    var back = csvToJson(jsonToCsv(src, { delim: ";", header: true, safe: false }).csv, { delim: "auto", header: true, types: false, shape: "objects" }).data;
    if (JSON.stringify(back) !== JSON.stringify(src)) return "round trip " + JSON.stringify(back);
    return true;
  };
})();
