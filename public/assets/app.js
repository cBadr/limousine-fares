/* global Fares, FaresTheme, XLSX */
(() => {
  const { normalize, escapeHtml: esc, highlight, fmt, formatDate, formatDateTime, api, icon, toast, bindThemeButton, download, debounce } = Fares;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const PREVIEW = new URLSearchParams(location.search).has('preview');

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { if (PREVIEW) return; try { localStorage.setItem(k, v); } catch { /* blocked */ } },
  };

  const state = {
    data: null,
    q: '',
    vehicle: 'all',
    section: 'all',
    open: new Set(),
  };

  // ---------- URL & saved preferences ----------
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.vehicle = p.get('v') || store.get('fares-vehicle') || 'all';
    state.section = p.get('s') || 'all';
  }
  function writeUrl() {
    if (PREVIEW) return;
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.vehicle !== 'all') p.set('v', state.vehicle);
    if (state.section !== 'all') p.set('s', state.section);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  // ---------- derived ----------
  const visibleVehicles = () => {
    const all = state.data.vehicles;
    return state.vehicle === 'all' ? all : all.filter((v) => v.id === state.vehicle);
  };

  function matches(route, section) {
    if (!state.q) return true;
    const hay = normalize(`${route.name} ${section.name}`);
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

  function priceRange(rows) {
    const vals = [];
    for (const r of rows) for (const v of visibleVehicles()) for (const f of state.data.fareTypes) {
      const x = r.prices?.[v.id]?.[f.id];
      if (x != null) vals.push(x);
    }
    return vals.length ? [Math.min(...vals), Math.max(...vals)] : null;
  }

  function zoneIcon(name) {
    const n = normalize(name);
    if (n.includes('مطار')) return 'plane';
    if (n.includes('يومي')) return 'clock';
    return 'pin';
  }
  const vehicleIcon = (v) => icon(state.data.vehicles.indexOf(v) > 0 || normalize(v.name).includes('فان') ? 'van' : 'car');
  const places = (name) => name.split(' - ').map((p) => p.trim()).filter(Boolean);
  const plural = (n, one, few, many) => (n === 1 ? one : n >= 3 && n <= 10 ? few : many);

  // ---------- header ----------
  function renderHeader() {
    const { settings, routes, sections, vehicles, updatedAt } = state.data;
    document.title = `${settings.title} — ${settings.brand}`;
    $('#brand-name').textContent = settings.brand;
    $('#brand-mark').textContent = settings.brand.trim()[0] || 'ل';
    $('#page-title').textContent = settings.title;
    $('#page-subtitle').textContent = settings.subtitle || '';
    $('#effective-date').textContent = formatDate(settings.effectiveDate) || '—';
    $('#updated-at').textContent = updatedAt ? `آخر تحديث ${formatDateTime(updatedAt)}` : '';
    $('#footer-brand').textContent = settings.brand;
    $('#footer-note').textContent = `الأسعار بـ${settings.currency} وقابلة للتعديل`;
    $('#facts').innerHTML = [
      [routes.length, 'وجهة'],
      [sections.length, 'منطقة'],
      [vehicles.length, 'فئات سيارات'],
    ].map(([n, l]) => `<div><dt>${l}</dt><dd class="num">${fmt(n)}</dd></div>`).join('')
      + (settings.phone ? `<div><dt>للحجز</dt><dd class="num" dir="ltr">${esc(settings.phone)}</dd></div>` : '');
    $('#print-brand').textContent = settings.brand;
    $('#print-title').textContent = settings.title;
  }

  function renderVehicleSwitch() {
    const opts = [{ id: 'all', name: 'الكل' }, ...state.data.vehicles];
    if (!opts.some((o) => o.id === state.vehicle)) state.vehicle = 'all';
    $('#vehicle-switch').innerHTML = opts
      .map((o) => `<button type="button" data-v="${esc(o.id)}" aria-pressed="${o.id === state.vehicle}">${esc(o.name)}</button>`)
      .join('');
  }

  function renderChips() {
    const { sections, routes } = state.data;
    if (state.section !== 'all' && !sections.some((s) => s.id === state.section)) state.section = 'all';
    const count = (sec) => routes.filter((r) => r.sectionId === sec.id && matches(r, sec)).length;
    const total = sections.reduce((n, s) => n + count(s), 0);
    const chip = (id, name, n) => `<button type="button" class="chip${n ? '' : ' is-empty'}" data-s="${esc(id)}" aria-pressed="${state.section === id}">${esc(name)}<span class="chip-count num">${fmt(n)}</span></button>`;
    $('#chips').innerHTML = chip('all', 'كل المناطق', total) + sections.map((s) => chip(s.id, s.name, count(s))).join('');
  }

  // ---------- accordion state ----------
  function defaultOpen(list) {
    const mode = FaresTheme.current.sections;
    state.open = new Set(mode === 'expanded' ? list.map((g) => g.section.id) : mode === 'first' && list[0] ? [list[0].section.id] : []);
  }

  // Searching, filtering by one area, or a single result always shows rows expanded.
  const forcedOpen = (list) => !!state.q || state.section !== 'all' || list.length === 1;

  function renderToggleAll(list) {
    const tb = $('#toggle-all');
    const zones = $$('#zones .zone');
    tb.hidden = forcedOpen(list || groups()) || zones.length < 2;
    const allOpen = zones.length && zones.every((z) => z.dataset.open === 'true');
    tb.innerHTML = allOpen ? `${icon('fold')}<span>طيّ الكل</span>` : `${icon('unfold')}<span>فتح الكل</span>`;
    tb.dataset.action = allOpen ? 'close' : 'open';
  }

  // ---------- zones ----------
  function renderZones() {
    const { fareTypes, settings } = state.data;
    const vehicles = visibleVehicles();
    const list = groups();
    const host = $('#zones');
    const nF = fareTypes.length;
    const total = list.reduce((n, g) => n + g.rows.length, 0);
    const forced = forcedOpen(list);

    $('#result-line').innerHTML = state.q
      ? (total ? `<strong class="num">${fmt(total)}</strong> نتيجة لـ «${esc(state.q)}»` : '')
      : `<strong class="num">${fmt(total)}</strong> وجهة في <strong class="num">${fmt(list.length)}</strong> منطقة`;

    if (!list.length) {
      host.innerHTML = `
        <div class="empty">${icon('search')}
          <strong>لا توجد نتائج مطابقة</strong>
          <span>جرّب كلمة أقصر أو اسماً آخر للمنطقة.</span>
          <button class="btn" type="button" id="clear-all">مسح البحث</button>
        </div>`;
      renderToggleAll(list);
      return;
    }

    const cols = `
      <div class="cols" aria-hidden="true">
        <span class="c-dest">الوجهة</span>
        ${vehicles.map((v) => `<span class="c-veh"><span class="c-vname">${vehicleIcon(v)}${esc(v.name)}</span>${fareTypes.map((f) => `<span>${esc(f.name)}</span>`).join('')}</span>`).join('')}
        <span class="c-go"></span>
      </div>`;

    host.innerHTML = list.map(({ section, rows }) => {
      const open = forced || state.open.has(section.id);
      const range = priceRange(rows);
      const meta = `<span class="num">${fmt(rows.length)}</span> ${plural(rows.length, 'وجهة', 'وجهات', 'وجهة')}`
        + (range ? ` · من <span class="num">${fmt(range[0])}</span>${range[1] !== range[0] ? ` إلى <span class="num">${fmt(range[1])}</span>` : ''} ${esc(settings.currency)}` : '');
      const items = rows.map((r) => {
        const dest = `<span class="place-wrap">${places(r.name).map((p) => `<span class="place${p.length > 22 ? ' long' : ''}">${highlight(p, state.q)}</span>`).join(' ')}</span>`;
        const label = [r.name];
        const vcells = vehicles.map((v) => {
          const pr = r.prices[v.id] || {};
          const vl = `<span class="fr-vlabel">${vehicleIcon(v)}${esc(v.name)}</span>`;
          if (r.kind === 'flat') {
            const val = pr[fareTypes[0].id];
            label.push(`${v.name}: ${val == null ? 'غير متاح' : `${fmt(val)} سعر ثابت`}`);
            return `<span class="fr-veh">${vl}<span class="fr-flat num">${val == null ? '—' : `<small>سعر ثابت</small>${fmt(val)}`}</span></span>`;
          }
          label.push(`${v.name}: ${fareTypes.map((f) => `${f.name} ${pr[f.id] == null ? 'غير متاح' : fmt(pr[f.id])}`).join('، ')}`);
          return `<span class="fr-veh">${vl}${fareTypes.map((f) => (pr[f.id] == null
            ? '<span class="fr-p na">—</span>'
            : `<span class="fr-p num">${fmt(pr[f.id])}</span>`)).join('')}</span>`;
        }).join('');
        return `<li><button type="button" class="fare-row" data-rid="${esc(r.id)}" aria-label="${esc(label.join('. '))}" aria-haspopup="dialog">
          <span class="fr-name">${dest}${r.kind === 'flat' ? '<span class="flat-badge">باقة</span>' : ''}</span>
          ${vcells}
          <span class="fr-go" aria-hidden="true">${icon('chevronDown')}</span>
        </button></li>`;
      }).join('');

      return `
        <section class="zone vcount-${vehicles.length}" data-sid="${esc(section.id)}" data-open="${open}">
          <h2 class="zone-h">
            <button type="button" class="zone-toggle" aria-expanded="${open}" aria-controls="zb-${esc(section.id)}">
              <span class="zone-icon" aria-hidden="true">${icon(zoneIcon(section.name))}</span>
              <span class="zone-title">
                <span class="zone-name">${highlight(section.name, state.q)}</span>
                <span class="zone-meta">${meta}</span>
              </span>
              <span class="chev" aria-hidden="true">${icon('chevronDown')}</span>
            </button>
          </h2>
          <div class="zone-body" id="zb-${esc(section.id)}" role="region" aria-label="${esc(section.name)}">
            <div class="zone-inner">
              ${section.note ? `<p class="zone-note">${esc(section.note)}</p>` : ''}
              ${cols}
              <ul class="fares">${items}</ul>
            </div>
          </div>
        </section>`;
    }).join('');

    // Grid sizing per zone (CSP forbids inline styles), and keep collapsed bodies out of the tab order.
    $$('.zone', host).forEach((z) => {
      z.style.setProperty('--vcount', vehicles.length);
      z.style.setProperty('--fcount', nF);
      $('.zone-body', z).inert = z.dataset.open !== 'true';
    });
    renderToggleAll(list);
  }

  function setZone(zone, open) {
    zone.dataset.open = String(open);
    $('.zone-toggle', zone).setAttribute('aria-expanded', String(open));
    $('.zone-body', zone).inert = !open;
    if (zone.dataset.sid) { if (open) state.open.add(zone.dataset.sid); else state.open.delete(zone.dataset.sid); }
  }

  function renderTerms() {
    const { notes } = state.data;
    const el = $('#terms');
    el.hidden = !notes.length;
    if (!notes.length) return;
    el.dataset.open = 'false';
    el.innerHTML = `
      <h2 class="zone-h">
        <button type="button" class="zone-toggle" aria-expanded="false" aria-controls="terms-body">
          <span class="zone-icon" aria-hidden="true">${icon('list')}</span>
          <span class="zone-title"><span class="zone-name">الشروط والإضافات</span>
            <span class="zone-meta"><span class="num">${fmt(notes.length)}</span> ${plural(notes.length, 'بند', 'بنود', 'بنداً')} — الانتظار، الإضافات، اليوميات</span></span>
          <span class="chev" aria-hidden="true">${icon('chevronDown')}</span>
        </button>
      </h2>
      <div class="zone-body" id="terms-body" role="region" aria-label="الشروط والإضافات">
        <div class="zone-inner"><ol>${notes.map((n) => `<li>${esc(n.text)}</li>`).join('')}</ol></div>
      </div>`;
    $('.zone-body', el).inert = true;
  }

  function renderAll() {
    renderVehicleSwitch();
    renderChips();
    renderZones();
    writeUrl();
    updatePrintMeta();
  }

  // ---------- details sheet ----------
  function quoteText(route) {
    const { sections, fareTypes, settings } = state.data;
    const sec = sections.find((s) => s.id === route.sectionId);
    const lines = [`${sec ? sec.name : ''} — ${route.name}`];
    for (const v of visibleVehicles()) {
      const pr = route.prices[v.id] || {};
      if (route.kind === 'flat') {
        const val = pr[fareTypes[0].id];
        if (val != null) lines.push(`${v.name}: ${fmt(val)} ${settings.currency}`);
      } else {
        const parts = fareTypes.filter((f) => pr[f.id] != null).map((f) => `${f.name} ${fmt(pr[f.id])}`);
        if (parts.length) lines.push(`${v.name}: ${parts.join(' · ')} ${settings.currency}`);
      }
    }
    if (settings.effectiveDate) lines.push(`(أسعار سارية من ${formatDate(settings.effectiveDate)})`);
    return lines.join('\n');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  function openSheet(rid) {
    const { routes, sections, vehicles, fareTypes, settings } = state.data;
    const r = routes.find((x) => x.id === rid);
    if (!r) return;
    const sec = sections.find((s) => s.id === r.sectionId);
    const ps = places(r.name);
    const sheet = $('#sheet');
    const cards = vehicles.map((v) => {
      const pr = r.prices[v.id] || {};
      const cells = r.kind === 'flat'
        ? `<div><dt>سعر ثابت</dt><dd class="num ${pr[fareTypes[0].id] == null ? 'na' : ''}">${pr[fareTypes[0].id] == null ? '—' : fmt(pr[fareTypes[0].id])}</dd></div>`
        : fareTypes.map((f) => `<div><dt>${esc(f.name)}</dt><dd class="num ${pr[f.id] == null ? 'na' : ''}">${pr[f.id] == null ? '—' : fmt(pr[f.id])}</dd></div>`).join('');
      return `<section class="veh-card ${state.vehicle === v.id ? 'is-pref' : ''}">
        <h3>${vehicleIcon(v)}${esc(v.name)}</h3>
        <dl class="${r.kind === 'flat' ? 'one' : ''}">${cells}</dl>
      </section>`;
    }).join('');
    sheet.innerHTML = `
      <span class="sheet-grab" aria-hidden="true"></span>
      <header class="sheet-head">
        <span class="sheet-zone">${icon(zoneIcon(sec ? sec.name : ''))}${esc(sec ? sec.name : '')}</span>
        <h2 id="sheet-title">${esc(r.kind === 'flat' || ps.length < 2 ? r.name : ps.slice(0, 2).join(' - ') + (ps.length > 2 ? '…' : ''))}</h2>
        ${r.kind !== 'flat' && ps.length > 1 ? `<div class="sheet-places">${ps.map((p) => `<span>${esc(p)}</span>`).join('')}</div>` : ''}
        <button class="icon-btn sheet-close" type="button" data-close aria-label="إغلاق">${icon('x')}</button>
      </header>
      <div class="sheet-body">${cards}</div>
      <p class="sheet-note">الأسعار بـ${esc(settings.currency)}${settings.effectiveDate ? ` · سارية من ${esc(formatDate(settings.effectiveDate))}` : ''}. راجع الشروط والإضافات أسفل القائمة.</p>
      <footer class="sheet-foot">
        <button class="btn btn-brass" type="button" data-copy>${icon('copy')}<span>نسخ السعر</span></button>
        <button class="btn" type="button" data-share>${icon(navigator.share ? 'share' : 'message')}<span>${navigator.share ? 'مشاركة' : 'واتساب'}</span></button>
      </footer>`;
    $$('.veh-card dl', sheet).forEach((dl) => dl.style.setProperty('--fcount', dl.classList.contains('one') ? 1 : fareTypes.length));
    sheet.dataset.rid = rid;
    sheet.showModal();
    $('[data-copy]', sheet).focus({ preventScroll: true });
  }

  function bindSheet() {
    const sheet = $('#sheet');
    sheet.addEventListener('click', async (e) => {
      if (e.target === sheet || e.target.closest('[data-close]')) return sheet.close();
      const r = state.data.routes.find((x) => x.id === sheet.dataset.rid);
      if (!r) return;
      if (e.target.closest('[data-copy]')) {
        const ok = await copyText(quoteText(r));
        toast(ok ? 'تم نسخ السعر — جاهز للصقه في رسالة' : 'تعذّر النسخ', ok ? 'ok' : 'error');
      }
      if (e.target.closest('[data-share]')) {
        const text = quoteText(r);
        if (navigator.share) {
          try { await navigator.share({ text }); } catch { /* cancelled */ }
        } else {
          window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
        }
      }
    });
  }

  // ---------- export & print ----------
  function exportRows() {
    const { fareTypes, settings } = state.data;
    const vehicles = visibleVehicles();
    const header1 = ['المنطقة', 'الوجهة', 'النوع'];
    const header2 = ['', '', ''];
    for (const v of vehicles) fareTypes.forEach((f, i) => { header1.push(i === 0 ? v.name : ''); header2.push(f.name); });
    const rows = [];
    for (const { section, rows: rs } of groups()) {
      for (const r of rs) {
        const row = [section.name, r.name, r.kind === 'flat' ? 'سعر ثابت' : 'توصيل'];
        for (const v of vehicles) {
          const pr = r.prices[v.id] || {};
          fareTypes.forEach((f, i) => {
            const val = r.kind === 'flat' && i > 0 ? null : pr[f.id];
            row.push(val == null ? '' : val);
          });
        }
        rows.push(row);
      }
    }
    return { header1, header2, rows, settings, vehicles };
  }

  function fileBase() {
    const s = state.data.settings;
    return `${s.title} ${s.effectiveDate || ''}`.trim().replace(/[\\/:*?"<>|]/g, '-');
  }

  function exportCsv() {
    const { header2, rows, vehicles } = exportRows();
    const nF = state.data.fareTypes.length;
    const head = header2.map((h, i) => (i < 3 ? ['المنطقة', 'الوجهة', 'النوع'][i] : `${vehicles[Math.floor((i - 3) / nF)].name} - ${h}`));
    const escCsv = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [head, ...rows].map((r) => r.map(escCsv).join(',')).join('\r\n');
    download(`${fileBase()}.csv`, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    toast('تم تصدير ملف CSV');
  }

  function exportXlsx() {
    if (typeof XLSX === 'undefined') { toast('مكتبة التصدير لم تُحمّل بعد، حاول مجدداً', 'error'); return; }
    const { header1, header2, rows, settings } = exportRows();
    const title = `${settings.title}${settings.effectiveDate ? ` — سارية من ${formatDate(settings.effectiveDate)}` : ''}`;
    const aoa = [[title], [], header1, header2, ...rows];
    if (state.data.notes.length) {
      aoa.push([], ['الشروط والإضافات']);
      state.data.notes.forEach((n, i) => aoa.push([`${i + 1}. ${n.text}`]));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const nF = state.data.fareTypes.length;
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header1.length - 1 } }];
    for (let c = 3; c < header1.length; c += nF) merges.push({ s: { r: 2, c }, e: { r: 2, c: c + nF - 1 } });
    for (let c = 0; c < 3; c++) merges.push({ s: { r: 2, c }, e: { r: 3, c } });
    const notesStart = 4 + rows.length + 2;
    state.data.notes.forEach((_, i) => merges.push({ s: { r: notesStart + i, c: 0 }, e: { r: notesStart + i, c: header1.length - 1 } }));
    ws['!merges'] = merges;
    ws['!cols'] = [{ wch: 18 }, { wch: 60 }, { wch: 10 }, ...header1.slice(3).map(() => ({ wch: 12 }))];
    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, 'قائمة الأسعار');
    XLSX.writeFile(wb, `${fileBase()}.xlsx`);
    toast('تم تصدير ملف Excel');
  }

  function updatePrintMeta() {
    if (!state.data) return;
    const s = state.data.settings;
    const scope = [];
    if (state.section !== 'all') scope.push(state.data.sections.find((x) => x.id === state.section)?.name);
    if (state.vehicle !== 'all') scope.push(state.data.vehicles.find((x) => x.id === state.vehicle)?.name);
    if (state.q) scope.push(`بحث: ${state.q}`);
    $('#print-meta').innerHTML = [
      s.effectiveDate ? `سارية من ${esc(formatDate(s.effectiveDate))}` : '',
      scope.length ? esc(scope.filter(Boolean).join(' · ')) : '',
      `طُبعت في ${esc(formatDateTime(new Date().toISOString()))}`,
    ].filter(Boolean).join('<br>');
  }

  function printNow() { updatePrintMeta(); window.print(); }

  // ---------- visitor text size ----------
  const ZOOMS = [1, 1.15, 1.3];
  const ZOOM_NAMES = ['عادي', 'كبير', 'كبير جداً'];
  function paintZoom() {
    const z = Number(store.get('fares-zoom')) || 1;
    const i = Math.max(0, ZOOMS.indexOf(z));
    const btn = $('#zoom-btn');
    btn.innerHTML = icon('type');
    btn.setAttribute('aria-label', `حجم الخط: ${ZOOM_NAMES[i]} — اضغط للتكبير`);
    btn.title = btn.getAttribute('aria-label');
  }
  function cycleZoom() {
    const z = Number(store.get('fares-zoom')) || 1;
    const next = ZOOMS[(Math.max(0, ZOOMS.indexOf(z)) + 1) % ZOOMS.length];
    try { localStorage.setItem('fares-zoom', String(next)); } catch { /* ignore */ }
    FaresTheme.apply(FaresTheme.current, { userZoom: true });
    paintZoom();
    toast(`حجم الخط: ${ZOOM_NAMES[ZOOMS.indexOf(next)]}`);
  }

  // ---------- events ----------
  function bindEvents() {
    const q = $('#q');
    const clear = $('#search-clear');
    q.value = state.q;
    clear.hidden = !state.q;
    const onSearch = debounce(() => {
      state.q = q.value.trim();
      renderChips();
      renderZones();
      writeUrl();
    }, 120);
    q.addEventListener('input', () => { clear.hidden = !q.value; onSearch(); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && q.value) { q.value = ''; clear.hidden = true; onSearch(); }
      if (e.key === 'Enter') q.blur(); // hide the phone keyboard to reveal results
    });
    clear.addEventListener('click', () => { q.value = ''; clear.hidden = true; onSearch(); q.focus(); });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== q && !/input|textarea|select/i.test(document.activeElement.tagName) && !$('#sheet').open) {
        e.preventDefault();
        q.focus();
      }
    });

    $('#vehicle-switch').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b || !state.data) return;
      state.vehicle = b.dataset.v;
      store.set('fares-vehicle', state.vehicle);
      renderAll();
    });

    $('#chips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      state.section = state.section === b.dataset.s ? 'all' : b.dataset.s;
      renderChips();
      renderZones();
      writeUrl();
      const active = $(`.chip[data-s="${CSS.escape(state.section)}"]`);
      active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      if (window.scrollY > $('#zones').offsetTop) $('#zones').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    $('#zones').addEventListener('click', (e) => {
      const t = e.target.closest('.zone-toggle');
      if (t) {
        if (forcedOpen(groups())) return; // results view stays expanded
        const z = t.closest('.zone');
        const open = z.dataset.open !== 'true';
        setZone(z, open);
        renderToggleAll();
        if (open) {
          setTimeout(() => {
            const top = z.getBoundingClientRect().top;
            const ctrl = $('#controls').offsetHeight;
            if (top < ctrl || top > innerHeight * 0.55) z.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }, 80);
        }
        return;
      }
      const row = e.target.closest('.fare-row');
      if (row) return openSheet(row.dataset.rid);
      if (e.target.closest('#clear-all')) {
        state.q = ''; state.section = 'all'; q.value = ''; clear.hidden = true;
        renderAll();
        q.focus();
      }
    });

    $('#terms').addEventListener('click', (e) => {
      if (e.target.closest('.zone-toggle')) setZone($('#terms'), $('#terms').dataset.open !== 'true');
    });

    $('#toggle-all').addEventListener('click', () => {
      const open = $('#toggle-all').dataset.action === 'open';
      $$('#zones .zone').forEach((z) => setZone(z, open));
      renderToggleAll();
    });

    // print & export menu
    const btn = $('#export-btn');
    const menu = $('#export-menu');
    const visibleItems = () => [...menu.querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none');
    const closeMenu = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) visibleItems()[0]?.focus();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
    menu.addEventListener('keydown', (e) => {
      const items = visibleItems();
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { closeMenu(); btn.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (!b || !state.data) return;
      closeMenu();
      const kind = b.dataset.export;
      if (kind === 'xlsx') exportXlsx();
      if (kind === 'csv') exportCsv();
      if (kind === 'print') printNow();
      if (kind === 'pdf') { toast('اختر «حفظ بتنسيق PDF» من نافذة الطباعة'); setTimeout(printNow, 400); }
    });
    $('#print-btn').addEventListener('click', () => state.data && printNow());
    window.addEventListener('beforeprint', updatePrintMeta);

    $('#zoom-btn').addEventListener('click', cycleZoom);

    // sticky shadow, controls height (for scroll offsets) and back-to-top
    const controls = $('#controls');
    const sentinel = document.createElement('div');
    controls.before(sentinel);
    new IntersectionObserver(([en]) => controls.classList.toggle('stuck', !en.isIntersecting)).observe(sentinel);
    new ResizeObserver(() => document.documentElement.style.setProperty('--controls-h', `${controls.offsetHeight}px`)).observe(controls);
    const top = $('#to-top');
    top.innerHTML = icon('arrowUp');
    top.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { top.hidden = window.scrollY < 700; ticking = false; });
    }, { passive: true });

    bindSheet();

    // Live preview from the admin Appearance editor (same origin only).
    if (PREVIEW) {
      window.addEventListener('message', (e) => {
        if (e.origin !== location.origin || !e.data || e.data.type !== 'fares:theme') return;
        const before = FaresTheme.current.sections;
        FaresTheme.apply(e.data.theme, { mode: e.data.mode, ignoreUser: true, userZoom: false });
        if (!state.data) return;
        if (before !== FaresTheme.current.sections) defaultOpen(groups());
        renderHeader();
        renderTerms();
        renderAll();
      });
      window.parent.postMessage({ type: 'fares:ready' }, location.origin);
    }
  }

  function paintStatic() {
    $('#search-icon').innerHTML = icon('search');
    $('#search-clear').innerHTML = icon('x');
    $('#print-btn').innerHTML = `${icon('print')}<span>طباعة</span>`;
    $('#export-btn').innerHTML = `${icon('download')}<span>تصدير</span>`;
    $('#export-btn').setAttribute('aria-label', 'طباعة وتصدير');
    const items = {
      print: ['print', 'طباعة', 'القائمة المعروضة حالياً'],
      xlsx: ['sheet', 'ملف Excel', 'xlsx — قابل للتعديل'],
      csv: ['file', 'ملف CSV', 'للأنظمة والجداول'],
      pdf: ['download', 'ملف PDF', 'عبر نافذة الطباعة'],
    };
    $$('[data-export]').forEach((b) => {
      const [ic, t, sub] = items[b.dataset.export];
      b.innerHTML = `${icon(ic)}<span>${t}<small>${sub}</small></span>`;
    });
    $('#admin-link').innerHTML = `${icon('lock')}<span>دخول الإدارة</span>`;
    bindThemeButton($('#theme-btn'));
    paintZoom();
  }

  async function init() {
    paintStatic();
    readUrl();
    bindEvents();
    try {
      state.data = await api('/api/prices');
    } catch (err) {
      $('#zones').innerHTML = `<div class="empty">${icon('alert')}<strong>تعذّر تحميل الأسعار</strong><span>${esc(err.message)}</span><button class="btn" type="button" id="retry-btn">إعادة المحاولة</button></div>`;
      $('#retry-btn').addEventListener('click', () => location.reload());
      return;
    }
    if (!PREVIEW) {
      FaresTheme.apply(state.data.theme, { userZoom: true });
      FaresTheme.cache(state.data.theme);
    }
    $('#theme-btn').repaint?.();
    renderHeader();
    renderTerms();
    renderVehicleSwitch();
    defaultOpen(groups());
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
