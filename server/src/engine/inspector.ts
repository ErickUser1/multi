/**
 * Script inspector — corre DENTRO del iframe del preview (inyectado por el proxy).
 *
 * Responsabilidades:
 *  - modo inspect: hover resalta, click selecciona (y no dispara el botón real).
 *    Se pueden marcar varios: cada click agrega uno y otro click en el mismo lo
 *    quita. Cada uno lleva su número, el mismo que se ve en los chips de la sala.
 *  - genera un selector CSS único + ruta legible del elemento
 *  - manda la lista COMPLETA al padre (la sala) por postMessage en cada cambio:
 *    con la lista entera, y no con altas y bajas, el padre y el iframe no se
 *    pueden desfasar
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
  var MAX = 8;
  var selected = [];         // [{ selector, tag, text, path }]
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

  // Un recuadro por elemento seleccionado, con su número en una etiqueta.
  // Se reusan: se crean la primera vez que hacen falta y luego solo se esconden.
  var selBoxes = [];
  function selBox(i) {
    if (!selBoxes[i]) {
      var b = mkOverlay('#ffc37a', 2147483645);
      var n = document.createElement('span');
      n.style.cssText =
        'position:absolute;top:-10px;left:-10px;min-width:18px;height:18px;padding:0 4px;' +
        'border-radius:9px;background:#ffc37a;color:#111;font:700 11px/18px system-ui,sans-serif;' +
        'text-align:center;box-sizing:border-box;';
      b.appendChild(n);
      selBoxes[i] = b;
    }
    // Solo si cambió: escribirlo igual también es una mutación, y el
    // MutationObserver de abajo volvería a pintar en un ciclo sin fin.
    var num = String(i + 1);
    if (selBoxes[i].firstChild.textContent !== num) selBoxes[i].firstChild.textContent = num;
    return selBoxes[i];
  }
  function pintarSeleccion() {
    for (var i = 0; i < Math.max(selBoxes.length, selected.length); i++) {
      if (i < selected.length) placeBox(selBox(i), document.querySelector(selected[i].selector));
      else selBoxes[i].style.display = 'none';
    }
  }
  function indiceDe(selector) {
    for (var i = 0; i < selected.length; i++) if (selected[i].selector === selector) return i;
    return -1;
  }

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
  // El mouse encima del preview, para el cursor que ven los demás. Sin esto el
  // iframe se quedaba con el movimiento y la Sala solo sabía del cursor cuando
  // pasaba por la barra: justo encima de la app, que es donde importa, nadie
  // veía a nadie. La Sala lo traduce a sus coordenadas.
  var ultimoCursor = 0;
  document.addEventListener('mousemove', function (e) {
    var ahora = Date.now();
    if (ahora - ultimoCursor < 40) return;
    ultimoCursor = ahora;
    send('cursor', { x: e.clientX, y: e.clientY });
  }, true);

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
    var d = describe(e.target);
    var i = indiceDe(d.selector);
    if (i !== -1) selected.splice(i, 1);       // ya estaba: se quita
    else if (selected.length < MAX) selected.push(d);
    else { send('selection:max', { max: MAX }); return; }
    pintarSeleccion();
    send('selection:changed', selected);
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
      selected = [];
      pintarSeleccion();
    } else if (m.type === 'selection:remove') {
      var i = indiceDe(m.selector);
      if (i === -1) return;
      selected.splice(i, 1);
      pintarSeleccion();
      send('selection:changed', selected);
    }
  });

  // ── re-validación tras cambios del DOM (edge case HMR) ───────────────────
  function revalidate() {
    if (!selected.length) return;
    // Los que desaparecieron (HMR borró el elemento) se quitan y se avisa con
    // lo que quedó; los que siguen solo se reacomodan.
    var vivos = selected.filter(function (s) { return !!document.querySelector(s.selector); });
    var cambio = vivos.length !== selected.length;
    selected = vivos;
    pintarSeleccion();
    if (cambio) send('selection:changed', selected);
  }

  // ── el overlay de error de Vite ─────────────────────────────────────────
  // Mientras un agente arma archivos, uno puede importar a otro que todavía no
  // existe y Vite pinta su error rojo unos segundos. La sala decide si taparlo
  // (si hay un agente trabajando, es obra a medias y no un error de verdad);
  // aquí solo se avisa cuándo aparece y cuándo se va. Vite lo agrega como hijo
  // directo de <body> y lo quita solo cuando el siguiente cambio compila.
  var conError = null;
  function revisarErrorDeCompilacion() {
    var ahora = !!document.querySelector('vite-error-overlay');
    if (ahora === conError) return;
    conError = ahora;
    send('compilacion', { conError: ahora });
  }
  revisarErrorDeCompilacion();

  // ── es una presentación ─────────────────────────────────────────────────
  // Las diapositivas vienen marcadas con data-diapositiva (lo pide el prompt).
  // La sala, al saberlo, ofrece descargarla y presentarla ella misma, en vez de
  // depender de un botón del agente.
  var diapositivas = -1;
  function revisarPresentacion() {
    var ahora = document.querySelectorAll('[data-diapositiva]').length;
    if (ahora === diapositivas) return;
    diapositivas = ahora;
    send('presentacion', { diapositivas: ahora });
  }
  revisarPresentacion();

  var mo = new MutationObserver(function () { revalidate(); revisarErrorDeCompilacion(); revisarPresentacion(); });
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  // reposicionar overlays al hacer scroll/resize (las coords son fixed)
  window.addEventListener('scroll', function () {
    if (selected.length) revalidate();
    if (inspectMode && hoverEl) placeBox(hoverBox, hoverEl);
  }, true);
  window.addEventListener('resize', function () {
    if (selected.length) revalidate();
  });
})();
`;
