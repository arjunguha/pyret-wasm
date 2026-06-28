// Pyret image rendering (minimal JS glue — the canvas is exactly what WASM can't
// do). Image VALUES are a lazy scene graph built in Pyret (data Image in the
// prelude); when an image value is the result of Run/REPL, the runtime renders it
// to text as `op(arg, arg, ...)` (e.g. `overlay(circle(40, solid, blue), ...)`).
// This module parses that text back into a tree and draws it to a <canvas>.
//
// Exposes window.PyretImage = { isImageString, parse, renderToCanvas }.
(function () {
  "use strict";

  var IMAGE_OPS = {
    circle: 1, square: 1, rectangle: 1, ellipse: 1, triangle: 1, text: 1,
    line: 1, star: 1, overlay: 1, "overlay-xy": 1, beside: 1, above: 1,
    "place-image": 1, "empty-scene": 1, scale: 1, rotate: 1, frame: 1,
    "image-url": 1,
  };

  // split a top-level argument list on commas, respecting nested parens
  function splitArgs(inner) {
    var out = [], depth = 0, start = 0;
    for (var i = 0; i < inner.length; i++) {
      var c = inner[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) { out.push(inner.slice(start, i)); start = i + 1; }
    }
    if (inner.slice(start).trim().length) out.push(inner.slice(start));
    return out.map(function (s) { return s.trim(); });
  }

  function parseArg(s) {
    s = s.trim();
    var node = parse(s);
    if (node) return node;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^-?\d+\/\d+$/.test(s)) { var p = s.split("/"); return Number(p[0]) / Number(p[1]); }
    if (/^-?\d*\.\d+$/.test(s)) return Number(s);
    return s; // bare string: color / mode / text content
  }

  // parse `op(arg, ...)` into {op, args:[...]}, or null if not an image expr
  function parse(s) {
    s = s.trim();
    var m = s.match(/^([a-z][a-z0-9-]*)\(([\s\S]*)\)$/i);
    if (!m || !IMAGE_OPS[m[1]]) return null;
    return { op: m[1], args: splitArgs(m[2]).map(parseArg) };
  }

  function isImageString(s) { return parse(s) !== null; }

  var SQRT3_2 = Math.sqrt(3) / 2;

  function measure(n) {
    if (typeof n !== "object" || n === null) return { w: 0, h: 0 };
    var a = n.args, A, B;
    switch (n.op) {
      case "circle": case "star": return { w: 2 * a[0], h: 2 * a[0] };
      case "square": return { w: a[0], h: a[0] };
      case "rectangle": case "ellipse": return { w: a[0], h: a[1] };
      case "triangle": return { w: a[0], h: a[0] * SQRT3_2 };
      case "text": return { w: Math.max(1, ("" + a[0]).length) * (a[1] * 0.6), h: a[1] };
      case "line": return { w: Math.abs(a[0]) || 1, h: Math.abs(a[1]) || 1 };
      case "overlay": A = measure(a[0]); B = measure(a[1]); return { w: Math.max(A.w, B.w), h: Math.max(A.h, B.h) };
      case "overlay-xy": A = measure(a[0]); B = measure(a[3]); return { w: Math.max(B.w, a[1] + A.w), h: Math.max(B.h, a[2] + A.h) };
      case "beside": A = measure(a[0]); B = measure(a[1]); return { w: A.w + B.w, h: Math.max(A.h, B.h) };
      case "above": A = measure(a[0]); B = measure(a[1]); return { w: Math.max(A.w, B.w), h: A.h + B.h };
      case "place-image": return measure(a[3]);
      case "empty-scene": return { w: a[0], h: a[1] };
      case "scale": A = measure(a[1]); return { w: A.w * a[0], h: A.h * a[0] };
      case "rotate": {
        A = measure(a[1]); var r = a[0] * Math.PI / 180;
        return { w: Math.abs(A.w * Math.cos(r)) + Math.abs(A.h * Math.sin(r)),
                 h: Math.abs(A.w * Math.sin(r)) + Math.abs(A.h * Math.cos(r)) };
      }
      case "frame": return measure(a[0]);
      case "image-url": {
        var im0 = imgCache[a[0]];
        if (im0 && im0.complete && im0.naturalWidth) return { w: im0.naturalWidth, h: im0.naturalHeight };
        return { w: 100, h: 100 }; // placeholder until the image loads
      }
    }
    return { w: 0, h: 0 };
  }

  function outlined(mode) { return mode === "outline" || mode === "outlined"; }
  function fillOrStroke(ctx, mode) { if (outlined(mode)) ctx.stroke(); else ctx.fill(); }
  function setStyle(ctx, mode, color) { if (outlined(mode)) ctx.strokeStyle = color; else ctx.fillStyle = color; }

  function drawStar(ctx, cx, cy, spikes, outer, inner) {
    var rot = -Math.PI / 2, step = Math.PI / spikes;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    for (var i = 0; i < spikes; i++) {
      rot += step; ctx.lineTo(cx + Math.cos(rot) * inner, cy + Math.sin(rot) * inner);
      rot += step; ctx.lineTo(cx + Math.cos(rot) * outer, cy + Math.sin(rot) * outer);
    }
    ctx.closePath();
  }

  var imgCache = {};

  function draw(ctx, n, x, y) {
    if (typeof n !== "object" || n === null) return;
    var a = n.args, m = measure(n), A, B;
    switch (n.op) {
      case "circle":
        ctx.beginPath(); ctx.arc(x + a[0], y + a[0], a[0], 0, 2 * Math.PI);
        setStyle(ctx, a[1], a[2]); fillOrStroke(ctx, a[1]); break;
      case "square":
        setStyle(ctx, a[1], a[2]);
        if (outlined(a[1])) ctx.strokeRect(x + 0.5, y + 0.5, a[0] - 1, a[0] - 1); else ctx.fillRect(x, y, a[0], a[0]);
        break;
      case "rectangle":
        setStyle(ctx, a[2], a[3]);
        if (outlined(a[2])) ctx.strokeRect(x + 0.5, y + 0.5, a[0] - 1, a[1] - 1); else ctx.fillRect(x, y, a[0], a[1]);
        break;
      case "ellipse":
        ctx.beginPath(); ctx.ellipse(x + a[0] / 2, y + a[1] / 2, a[0] / 2, a[1] / 2, 0, 0, 2 * Math.PI);
        setStyle(ctx, a[2], a[3]); fillOrStroke(ctx, a[2]); break;
      case "triangle":
        ctx.beginPath(); ctx.moveTo(x + a[0] / 2, y); ctx.lineTo(x + a[0], y + m.h); ctx.lineTo(x, y + m.h); ctx.closePath();
        setStyle(ctx, a[1], a[2]); fillOrStroke(ctx, a[1]); break;
      case "text":
        ctx.fillStyle = a[2] || "black"; ctx.textBaseline = "top"; ctx.font = a[1] + "px sans-serif";
        ctx.fillText("" + a[0], x, y); break;
      case "line":
        ctx.strokeStyle = a[2] || "black"; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + a[0], y + a[1]); ctx.stroke(); break;
      case "star":
        drawStar(ctx, x + a[0], y + a[0], 5, a[0], a[0] / 2); setStyle(ctx, a[1], a[2]); fillOrStroke(ctx, a[1]); break;
      case "overlay":
        A = measure(a[0]); B = measure(a[1]);
        draw(ctx, a[1], x + (m.w - B.w) / 2, y + (m.h - B.h) / 2);
        draw(ctx, a[0], x + (m.w - A.w) / 2, y + (m.h - A.h) / 2); break;
      case "overlay-xy":
        draw(ctx, a[3], x, y); draw(ctx, a[0], x + a[1], y + a[2]); break;
      case "beside":
        A = measure(a[0]); B = measure(a[1]);
        draw(ctx, a[0], x, y + (m.h - A.h) / 2); draw(ctx, a[1], x + A.w, y + (m.h - B.h) / 2); break;
      case "above":
        A = measure(a[0]); B = measure(a[1]);
        draw(ctx, a[0], x + (m.w - A.w) / 2, y); draw(ctx, a[1], x + (m.w - B.w) / 2, y + A.h); break;
      case "empty-scene":
        ctx.strokeStyle = "#888"; ctx.strokeRect(x + 0.5, y + 0.5, a[0] - 1, a[1] - 1); break;
      case "place-image": {
        draw(ctx, a[3], x, y); var I = measure(a[0]); draw(ctx, a[0], x + a[1] - I.w / 2, y + a[2] - I.h / 2); break;
      }
      case "scale":
        ctx.save(); ctx.translate(x, y); ctx.scale(a[0], a[0]); draw(ctx, a[1], 0, 0); ctx.restore(); break;
      case "rotate":
        A = measure(a[1]); ctx.save(); ctx.translate(x + m.w / 2, y + m.h / 2);
        ctx.rotate(a[0] * Math.PI / 180); draw(ctx, a[1], -A.w / 2, -A.h / 2); ctx.restore(); break;
      case "frame":
        draw(ctx, a[0], x, y); ctx.strokeStyle = "black"; ctx.strokeRect(x + 0.5, y + 0.5, m.w - 1, m.h - 1); break;
      case "image-url": {
        var im = imgCache[a[0]];
        if (im && im.complete && im.naturalWidth) { ctx.drawImage(im, x, y, m.w, m.h); }
        else { ctx.strokeStyle = "#bbb"; ctx.strokeRect(x + 0.5, y + 0.5, m.w - 1, m.h - 1);
               ctx.fillStyle = "#999"; ctx.font = "10px sans-serif"; ctx.fillText("(image)", x + 4, y + 14); }
        break;
      }
    }
  }

  function collectUrls(n, set) {
    if (typeof n !== "object" || n === null) return;
    if (n.op === "image-url") set.add(n.args[0]);
    for (var i = 0; i < n.args.length; i++) collectUrls(n.args[i], set);
  }

  // Build a <canvas> for an image string (or tree). Async image-url loads on the
  // UI thread and redraw when ready.
  function renderToCanvas(strOrNode) {
    var node = typeof strOrNode === "string" ? parse(strOrNode) : strOrNode;
    if (!node) return null;
    var canvas = document.createElement("canvas");
    canvas.className = "pyret-image";
    var ctx = canvas.getContext("2d");
    // (Re)measure each render: image-url sizes are unknown until the image loads,
    // so resize the canvas to fit once natural dimensions are available.
    var render = function () {
      var m = measure(node);
      var w = Math.max(1, Math.ceil(m.w)), h = Math.max(1, Math.ceil(m.h));
      if (canvas.width !== w) canvas.width = w;   // assigning resets the context
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      draw(ctx, node, 0, 0);
    };
    var urls = new Set(); collectUrls(node, urls);
    urls.forEach(function (u) {
      if (!imgCache[u]) {
        // Load the image DIRECTLY from its URL (the IDE is a fully static site on
        // GitHub Pages — there is NO server-side CORS proxy). crossOrigin="anonymous"
        // lets the canvas stay untainted (pixel ops work) for hosts that DO send CORS
        // headers; hosts that don't will fail to load or taint the canvas. That's an
        // accepted limitation of the static deploy.
        var im = new Image(); imgCache[u] = im;
        im.crossOrigin = "anonymous";
        im.onload = render; im.onerror = render;
        im.src = u;
      } else if (!imgCache[u].complete) {
        imgCache[u].addEventListener("load", render);
      }
    });
    render();
    return canvas;
  }

  window.PyretImage = { isImageString: isImageString, parse: parse, renderToCanvas: renderToCanvas, measure: measure };
})();
