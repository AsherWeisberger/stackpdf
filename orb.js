/* Original dotted-sphere status orb. Not the thinking-orbs package. */
(function (root) {
  "use strict";

  var STATES = {
    working: { rings: 5, spin: 0.85, wobble: 0.35 },
    searching: { rings: 6, spin: 1.05, wobble: 0.12, scan: true },
    solving: { rings: 5, spin: 0.55, wobble: 0.7 },
    listening: { rings: 4, spin: 0.4, wobble: 0.9 },
    connecting: { rings: 5, spin: 0.7, wobble: 0.2 },
    weaving: { rings: 6, spin: 0.9, wobble: 0.5 },
    composing: { rings: 4, spin: 0.62, wobble: 0.55 },
    breathing: { rings: 3, spin: 0.28, wobble: 0.15 },
    shaping: { rings: 5, spin: 0.5, wobble: 0.4 },
  };

  function clampDpr() {
    return Math.min(2, window.devicePixelRatio || 1);
  }

  function inkFor(theme) {
    return theme === "dark" ? "rgba(240,239,236," : "rgba(13,15,20,";
  }

  function createOrb(host, opts) {
    opts = opts || {};
    var size = 20;
    var state = opts.state || "working";
    var theme = opts.theme || "dark";
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    host.appendChild(canvas);
    var ctx = canvas.getContext("2d");
    var dpr = clampDpr();
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + "px";
    canvas.style.height = size + "px";
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var raf = 0;
    var t0 = performance.now();
    var alive = true;
    var vis = true;

    var io = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(function (entries) {
        vis = entries[0] && entries[0].isIntersecting;
      });
      io.observe(canvas);
    }

    function dots() {
      var spec = STATES[state] || STATES.working;
      var t = ((performance.now() - t0) / 1000) * spec.spin;
      if (reduced) t = 0.4;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      var cx = size / 2;
      var cy = size / 2;
      var r = size * 0.42;
      var ink = inkFor(theme);
      var rings = spec.rings;
      for (var i = 0; i < rings; i++) {
        var v = (i + 0.5) / rings;
        var lat = (v - 0.5) * Math.PI;
        var ringR = Math.cos(lat);
        var y = Math.sin(lat);
        var n = Math.max(6, Math.round(10 + ringR * 10));
        for (var j = 0; j < n; j++) {
          var lon = (j / n) * Math.PI * 2 + t * (0.7 + i * 0.08);
          if (spec.wobble) lon += Math.sin(t * 1.4 + i) * spec.wobble * 0.25;
          var x = Math.cos(lon) * ringR;
          var z = Math.sin(lon) * ringR;
          var tilt = 0.55;
          var y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
          var z2 = y * Math.sin(tilt) + z * Math.cos(tilt);
          var persp = 1 / (1.7 - z2);
          var px = cx + x * r * persp;
          var py = cy + y2 * r * persp;
          var a = 0.18 + 0.72 * ((z2 + 1) / 2);
          if (spec.scan) {
            var sweep = (Math.sin(t * 1.8) + 1) / 2;
            var dist = Math.abs(((j / n + t * 0.15) % 1) - sweep);
            a *= 0.35 + 0.65 * (1 - Math.min(1, dist * 4));
          }
          var rad = (0.55 + persp * 0.55) * (size / 20);
          ctx.beginPath();
          ctx.fillStyle = ink + a.toFixed(3) + ")";
          ctx.arc(px, py, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    function loop() {
      if (!alive) return;
      if (vis && !document.hidden) dots();
      if (!reduced) raf = requestAnimationFrame(loop);
    }
    dots();
    if (!reduced) raf = requestAnimationFrame(loop);

    return {
      setState: function (next) { state = next || state; },
      setTheme: function (next) { theme = next || theme; },
      destroy: function () {
        alive = false;
        cancelAnimationFrame(raf);
        if (io) io.disconnect();
        canvas.remove();
      },
    };
  }

  function mountPill(parent, opts) {
    opts = opts || {};
    var theme = opts.theme || "dark";
    var pill = document.createElement("span");
    pill.className = "orb-pill " + theme;
    pill.setAttribute("data-theme", theme);
    pill.setAttribute("role", "status");
    var dot = document.createElement("span");
    dot.className = "orb-dot";
    var label = document.createElement("span");
    label.className = "orb-label";
    label.textContent = opts.label || "Working";
    pill.appendChild(dot);
    pill.appendChild(label);
    parent.appendChild(pill);
    var orb = createOrb(dot, { state: opts.state || "working", theme: theme });
    return {
      el: pill,
      setLabel: function (text) { label.textContent = text; },
      setState: orb.setState,
      setTheme: function (next) {
        theme = next || theme;
        pill.className = "orb-pill " + theme;
        pill.setAttribute("data-theme", theme);
        orb.setTheme(theme);
      },
      destroy: function () {
        orb.destroy();
        pill.remove();
      },
    };
  }

  function hostTheme() {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  root.KitOrb = { createOrb: createOrb, mountPill: mountPill, hostTheme: hostTheme };
})(typeof window !== "undefined" ? window : this);
