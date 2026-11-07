/* global Fares, XLSX */
(() => {
  const { normalize, escapeHtml, highlight, fmt, formatDate, formatDateTime, api, icon, toast, bindThemeButton, download, debounce } = Fares;
  const $ = (s) => document.querySelector(s);

  const state = {
    data: null,
    q: '',
    vehicle: 'all',
    section: 'all',
  };

  // ---------- URL state (shareable filtered views) ----------
  function readUrl() {
    const p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.vehicle = p.get('v') || 'all';
    state.section = p.get('s') || 'all';
  }
  function writeUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.vehicle !== 'all') p.set('v', state.vehicle);
    if (state.section !== 'all') p.set('s', state.section);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  // ---------- derived data ----------
  const visibleVehicles = () => {
    const all = state.data.vehicles;
    return state.vehicle === 'all' ? all : all.filter((v) => v.id === state.vehicle);
  };

  function matches(route, section) {
    if (!state.q) return true;
    const hay = normalize(`${route.name} ${section.name}`);
    return normalize(state.q).split(' ').every((t) => hay.includes(t));
  }

  function filtered() {
    const { sections, routes } = state.data;
    const out = [];
    for (const sec of sections) {
      if (state.section !== 'all' && sec.id !== state.section) continue;
      const rows = routes.filter((r) => r.sectionId === sec.id && matches(r, sec));
      if (rows.length) out.push({ section: sec, rows });
    }
    return out;
  }

  function zoneIcon(name) {
    const n = normalize(name);
    if (n.includes('مطار')) return 'plane';
    if (n.includes('يومي')) return 'clock';
    return 'pin';
  }

  const places = (name) => name.split(' - ').map((p) => p.trim()).filter(Boolean);

  // ---------- header ----------
  function renderHeader() {
    const { settings, routes, sections, vehicles, updatedAt } = state.data;
    document.title = `${settings.title} — ${settings.brand}`;
    $('#brand-name').textContent = settings.brand;
    $('#brand-mark').textContent = (settings.brand.trim()[0] || 'ل');
    $('#page-title').textContent = settings.title;
    $('#page-subtitle').textContent = settings.subtitle || '';
    $('#effective-date').textContent = formatDate(settings.effectiveDate) || '—';
    $('#updated-at').textContent = updatedAt ? `آخر تحديث ${formatDateTime(updatedAt)}` : '';
    $('#footer-brand').textContent = settings.brand;
    $('#facts').innerHTML = [
      [routes.length, 'وجهة'],
      [sections.length, 'منطقة'],
      [vehicles.length, vehicles.length > 2 ? 'فئات سيارات' : 'فئة سيارات'],
    ].map(([n, l]) => `<div><dt>${l}</dt><dd class="num">${n}</dd></div>`).join('')
      + (settings.phone ? `<div><dt>للحجز والاستفسار</dt><dd class="num" dir="ltr">${escapeHtml(settings.phone)}</dd></div>` : '');
    $('#print-brand').textContent = settings.brand;
    $('#print-title').textContent = settings.title;
  }

  function renderVehicleSwitch() {
    const opts = [{ id: 'all', name: 'كل الفئات' }, ...state.data.vehicles];
    if (!opts.some((o) => o.id === state.vehicle)) state.vehicle = 'all';
    $('#vehicle-switch').innerHTML = opts
      .map((o) => `<button type="button" data-v="${escapeHtml(o.id)}" aria-pressed="${o.id === state.vehicle}">${escapeHtml(o.name)}</button>`)
      .join('');
  }

  function renderChips() {
    const { sections, routes } = state.data;
    if (state.section !== 'all' && !sections.some((s) => s.id === state.section)) state.section = 'all';
    const count = (sec) => routes.filter((r) => r.sectionId === sec.id && matches(r, sec)).length;
    const total = sections.reduce((n, s) => n + count(s), 0);
    const chip = (id, name, n) =>
      `<button type="button" class="chip${n ? '' : ' is-empty'}" data-s="${escapeHtml(id)}" aria-pressed="${state.section === id}">
        ${escapeHtml(name)}<span class="chip-count num">${n}</span></button>`;
    $('#chips').innerHTML = chip('all', 'كل المناطق', total) + sections.map((s) => chip(s.id, s.name, count(s))).join('');
  }

  // ---------- zones ----------
  function priceCell(value, label, extraClass = '') {
    const cur = state.data.settings.currency;
    if (value === null || value === undefined) {
      return `<td class="price na ${extraClass}" data-label="${escapeHtml(label)}"><span aria-hidden="true">—</span><span class="sr-only">غير متاح</span></td>`;
    }
    return `<td class="price num ${extraClass}" data-label="${escapeHtml(label)}">${fmt(value)}<span class="cur"> ${escapeHtml(cur)}</span></td>`;
  }

  function vehicleIcon(v, i) {
    return icon(normalize(v.name).includes('فان') || i > 0 ? 'van' : 'car');
  }

  function renderZones() {
    const { fareTypes } = state.data;
    const vehicles = visibleVehicles();
    const groups = filtered();
    const host = $('#zones');
    const nFares = fareTypes.length;

    const totalRows = groups.reduce((n, g) => n + g.rows.length, 0);
    const line = $('#result-line');
    if (state.q) {
      line.innerHTML = totalRows
        ? `<strong class="num">${totalRows}</strong> نتيجة لـ «${escapeHtml(state.q)}» في <strong class="num">${groups.length}</strong> منطقة`
        : '';
    } else {
      line.innerHTML = `عرض <strong class="num">${totalRows}</strong> وجهة · الأسعار بـ${escapeHtml(state.data.settings.currency)}`;
    }

    if (!groups.length) {
      host.innerHTML = `
        <div class="empty">
          ${icon('search')}
          <strong>لا توجد نتائج مطابقة</strong>
          <span>جرّب كلمة أقصر أو اسماً آخر للمنطقة، أو امسح البحث لعرض كل الأسعار.</span>
          <button class="btn" type="button" id="clear-search">مسح البحث والتصفية</button>
        </div>`;
      return;
    }

    const allIndex = new Map(state.data.sections.map((s, i) => [s.id, i + 1]));

    host.innerHTML = groups.map(({ section, rows }, gi) => {
      const cols = `<col class="c-dest">${vehicles.map(() => fareTypes.map(() => '<col class="c-price">').join('')).join('')}<col class="c-act">`;
      const multi = vehicles.length > 1;
      const head = `
        <thead>
          ${multi ? `<tr class="vehicle-row"><th></th>${vehicles.map((v, i) => `<th colspan="${nFares}" class="v-start"><span class="vehicle-tag">${vehicleIcon(v, state.data.vehicles.indexOf(v))}${escapeHtml(v.name)}</span></th>`).join('')}<th></th></tr>` : ''}
          <tr>
            <th class="th-dest" scope="col">${multi ? 'الوجهة' : `الوجهة · ${escapeHtml(vehicles[0].name)}`}</th>
            ${vehicles.map(() => fareTypes.map((f, fi) => `<th scope="col" class="${fi === 0 ? 'v-start' : ''}">${escapeHtml(f.name)}</th>`).join('')).join('')}
            <th><span class="sr-only">نسخ</span></th>
          </tr>
        </thead>`;

      const body = rows.map((r) => {
        const dest = `<span class="place-wrap">${places(r.name).map((p) => `<span class="place">${highlight(p, state.q)}</span>`).join(' ')}</span>`;
        const cells = vehicles.map((v) => {
          const pr = r.prices[v.id] || {};
          const vl = `<td class="vlabel">${vehicleIcon(v, state.data.vehicles.indexOf(v))}${escapeHtml(v.name)}</td>`;
          if (r.kind === 'flat') {
            const val = pr[fareTypes[0].id];
            const inner = val == null ? '<span aria-hidden="true">—</span><span class="sr-only">غير متاح</span>'
              : `<span class="flat-label">سعر ثابت</span><span class="flat-amount num">${fmt(val)}</span>`;
            return `${vl}<td class="price flat v-start ${val == null ? 'na' : ''}" colspan="${nFares}">${inner}</td>`;
          }
          return vl + fareTypes.map((f, fi) => priceCell(pr[f.id], f.name, fi === 0 ? 'v-start' : '')).join('');
        }).join('');
        return `<tr id="r-${escapeHtml(r.id)}">
          <td class="dest">${dest}${r.kind === 'flat' ? '<span class="flat-badge">باقة</span>' : ''}</td>
          ${cells}
          <td class="act"><button class="icon-btn copy-btn" type="button" data-copy="${escapeHtml(r.id)}" aria-label="نسخ سعر ${escapeHtml(r.name)}" title="نسخ السعر">${icon('copy')}</button></td>
        </tr>`;
      }).join('');

      const num = String(allIndex.get(section.id)).padStart(2, '0');
      return `
        <section class="zone" aria-labelledby="z-${escapeHtml(section.id)}" data-delay="${Math.min(gi, 6) * 40}">
          <header class="zone-head">
            <span class="zone-index num" aria-hidden="true">${num}</span>
            <span class="zone-icon" aria-hidden="true">${icon(zoneIcon(section.name))}</span>
            <div class="zone-title">
              <h2 id="z-${escapeHtml(section.id)}">${highlight(section.name, state.q)}</h2>
              ${section.note ? `<span class="zone-note">${escapeHtml(section.note)}</span>` : ''}
            </div>
            <span class="zone-count"><span class="num">${rows.length}</span> ${rows.length > 10 || rows.length < 3 ? 'وجهة' : 'وجهات'}</span>
          </header>
          <div class="table-scroll">
            <table class="fare-table">
              <caption class="sr-only">أسعار ${escapeHtml(section.name)}</caption>
              <colgroup>${cols}</colgroup>
              ${head}
              <tbody>${body}</tbody>
            </table>
          </div>
        </section>`;
    }).join('');
    // Inline style attributes are blocked by the CSP, so apply dynamic styles via CSSOM.
    host.querySelectorAll('.zone').forEach((z) => { z.style.animationDelay = `${z.dataset.delay}ms`; });
    host.querySelectorAll('.fare-table').forEach((t) => t.style.setProperty('--fares', nFares));
  }

  function renderTerms() {
    const { notes } = state.data;
    $('#terms').hidden = !notes.length;
    $('#terms-list').innerHTML = notes.map((n) => `<li>${escapeHtml(n.text)}</li>`).join('');
  }

  function renderAll() {
    renderVehicleSwitch();
    renderChips();
    renderZones();
    writeUrl();
    updatePrintMeta();
  }

  // ---------- copy quote ----------
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
    return lines.join('\n');
  }

  async function copyRoute(id) {
    const route = state.data.routes.find((r) => r.id === id);
    if (!route) return;
    const text = quoteText(route);
    try {
      await navigator.clipboard.writeText(text);
      toast('تم نسخ السعر — جاهز للصقه في رسالة');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      toast(ok ? 'تم نسخ السعر' : 'تعذّر النسخ', ok ? 'ok' : 'error');
    }
  }

  // ---------- export ----------
  function exportRows() {
    const { fareTypes, settings } = state.data;
    const vehicles = visibleVehicles();
    const header1 = ['المنطقة', 'الوجهة', 'النوع'];
    const header2 = ['', '', ''];
    for (const v of vehicles) fareTypes.forEach((f, i) => { header1.push(i === 0 ? v.name : ''); header2.push(f.name); });
    const rows = [];
    for (const { section, rows: rs } of filtered()) {
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
    return { header1, header2, rows, settings };
  }

  function fileBase() {
    const s = state.data.settings;
    return `${s.title} ${s.effectiveDate || ''}`.trim().replace(/[\\/:*?"<>|]/g, '-');
  }

  function exportCsv() {
    const { header1, header2, rows } = exportRows();
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const merged = header1.map((h, i) => (i < 3 ? h : `${header1.slice(0, i + 1).reverse().find((x, k) => x && (i - k) >= 3) || ''} - ${header2[i]}`));
    const csv = [merged, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
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
    const nFares = state.data.fareTypes.length;
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: header1.length - 1 } }];
    for (let c = 3; c < header1.length; c += nFares) merges.push({ s: { r: 2, c }, e: { r: 2, c: c + nFares - 1 } });
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

  function printNow() {
    updatePrintMeta();
    window.print();
  }

  // Kept current on every render so Ctrl+P prints the same header as the button.
  function updatePrintMeta() {
    if (!state.data) return;
    const s = state.data.settings;
    const scope = [];
    if (state.section !== 'all') scope.push(state.data.sections.find((x) => x.id === state.section)?.name);
    if (state.vehicle !== 'all') scope.push(state.data.vehicles.find((x) => x.id === state.vehicle)?.name);
    if (state.q) scope.push(`بحث: ${state.q}`);
    $('#print-meta').innerHTML = [
      s.effectiveDate ? `سارية من ${escapeHtml(formatDate(s.effectiveDate))}` : '',
      scope.length ? escapeHtml(scope.filter(Boolean).join(' · ')) : '',
      `طُبعت في ${escapeHtml(formatDateTime(new Date().toISOString()))}`,
    ].filter(Boolean).join('<br>');
  }

  // ---------- events ----------
  function bindEvents() {
    const q = $('#q');
    q.value = state.q;
    const onSearch = debounce(() => {
      state.q = q.value.trim();
      renderChips();
      renderZones();
      writeUrl();
      updatePrintMeta();
    }, 120);
    q.addEventListener('input', onSearch);
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && q.value) { q.value = ''; onSearch(); }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== q && !/input|textarea|select/i.test(document.activeElement.tagName)) {
        e.preventDefault();
        q.focus();
      }
    });

    $('#vehicle-switch').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (!b) return;
      state.vehicle = b.dataset.v;
      renderAll();
    });

    $('#chips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip');
      if (!b) return;
      state.section = state.section === b.dataset.s ? 'all' : b.dataset.s;
      renderChips();
      renderZones();
      writeUrl();
    });

    $('#zones').addEventListener('click', (e) => {
      const c = e.target.closest('[data-copy]');
      if (c) return copyRoute(c.dataset.copy);
      if (e.target.closest('#clear-search')) {
        state.q = ''; state.section = 'all'; q.value = '';
        renderAll();
        q.focus();
      }
    });

    // export menu
    const btn = $('#export-btn');
    const menu = $('#export-menu');
    const closeMenu = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) menu.querySelector('button').focus();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { closeMenu(); btn.focus(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-export]');
      if (!b) return;
      closeMenu();
      if (b.dataset.export === 'xlsx') exportXlsx();
      if (b.dataset.export === 'csv') exportCsv();
      if (b.dataset.export === 'pdf') { toast('اختر «حفظ بتنسيق PDF» من نافذة الطباعة'); setTimeout(printNow, 400); }
    });

    $('#print-btn').addEventListener('click', printNow);
    window.addEventListener('beforeprint', updatePrintMeta);

    // sticky toolbar shadow
    const toolbar = $('#toolbar');
    const sentinel = document.createElement('div');
    toolbar.before(sentinel);
    new IntersectionObserver(([en]) => toolbar.classList.toggle('stuck', !en.isIntersecting)).observe(sentinel);
  }

  function paintStatic() {
    $('#search-icon').innerHTML = icon('search');
    $('#print-btn').innerHTML = `${icon('print')}<span>طباعة</span>`;
    $('#print-btn').setAttribute('aria-label', 'طباعة');
    $('#export-btn').innerHTML = `${icon('download')}<span>تصدير</span>`;
    $('#export-btn').setAttribute('aria-label', 'تصدير');
    const items = {
      xlsx: ['sheet', 'ملف Excel', 'xlsx — قابل للتعديل'],
      csv: ['file', 'ملف CSV', 'للأنظمة والجداول'],
      pdf: ['print', 'ملف PDF', 'عبر نافذة الطباعة'],
    };
    document.querySelectorAll('[data-export]').forEach((b) => {
      const [ic, t, sub] = items[b.dataset.export];
      b.innerHTML = `${icon(ic)}<span>${t}<small>${sub}</small></span>`;
    });
    $('#admin-link').innerHTML = `${icon('lock')}<span>دخول الإدارة</span>`;
    bindThemeButton($('#theme-btn'));
  }

  async function init() {
    paintStatic();
    readUrl();
    try {
      state.data = await api('/api/prices');
    } catch (err) {
      $('#zones').innerHTML = `<div class="empty">${icon('alert')}<strong>تعذّر تحميل الأسعار</strong><span>${escapeHtml(err.message)}</span><button class="btn" type="button" id="retry-btn">إعادة المحاولة</button></div>`;
      $('#retry-btn').addEventListener('click', () => location.reload());
      return;
    }
    renderHeader();
    renderTerms();
    bindEvents();
    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
