/* global Fares, FaresTheme, FaresExport */
(() => {
  const { normalize, escapeHtml: esc, fmt, digits, formatDate, formatDateTime, api, icon, toast } = Fares;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const params = new URLSearchParams(location.search);
  const OPTS_KEY = 'fares-print-opts';
  const DEFAULTS = { orientation: 'auto', ink: 'color', density: 'comfortable', notes: true, terms: true, serial: true, summary: true };

  const state = {
    data: null,
    q: params.get('q') || '',
    section: params.get('s') || 'all',
    vehicles: null, // Set of vehicle ids
    opts: { ...DEFAULTS },
  };
  try { Object.assign(state.opts, JSON.parse(localStorage.getItem(OPTS_KEY) || '{}')); } catch { /* ignore */ }
  const saveOpts = () => { try { localStorage.setItem(OPTS_KEY, JSON.stringify(state.opts)); } catch { /* ignore */ } };

  // ---------- data selection (mirrors the public page filters) ----------
  function matches(route, section) {
    if (!state.q) return true;
    const hay = normalize(`${route.name} ${route.note || ''} ${section.name}`);
    return normalize(state.q).split(' ').every((t) => hay.includes(t));
  }
  function groups() {
    const out = [];
    for (const sec of state.data.sections) {
      if (state.section !== 'all' && sec.id !== state.section) continue;
      const rows = state.data.routes.filter((r) => r.sectionId === sec.id && matches(r, sec));
      if (rows.length) out.push({ section: sec, rows });
    }
    return out;
  }
  const vehicles = () => state.data.vehicles.filter((v) => state.vehicles.has(v.id));
  const scope = () => {
    const out = [];
    if (state.section !== 'all') out.push(state.data.sections.find((s) => s.id === state.section)?.name);
    if (state.vehicles.size < state.data.vehicles.length) out.push(vehicles().map((v) => v.name).join(' و'));
    if (state.q) out.push(`بحث: ${state.q}`);
    return out.filter(Boolean);
  };
  const places = (name) => name.split(' - ').map((p) => p.trim()).filter(Boolean);
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 3 && n <= 10 ? few : many);

  function orientation() {
    if (state.opts.orientation !== 'auto') return state.opts.orientation;
    return vehicles().length * state.data.fareTypes.length > 6 ? 'landscape' : 'portrait';
  }

  // ---------- page rule (size, margins, running footer) ----------
  let pageRuleIndex = null;
  function setPageRule() {
    const sheet = $('#print-css').sheet;
    if (!sheet) return;
    if (pageRuleIndex !== null) { try { sheet.deleteRule(pageRuleIndex); } catch { /* ignore */ } }
    const s = state.data.settings;
    const q = (t) => `"${String(t).replace(/["\\\n]/g, ' ')}"`;
    const left = [s.brand, s.effectiveDate ? `سارية من ${formatDate(s.effectiveDate)}` : ''].filter(Boolean).join('  ·  ');
    const rule = `@page {
      size: A4 ${orientation()};
      margin: 13mm 11mm 15mm;
      @bottom-center { content: "صفحة " counter(page${FaresTheme.current.numerals === 'arab' ? ', arabic-indic' : ''}) " من " counter(pages${FaresTheme.current.numerals === 'arab' ? ', arabic-indic' : ''}); font-family: ${q('Plex Arabic')}, sans-serif; font-size: 8pt; color: #666; }
      @bottom-left { content: ${q(left)}; font-family: ${q('Plex Arabic')}, sans-serif; font-size: 7.5pt; color: #888; }
      @bottom-right { content: ${q(s.title)}; font-family: ${q('Plex Arabic')}, sans-serif; font-size: 7.5pt; color: #888; }
    }`;
    try {
      pageRuleIndex = sheet.insertRule(rule, sheet.cssRules.length);
    } catch {
      // Older engines don't know margin boxes; keep size and margins at least.
      pageRuleIndex = sheet.insertRule(`@page { size: A4 ${orientation()}; margin: 13mm 11mm 15mm; }`, sheet.cssRules.length);
    }
  }

  // ---------- document ----------
  function render() {
    const { settings: s, fareTypes, notes, version, updatedAt } = state.data;
    const V = vehicles();
    const G = groups();
    const nF = fareTypes.length;
    const o = state.opts;
    const doc = $('#doc');
    const total = G.reduce((n, g) => n + g.rows.length, 0);
    doc.classList.toggle('landscape', orientation() === 'landscape');
    doc.classList.toggle('ink-save', o.ink === 'save');
    doc.classList.toggle('compact', o.density === 'compact');
    doc.classList.toggle('arab-digits', FaresTheme.current.numerals === 'arab');
    const hasNotes = o.notes && G.some((g) => g.rows.some((r) => r.note));

    if (!V.length || !G.length) {
      doc.innerHTML = `<p class="doc-loading">${!V.length ? 'اختر فئة سيارة واحدة على الأقل.' : 'لا توجد وجهات مطابقة لهذه الاختيارات.'}</p>`;
      fitPreview();
      return;
    }

    const head = `
      <header class="doc-head">
        <div class="brand-block">
          <span class="brand-mark">${esc(s.brand.trim()[0] || 'ل')}</span>
          <div><strong>${esc(s.brand)}</strong>${s.phone ? `<span dir="ltr" class="num">${esc(s.phone)}</span>` : ''}</div>
        </div>
        <div class="title-block">
          <h1>${esc(s.title)}</h1>
          ${s.subtitle ? `<p>${esc(s.subtitle)}</p>` : ''}
        </div>
        <div class="valid-block">
          <span>سارية اعتباراً من</span>
          <strong>${esc(formatDate(s.effectiveDate) || '—')}</strong>
          <small>إصدار رقم ${esc(digits(version))}</small>
        </div>
      </header>`;

    const summary = o.summary ? `
      <div class="doc-summary">
        <span><b>${fmt(total)}</b> وجهة</span>
        <span><b>${fmt(G.length)}</b> منطقة</span>
        <span>الأسعار بـ${esc(s.currency)}</span>
        ${FaresTheme.current.fareColors.mode !== 'off' || o.ink === 'save' ? `<span class="legend">${fareTypes.map((f, i) => `<span class="f-${i}">${esc(f.name)}</span>`).join('')}</span>` : ''}
      </div>` : '';
    const sc = scope();
    const scopeLine = sc.length ? `<p class="doc-scope">نطاق الطباعة: <b>${esc(sc.join(' · '))}</b></p>` : '';

    let serial = 0;
    const colgroup = `<colgroup>${o.serial ? '<col class="c-serial">' : ''}<col>${V.map(() => fareTypes.map(() => '<col class="c-price">').join('')).join('')}</colgroup>`;
    const span = (o.serial ? 1 : 0) + 1 + V.length * nF;

    const areas = G.map(({ section, rows }) => {
      const body = rows.map((r) => {
        serial++;
        const ps = places(r.name);
        const dest = r.kind === 'flat'
          ? `<span class="dest">${esc(digits(r.name))}</span><span class="pkg">باقة</span>`
          : `<span class="dest">${ps.map((p) => `<span class="pl">${esc(digits(p))}</span>`).join('<span class="sep">،</span> ')}</span>`;
        const note = hasNotes && r.note ? `<span class="note">${esc(digits(r.note))}</span>` : '';
        const cells = V.map((v) => {
          const pr = r.prices[v.id] || {};
          if (r.kind === 'flat') {
            const val = pr[fareTypes[0].id];
            return `<td class="p flat f-0 ${val == null ? 'na' : ''}" colspan="${nF}">${val == null ? '—' : `${fmt(val)}<small>سعر ثابت</small>`}</td>`;
          }
          return fareTypes.map((f, fi) => (pr[f.id] == null
            ? `<td class="p na f-${fi}">—</td>`
            : `<td class="p f-${fi}">${fmt(pr[f.id])}</td>`)).join('');
        }).join('');
        return `<tr>${o.serial ? `<td class="s">${fmt(serial)}</td>` : ''}<td class="d">${dest}${note}</td>${cells}</tr>`;
      }).join('');

      return `
        <section class="area">
          <table class="pt">
            ${colgroup}
            <thead>
              <tr class="area-row"><th colspan="${span}">
                <span class="area-name">${esc(section.name)}</span>
                <span class="area-count">${fmt(rows.length)} ${plural(rows.length, 'وجهة', 'وجهات', 'وجهة')}</span>
                ${section.note ? `<span class="area-note">${esc(digits(section.note))}</span>` : ''}
              </th></tr>
              <tr class="veh-row">
                ${o.serial ? '<th rowspan="2">#</th>' : ''}
                <th rowspan="2" class="th-dest">الوجهة</th>
                ${V.map((v) => `<th colspan="${nF}">${esc(v.name)}</th>`).join('')}
              </tr>
              <tr class="fare-row">${V.map(() => fareTypes.map((f, fi) => `<th class="f-${fi}">${esc(f.name)}</th>`).join('')).join('')}</tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </section>`;
    }).join('');

    const terms = o.terms && notes.length ? `
      <section class="terms">
        <h2>الشروط والإضافات</h2>
        <ol>${notes.map((n) => `<li>${esc(digits(n.text))}</li>`).join('')}</ol>
      </section>` : '';

    const end = `
      <footer class="doc-end">
        <span>${esc(s.brand)} — ${esc(s.title)}</span>
        <span>آخر تحديث ${esc(formatDateTime(updatedAt))} · طُبعت في ${esc(formatDateTime(new Date().toISOString()))}</span>
      </footer>`;

    doc.innerHTML = head + summary + scopeLine + areas + terms + end;
    document.title = `${s.title} — ${s.brand}${s.effectiveDate ? ` — ${s.effectiveDate}` : ''}`;
    setPageRule();
    fitPreview();
  }

  // Scale the A4 paper to the screen width on small devices (screen only).
  function fitPreview() {
    const doc = $('#doc');
    doc.style.zoom = '';
    const avail = $('#stage').clientWidth - 16;
    const w = doc.offsetWidth;
    if (w > avail) doc.style.zoom = String(Math.max(0.3, avail / w));
  }

  // ---------- toolbar ----------
  function paintOptions() {
    const { sections, vehicles: all } = state.data;
    $('#opt-section').innerHTML = `<option value="all">كل المناطق (${fmt(sections.length)})</option>`
      + sections.map((s) => `<option value="${esc(s.id)}" ${state.section === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    $('#opt-vehicles').innerHTML = all.map((v) => `<label><input type="checkbox" value="${esc(v.id)}" ${state.vehicles.has(v.id) ? 'checked' : ''}> ${esc(v.name)}</label>`).join('');
    $$('[data-opt]').forEach((g) => $$('button', g).forEach((b) => b.setAttribute('aria-pressed', String(state.opts[g.dataset.opt] === b.dataset.val))));
    $$('[data-opt-check]').forEach((c) => { c.checked = !!state.opts[c.dataset.optCheck]; });
  }

  function bind() {
    $('#opt-section').addEventListener('change', (e) => { state.section = e.target.value; render(); });
    $('#opt-vehicles').addEventListener('change', (e) => {
      if (e.target.checked) state.vehicles.add(e.target.value); else state.vehicles.delete(e.target.value);
      render();
    });
    $('#options').addEventListener('click', (e) => {
      const b = e.target.closest('[data-opt] [data-val]');
      if (!b) return;
      const key = b.closest('[data-opt]').dataset.opt;
      state.opts[key] = b.dataset.val;
      saveOpts();
      paintOptions();
      render();
    });
    $('#options').addEventListener('change', (e) => {
      const k = e.target.dataset.optCheck;
      if (!k) return;
      state.opts[k] = e.target.checked;
      saveOpts();
      render();
    });
    $('#options').addEventListener('submit', (e) => e.preventDefault());
    $('#print-btn').addEventListener('click', () => window.print());
    $('#xlsx-btn').addEventListener('click', () => FaresExport.run('xlsx', { data: state.data, groups: groups(), vehicles: vehicles(), scope: scope() }));
    window.addEventListener('resize', fitPreview);
    window.addEventListener('beforeprint', () => { $('#doc').style.zoom = ''; setPageRule(); });
    window.addEventListener('afterprint', fitPreview);
  }

  async function init() {
    $('#back-link').innerHTML = `${icon('external')}<span>العودة للقائمة</span>`;
    const back = new URLSearchParams(params);
    back.delete('auto');
    $('#back-link').href = `/${back.toString() ? `?${back}` : ''}`;
    $('#print-btn').innerHTML = `${icon('print')}<span>طباعة / حفظ PDF</span>`;
    $('#xlsx-btn').innerHTML = `${icon('sheet')}<span>Excel</span>`;
    $('#pt-hint').innerHTML = `${icon('info')}<span>لحفظ ملف PDF اختر «حفظ بتنسيق PDF» من نافذة الطباعة، وألغِ خيار «الرؤوس والتذييلات» ليظهر ترقيم الصفحات الخاص بالقائمة.</span>`;
    try {
      state.data = await api('/api/prices');
    } catch (err) {
      $('#doc').innerHTML = `<p class="doc-loading">تعذّر تحميل الأسعار: ${esc(err.message)}</p>`;
      return;
    }
    // Documents always use the light palette (white paper).
    FaresTheme.apply(state.data.theme, { mode: 'light', ignoreUser: true });
    const p = FaresTheme.current.light;
    const root = document.documentElement.style;
    root.setProperty('--doc-primary', p.primary);
    root.setProperty('--doc-on-primary', FaresTheme.onColor(p.primary));
    root.setProperty('--doc-accent', p.accent);
    root.setProperty('--doc-band', FaresTheme.mix('#ffffff', p.accent, 0.13));

    const v = params.get('v');
    state.vehicles = new Set(v && state.data.vehicles.some((x) => x.id === v) ? [v] : state.data.vehicles.map((x) => x.id));
    if (state.section !== 'all' && !state.data.sections.some((x) => x.id === state.section)) state.section = 'all';
    paintOptions();
    bind();
    render();
    if (params.get('auto') === '1') {
      await document.fonts.ready;
      setTimeout(() => window.print(), 250);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
