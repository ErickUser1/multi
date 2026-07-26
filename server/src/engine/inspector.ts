/**
 * Script inspector — corre DENTRO del iframe del preview (inyectado por el proxy).
 *
 * Responsabilidades:
 *  - modo inspect: hover resalta, click selecciona (y no dispara el botón real)
 *  - genera un selector CSS único + ruta legible del elemento
 *  - manda la selección al padre (la sala) por postMessage
 *  - re-valida la selección tras cambios del DOM (MutationObserver): si el
 *    elemento desapareció por HMR, avisa que se limpie; si sigue, actualiza bbox
 *
 * Se exporta como STRING para inyectarlo en el HTML. Escrito en JS plano
 * (corre en el navegador del usuario, no en Node).
 */
export const INSPECTOR_SCRIPT = String.raw`
(function () {
  if (window.__multiInspector) return;
  window.__multiInspector = true;

  var inspectMode = false;
  var selected = null;       // { selector, tag, text, path }
  var hoverEl = null;

  // ── overlays (outline de hover y de selección) ──────────────────────────
  function mkOverlay(color, z) {
    var d = document.createElement('div');
    d.style.cssText =
      'position:fixed;pointer-events:none;z-index:' + z + ';border:2px solid ' +
      color + ';border-radius:3px;transition:all .05s;display:none;box-sizing:border-box;';
    document.documentElement.appendChild(d);
    return d;
  }
  var hoverBox = mkOverlay('rgba(185,168,227,.9)', 2147483646);
  var selBox = mkOverlay('#ffc37a', 2147483645);

  function placeBox(box, el) {
    if (!el) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  // ── selector CSS único + ruta legible ───────────────────────────────────
  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var sel = node.nodeName.toLowerCase();
      if (node.id) { sel += '#' + node.id; parts.unshift(sel); break; }
      var cls = (node.className && typeof node.className === 'string')
        ? node.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
      if (cls) sel += '.' + cls;
      // nth-of-type para desambiguar hermanos del mismo tipo
      var parent = node.parentNode;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) {
          return c.nodeName === node.nodeName;
        });
        if (same.length > 1) {
          sel += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(sel);
      node = node.parentNode;
      depth++;
    }
    return parts.join(' > ');
  }

  function describe(el) {
    var text = (el.textContent || '').trim().slice(0, 60);
    var path = cssPath(el);
    return { selector: path, tag: el.nodeName.toLowerCase(), text: text, path: path };
  }

  function send(type, data) {
    // targetOrigin '*' ok: el padre valida el origen. Aquí no sabemos el origen del padre.
    window.parent.postMessage({ source: 'multi-inspector', type: type, data: data }, '*');
  }

  // ── eventos de mouse ────────────────────────────────────────────────────
  document.addEventListener('mousemove', function (e) {
    if (!inspectMode) return;
    var el = e.target;
    if (el === hoverEl) return;
    hoverEl = el;
    placeBox(hoverBox, el);
  }, true);

  document.addEventListener('click', function (e) {
    if (!inspectMode) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    selected = describe(el);
    placeBox(selBox, el);
    send('element:selected', selected);
  }, true);

  // ── comandos del padre (activar inspect, limpiar selección) ──────────────
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.source !== 'multi-parent') return;
    if (m.type === 'inspect:set') {
      inspectMode = !!m.value;
      document.body.style.cursor = inspectMode ? 'crosshair' : '';
      if (!inspectMode) hoverBox.style.display = 'none';
    } else if (m.type === 'selection:clear') {
      selected = null;
      selBox.style.display = 'none';
    }
  });

  // ── re-validación tras cambios del DOM (edge case HMR) ───────────────────
  function revalidate() {
    if (!selected) return;
    var el = document.querySelector(selected.selector);
    if (el) {
      placeBox(selBox, el); // sigue vivo → reposiciona el outline
    } else {
      // desapareció (HMR borró el elemento) → limpiar y avisar
      selected = null;
      selBox.style.display = 'none';
      send('element:gone', {});
    }
  }

  var mo = new MutationObserver(function () { revalidate(); });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  // reposicionar overlays al hacer scroll/resize (las coords son fixed)
  window.addEventListener('scroll', function () {
    if (selected) revalidate();
    if (inspectMode && hoverEl) placeBox(hoverBox, hoverEl);
  }, true);
  window.addEventListener('resize', function () {
    if (selected) revalidate();
  });
})();
`;
