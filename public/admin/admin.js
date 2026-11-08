/* global Fares, FaresTheme */
(() => {
  const { escapeHtml: esc, fmt, formatDate, formatDateTime, api, icon, toast, bindThemeButton, confirmDialog, download, normalize, debounce } = Fares;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  const DOC_KEYS = ['settings', 'theme', 'vehicles', 'fareTypes', 'sections', 'routes', 'notes'];
  const REQUIRED_KEYS = ['settings', 'vehicles', 'fareTypes', 'sections', 'routes', 'notes'];
  const DRAFT_KEY = 'fares-admin-draft';

  const S = {
    user: null,
    server: null, // last published document
    draft: null, // working copy
    view: 'overview',
    filter: { q: '', section: 'all' },
  };

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const docOf = (d) => Object.fromEntries(DOC_KEYS.map((k) => [k, d[k] ?? null]));
  const uid = (p) => `${p}_${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

  function parsePrice(raw) {
    const s = String(raw).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[,\s٬]/g, '');
    if (!s) return { ok: true, value: null };
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false };
    const n = Math.round(Number(s));
    return { ok: n <= 10000000, value: n === 0 ? null : n };
  }

  // ======================================================================
  // Diff between published and draft — drives the status bar and review.
  // ======================================================================
  function diff(a, b) {
    const out = [];
    const vName = (id) => (b.vehicles.find((v) => v.id === id) || a.vehicles.find((v) => v.id === id) || {}).name || id;
    const fName = (id) => (b.fareTypes.find((f) => f.id === id) || {}).name || id;
    const secName = (doc, id) => (doc.sections.find((s) => s.id === id) || {}).name || '';

    const aRoutes = new Map(a.routes.map((r) => [r.id, r]));
    const bIds = new Set(b.routes.map((r) => r.id));
    for (const r of b.routes) {
      const o = aRoutes.get(r.id);
      if (!o) { out.push({ kind: 'add', text: r.name || 'خط جديد', ctx: secName(b, r.sectionId) }); continue; }
      if (o.name !== r.name) out.push({ kind: 'mod', text: 'اسم الخط', from: o.name, to: r.name });
      if (o.sectionId !== r.sectionId) out.push({ kind: 'mod', text: r.name, ctx: 'نقل منطقة', from: secName(a, o.sectionId), to: secName(b, r.sectionId) });
      if (o.kind !== r.kind) out.push({ kind: 'mod', text: r.name, ctx: 'نوع التسعير', from: o.kind === 'flat' ? 'سعر ثابت' : 'توصيل', to: r.kind === 'flat' ? 'سعر ثابت' : 'توصيل' });
      for (const v of b.vehicles) {
        for (const f of b.fareTypes) {
          const x = o.prices?.[v.id]?.[f.id] ?? null;
          const y = r.prices?.[v.id]?.[f.id] ?? null;
          if (x !== y) out.push({ kind: 'mod', text: r.name, ctx: `${vName(v.id)} · ${r.kind === 'flat' ? 'سعر ثابت' : fName(f.id)}`, from: x == null ? '—' : fmt(x), to: y == null ? '—' : fmt(y) });
        }
      }
    }
    for (const r of a.routes) if (!bIds.has(r.id)) out.push({ kind: 'del', text: r.name, ctx: secName(a, r.sectionId) });

    const aSec = new Map(a.sections.map((s) => [s.id, s]));
    const bSecIds = new Set(b.sections.map((s) => s.id));
    for (const s of b.sections) {
      const o = aSec.get(s.id);
      if (!o) out.push({ kind: 'add', text: s.name, ctx: 'منطقة جديدة' });
      else {
        if (o.name !== s.name) out.push({ kind: 'mod', text: 'اسم منطقة', from: o.name, to: s.name });
        if (o.note !== s.note) out.push({ kind: 'mod', text: s.name, ctx: 'ملاحظة المنطقة', from: o.note || '—', to: s.note || '—' });
      }
    }
    for (const s of a.sections) if (!bSecIds.has(s.id)) out.push({ kind: 'del', text: s.name, ctx: 'منطقة' });

    const order = (doc) => doc.sections.map((s) => s.id).join() + '|' + doc.routes.map((r) => r.id).join();
    if (order(a) !== order(b) && !out.some((c) => c.kind !== 'mod')) {
      const sameSet = a.routes.length === b.routes.length && a.sections.length === b.sections.length;
      if (sameSet) out.push({ kind: 'mod', text: 'ترتيب المناطق أو الخطوط' });
    }

    const labels = { brand: 'اسم الشركة', title: 'عنوان القائمة', subtitle: 'الوصف', effectiveDate: 'تاريخ السريان', currency: 'العملة', phone: 'رقم التواصل' };
    for (const k of Object.keys(labels)) {
      if ((a.settings[k] || '') !== (b.settings[k] || '')) out.push({ kind: 'mod', text: labels[k], ctx: 'الإعدادات', from: a.settings[k] || '—', to: b.settings[k] || '—' });
    }

    const aV = new Map(a.vehicles.map((v) => [v.id, v]));
    for (const v of b.vehicles) {
      const o = aV.get(v.id);
      if (!o) out.push({ kind: 'add', text: v.name, ctx: 'فئة سيارة' });
      else if (o.name !== v.name) out.push({ kind: 'mod', text: 'اسم فئة', from: o.name, to: v.name });
    }
    for (const v of a.vehicles) if (!b.vehicles.some((x) => x.id === v.id)) out.push({ kind: 'del', text: v.name, ctx: 'فئة سيارة' });
    a.fareTypes.forEach((f, i) => { const n = b.fareTypes[i]; if (n && n.name !== f.name) out.push({ kind: 'mod', text: 'اسم تعريفة', from: f.name, to: n.name }); });

    const ta = FaresTheme.normalize(a.theme);
    const tb = FaresTheme.normalize(b.theme);
    if (JSON.stringify(ta) !== JSON.stringify(tb)) {
      const what = [];
      if (ta.preset !== tb.preset) what.push(`القالب: ${(FaresTheme.PRESETS.find((p) => p.id === tb.preset) || { name: 'مخصص' }).name}`);
      if (JSON.stringify([ta.light, ta.dark]) !== JSON.stringify([tb.light, tb.dark])) what.push('الألوان');
      if (ta.fontText !== tb.fontText || ta.fontDisplay !== tb.fontDisplay || ta.fontNumbers !== tb.fontNumbers || ta.numerals !== tb.numerals) what.push('الخطوط');
      if (ta.scale !== tb.scale || ta.radius !== tb.radius || ta.header !== tb.header || ta.sections !== tb.sections || ta.mode !== tb.mode) what.push('طريقة العرض');
      out.push({ kind: 'mod', text: 'المظهر', ctx: what.join('، ') });
    }

    const aN = a.notes.map((n) => n.text).join('\n');
    const bN = b.notes.map((n) => n.text).join('\n');
    if (aN !== bN) {
      const added = b.notes.filter((n) => !a.notes.some((m) => m.id === n.id)).length;
      const removed = a.notes.filter((n) => !b.notes.some((m) => m.id === n.id)).length;
      const parts = [];
      if (added) parts.push(`إضافة ${added}`);
      if (removed) parts.push(`حذف ${removed}`);
      out.push({ kind: 'mod', text: 'الشروط والإضافات', ctx: parts.join('، ') || 'تعديل النص أو الترتيب' });
    }
    return out;
  }

  let changeCache = [];
  function refreshStatus() {
    changeCache = diff(docOf(S.server), docOf(S.draft));
    const n = changeCache.length;
    const bar = $('#publish-bar');
    bar.dataset.state = n ? 'dirty' : 'clean';
    $('#publish-status').textContent = n ? `${n} ${n === 1 ? 'تغيير غير منشور' : n === 2 ? 'تغييران غير منشورين' : n <= 10 ? 'تغييرات غير منشورة' : 'تغييراً غير منشور'}` : 'كل التغييرات منشورة';
    try {
      if (n) localStorage.setItem(DRAFT_KEY, JSON.stringify({ base: S.server.version, user: S.user, doc: docOf(S.draft) }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* storage unavailable */ }
  }
  const refreshStatusSoon = debounce(refreshStatus, 150);

  // ======================================================================
  // Publish / discard
  // ======================================================================
  function changeItem(c) {
    const cls = { add: 'add', del: 'del', mod: 'mod' }[c.kind];
    const label = { add: 'إضافة', del: 'حذف', mod: 'تعديل' }[c.kind];
    const body = c.from !== undefined
      ? `<span>${esc(c.text)}${c.ctx ? ` <span class="ctx">· ${esc(c.ctx)}</span>` : ''}</span><br><span class="old num">${esc(c.from)}</span> ← <span class="new num">${esc(c.to)}</span>`
      : `<span>${esc(c.text)}</span>${c.ctx ? ` <span class="ctx">· ${esc(c.ctx)}</span>` : ''}`;
    return `<li><span class="kind ${cls}">${label}</span><div>${body}</div></li>`;
  }

  function reviewDialog() {
    return new Promise((resolve) => {
      const list = changeCache;
      const dlg = document.createElement('dialog');
      dlg.className = 'modal wide';
      dlg.innerHTML = `
        <form method="dialog">
          <div class="modal-body">
            <h2>مراجعة قبل النشر</h2>
            <p>ستظهر هذه التغييرات فوراً في صفحة الأسعار العامة. تُحفظ نسخة من القائمة الحالية تلقائياً ويمكنك استعادتها من السجل.</p>
            <ul class="change-list">${list.slice(0, 300).map(changeItem).join('')}</ul>
            ${list.length > 300 ? `<p class="hint">و${list.length - 300} تغييراً آخر…</p>` : ''}
          </div>
          <div class="modal-actions">
            <button class="btn btn-brass" value="ok">${icon('check')} نشر ${list.length} ${list.length > 10 ? 'تغييراً' : list.length > 2 ? 'تغييرات' : 'تغيير'}</button>
            <button class="btn btn-ghost" value="cancel">متابعة التعديل</button>
          </div>
        </form>`;
      document.body.appendChild(dlg);
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
      dlg.showModal();
    });
  }

  async function publish(force = false) {
    if (!changeCache.length) return;
    if (!force && !(await reviewDialog())) return;
    const btn = $('#publish-btn');
    btn.disabled = true;
    try {
      const res = await api('/api/admin/data', { method: 'PUT', body: { baseVersion: S.server.version, doc: docOf(S.draft), force } });
      S.server = res;
      S.draft = clone(res);
      refreshStatus();
      toast('تم النشر — الأسعار الجديدة ظاهرة الآن للجميع');
      render();
    } catch (err) {
      if (err.status === 409) {
        const ok = await confirmDialog({
          title: 'القائمة تغيّرت من جلسة أخرى',
          message: 'نشر شخص آخر تعديلات بعد أن فتحت القائمة. إن تابعت، ستحل تعديلاتك محل النسخة الأحدث بالكامل (تبقى نسخة منها في السجل).',
          confirmText: 'النشر على أي حال',
          danger: true,
        });
        if (ok) return publish(true);
      } else handleError(err);
    } finally {
      btn.disabled = false;
    }
  }

  async function discard() {
    const ok = await confirmDialog({ title: 'تجاهل كل التغييرات؟', message: `سيتم التراجع عن ${changeCache.length} تغيير والعودة إلى النسخة المنشورة.`, confirmText: 'تجاهل التغييرات', danger: true });
    if (!ok) return;
    S.draft = clone(S.server);
    refreshStatus();
    render();
    toast('تمت العودة إلى النسخة المنشورة');
  }

  function handleError(err) {
    if (err.status === 401) {
      toast('انتهت الجلسة — سجّل الدخول مجدداً. تعديلاتك محفوظة كمسودة على هذا الجهاز.', 'error');
      showLogin();
      return;
    }
    toast(err.message || 'حدث خطأ', 'error');
  }

  // ======================================================================
  // Views
  // ======================================================================
  const VIEWS = {
    overview: { title: 'نظرة عامة', sub: 'ملخص القائمة المنشورة وآخر النشاطات', icon: 'grid', render: renderOverview },
    prices: { title: 'الأسعار', sub: 'عدّل الأسعار مباشرة — التغييرات تبقى مسودة حتى تنشرها', icon: 'tag', render: renderPrices },
    zones: { title: 'المناطق', sub: 'أضف المناطق وأعد تسميتها ورتّب ظهورها', icon: 'map', render: renderZones },
    vehicles: { title: 'فئات السيارات والتعريفة', sub: 'أعمدة الأسعار في القائمة', icon: 'car', render: renderVehicles },
    terms: { title: 'الشروط والإضافات', sub: 'تظهر أسفل قائمة الأسعار وفي الطباعة والتصدير', icon: 'list', render: renderTerms },
    appearance: { title: 'المظهر', sub: 'القوالب والألوان والخطوط — مع معاينة مباشرة', icon: 'palette', render: renderAppearance },
    settings: { title: 'إعدادات القائمة', sub: 'اسم الشركة والعنوان وتاريخ السريان', icon: 'settings', render: renderSettings },
    sep: null,
    history: { title: 'سجل النسخ', sub: 'كل نشر يحفظ نسخة كاملة يمكن استعادتها', icon: 'history', render: renderHistory },
    account: { title: 'الحساب', sub: 'كلمة المرور وتسجيل الخروج', icon: 'user', render: renderAccount },
  };

  function renderNav() {
    $('#side-nav').innerHTML = Object.entries(VIEWS).map(([k, v]) => (v
      ? `<a href="#${k}" data-view="${k}" ${S.view === k ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.title}</span></a>`
      : '<div class="nav-sep" role="separator"></div>')).join('');
  }

  function render() {
    const v = VIEWS[S.view] || VIEWS.overview;
    $('#view-title').textContent = v.title;
    $('#view-sub').textContent = v.sub;
    document.title = `${v.title} — لوحة التحكم`;
    renderNav();
    v.render($('#view'));
  }

  function go(view) {
    if (!VIEWS[view]) view = 'overview';
    S.view = view;
    if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    render();
    $('#view').focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    closeSidebar();
  }

  // ---------------- overview ----------------
  async function renderOverview(root) {
    const d = S.server;
    const all = [];
    for (const r of d.routes) for (const v of d.vehicles) for (const f of d.fareTypes) {
      const x = r.prices?.[v.id]?.[f.id];
      if (x != null) all.push(x);
    }
    const min = all.length ? Math.min(...all) : 0;
    const max = all.length ? Math.max(...all) : 0;
    root.innerHTML = `
      <div class="stats">
        <div class="stat"><span>الوجهات</span><strong class="num">${d.routes.length}</strong><small>في ${d.sections.length} منطقة</small></div>
        <div class="stat"><span>إجمالي الأسعار</span><strong class="num">${all.length}</strong><small>${d.vehicles.map((v) => esc(v.name)).join(' و')}</small></div>
        <div class="stat"><span>نطاق الأسعار</span><strong class="num">${fmt(min)} – ${fmt(max)}</strong><small>${esc(d.settings.currency)}</small></div>
        <div class="stat"><span>سارية من</span><strong>${esc(formatDate(d.settings.effectiveDate) || '—')}</strong><small>النسخة رقم <span class="num">${d.version}</span></small></div>
      </div>

      <div class="quick">
        <a href="#prices">${icon('tag')}<strong>تعديل الأسعار</strong><span>جدول قابل للتعديل لكل المناطق</span></a>
        <button type="button" id="q-bulk">${icon('percent')}<strong>زيادة جماعية</strong><span>رفع أو خفض الأسعار بنسبة أو مبلغ</span></button>
        <a href="/" target="_blank" rel="noopener">${icon('eye')}<strong>عرض الصفحة العامة</strong><span>كما يراها المستخدمون</span></a>
      </div>

      <section class="panel">
        <div class="panel-head"><h2>آخر عمليات النشر</h2><a class="btn btn-sm btn-ghost" href="#history">السجل الكامل</a></div>
        <ul class="timeline" id="ov-history"><li><span></span><small>جارٍ التحميل…</small></li></ul>
      </section>`;
    $('#q-bulk').addEventListener('click', () => bulkDialog());
    try {
      const h = await api('/api/admin/history');
      const el = $('#ov-history');
      if (!el) return;
      el.innerHTML = h.slice(0, 5).map((x) => `
        <li><span class="dot"></span>
          <div><strong>${esc(x.summary)}</strong><small>${esc(x.by || '')} · ${esc(formatDateTime(x.savedAt))}</small></div>
          <span class="tag ${x.version === S.server.version ? 'live' : ''} num">${x.version === S.server.version ? 'المنشورة' : `v${x.version}`}</span>
        </li>`).join('') || '<li><span></span><small>لا يوجد سجل بعد</small></li>';
    } catch (err) { handleError(err); }
  }

  // ---------------- prices ----------------
  function routeMatches(r, sec) {
    if (S.filter.section !== 'all' && r.sectionId !== S.filter.section) return false;
    if (!S.filter.q) return true;
    const hay = normalize(`${r.name} ${sec ? sec.name : ''}`);
    return normalize(S.filter.q).split(' ').every((t) => hay.includes(t));
  }

  function renderPrices(root) {
    const d = S.draft;
    if (S.filter.section !== 'all' && !d.sections.some((s) => s.id === S.filter.section)) S.filter.section = 'all';
    root.innerHTML = `
      <div class="editor-tools">
        <div class="search-mini">${icon('search')}<label class="sr-only" for="pf-q">بحث</label>
          <input class="input" id="pf-q" type="search" placeholder="ابحث في الوجهات…" value="${esc(S.filter.q)}"></div>
        <label class="sr-only" for="pf-s">المنطقة</label>
        <select class="select" id="pf-s">
          <option value="all">كل المناطق</option>
          ${d.sections.map((s) => `<option value="${esc(s.id)}" ${S.filter.section === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <button class="btn" type="button" id="pf-bulk">${icon('percent')}<span>زيادة جماعية</span></button>
      </div>
      <div class="stack" id="zone-editors"></div>`;

    $('#pf-q').addEventListener('input', debounce((e) => { S.filter.q = e.target.value.trim(); renderZoneEditors(); }, 150));
    $('#pf-s').addEventListener('change', (e) => { S.filter.section = e.target.value; renderZoneEditors(); });
    $('#pf-bulk').addEventListener('click', () => bulkDialog());
    renderZoneEditors();
  }

  function renderZoneEditors(focusKey) {
    const d = S.draft;
    const host = $('#zone-editors');
    if (!host) return;
    const serverRoutes = new Map(S.server.routes.map((r) => [r.id, r]));
    const nF = d.fareTypes.length;

    const blocks = d.sections.map((sec) => {
      if (S.filter.section !== 'all' && sec.id !== S.filter.section) return '';
      const rows = d.routes.filter((r) => r.sectionId === sec.id && routeMatches(r, sec));
      if (S.filter.q && !rows.length) return '';
      const head = `
        <thead>
          <tr class="vrow"><th></th>${d.vehicles.map((v) => `<th colspan="${nF}" class="v-start">${esc(v.name)}</th>`).join('')}<th></th></tr>
          <tr><th class="th-name">الوجهة</th>${d.vehicles.map(() => d.fareTypes.map((f, i) => `<th class="${i === 0 ? 'v-start' : ''}">${esc(f.name)}</th>`).join('')).join('')}<th><span class="sr-only">إجراءات</span></th></tr>
        </thead>`;
      const body = rows.map((r) => {
        const o = serverRoutes.get(r.id);
        const nameChanged = o && o.name !== r.name;
        const cells = d.vehicles.map((v) => {
          if (r.kind === 'flat') {
            const val = r.prices?.[v.id]?.[d.fareTypes[0].id] ?? null;
            const was = o?.prices?.[v.id]?.[d.fareTypes[0].id] ?? null;
            return `<td class="flat-cell v-start" colspan="${nF}">${priceInput(r.id, v.id, d.fareTypes[0].id, val, o ? was : undefined)}<span class="flat-note">سعر ثابت</span></td>`;
          }
          return d.fareTypes.map((f, i) => {
            const val = r.prices?.[v.id]?.[f.id] ?? null;
            const was = o?.prices?.[v.id]?.[f.id] ?? null;
            return `<td class="${i === 0 ? 'v-start' : ''}">${priceInput(r.id, v.id, f.id, val, o ? was : undefined)}</td>`;
          }).join('');
        }).join('');
        return `
          <tr data-rid="${esc(r.id)}" class="${o ? '' : 'is-new'}">
            <td class="name-cell">
              <label class="sr-only" for="n-${esc(r.id)}">اسم الوجهة</label>
              <textarea class="cell-input name-input ${nameChanged ? 'changed' : ''}" id="n-${esc(r.id)}" rows="1" data-name="${esc(r.id)}" ${nameChanged ? `title="كان: ${esc(o.name)}"` : ''}>${esc(r.name)}</textarea>
              ${r.kind === 'flat' ? '<span class="kind-pill">باقة بسعر ثابت</span>' : ''}
            </td>
            ${cells}
            <td><div class="row-actions">
              <button class="icon-btn" type="button" data-act="up" aria-label="نقل لأعلى" title="نقل لأعلى">${icon('chevronUp')}</button>
              <button class="icon-btn" type="button" data-act="down" aria-label="نقل لأسفل" title="نقل لأسفل">${icon('chevronDown')}</button>
              <button class="icon-btn" type="button" data-act="more" aria-label="خيارات الخط" title="خيارات">${icon('edit')}</button>
            </div></td>
          </tr>`;
      }).join('');
      const total = d.routes.filter((r) => r.sectionId === sec.id).length;
      return `
        <section class="panel zone-editor" data-sid="${esc(sec.id)}">
          <div class="panel-head"><h2>${esc(sec.name)}</h2><span class="count"><span class="num">${S.filter.q ? `${rows.length} من ${total}` : total}</span> وجهة</span></div>
          ${rows.length ? `<div class="price-grid-wrap"><table class="price-grid">${head}<tbody>${body}</tbody></table></div>` : '<p class="empty-note">لا توجد وجهات في هذه المنطقة بعد.</p>'}
          <div class="add-row">
            <button class="btn btn-sm" type="button" data-add="route">${icon('plus')} إضافة وجهة</button>
            <button class="btn btn-sm btn-ghost" type="button" data-add="flat">${icon('plus')} إضافة باقة بسعر ثابت</button>
          </div>
        </section>`;
    }).join('');

    host.innerHTML = blocks || `<div class="panel empty-note">لا توجد نتائج لـ «${esc(S.filter.q)}».</div>`;
    $$('.name-input', host).forEach(autosize);
    if (focusKey) {
      const el = host.querySelector(focusKey);
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    }
  }

  function priceInput(rid, vid, fid, val, was) {
    const changed = was !== undefined && was !== val;
    const title = changed ? `كان: ${was == null ? 'غير متاح' : fmt(was)}` : '';
    return `<input class="cell-input price-input ${changed ? 'changed' : ''}" inputmode="numeric" autocomplete="off"
      data-rid="${esc(rid)}" data-v="${esc(vid)}" data-f="${esc(fid)}" value="${val == null ? '' : val}" placeholder="—"
      aria-label="سعر" ${title ? `title="${esc(title)}"` : ''}>`;
  }

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }

  function findRoute(id) { return S.draft.routes.find((r) => r.id === id); }

  function bindPriceEditor() {
    const view = $('#view');

    view.addEventListener('input', (e) => {
      if (S.view !== 'prices') return;
      const t = e.target;
      if (t.matches('.price-input')) {
        const r = findRoute(t.dataset.rid);
        if (!r) return;
        const p = parsePrice(t.value);
        t.classList.toggle('invalid', !p.ok);
        if (!p.ok) return;
        r.prices[t.dataset.v] = r.prices[t.dataset.v] || {};
        r.prices[t.dataset.v][t.dataset.f] = p.value;
        const o = S.server.routes.find((x) => x.id === r.id);
        if (o) {
          const was = o.prices?.[t.dataset.v]?.[t.dataset.f] ?? null;
          t.classList.toggle('changed', was !== p.value);
          t.title = was !== p.value ? `كان: ${was == null ? 'غير متاح' : fmt(was)}` : '';
        }
        refreshStatusSoon();
      } else if (t.matches('.name-input')) {
        const r = findRoute(t.dataset.name);
        if (!r) return;
        r.name = t.value.replace(/\s*\n\s*/g, ' ');
        autosize(t);
        const o = S.server.routes.find((x) => x.id === r.id);
        if (o) t.classList.toggle('changed', o.name !== r.name);
        refreshStatusSoon();
      }
    });

    view.addEventListener('keydown', (e) => {
      if (S.view !== 'prices') return;
      const t = e.target;
      if (t.matches('.name-input') && e.key === 'Enter') { e.preventDefault(); return; }
      if (!t.matches('.price-input')) return;
      if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const inputs = $$(`.price-input[data-v="${t.dataset.v}"][data-f="${t.dataset.f}"]`, $('#zone-editors'));
      const i = inputs.indexOf(t);
      const next = inputs[e.key === 'ArrowUp' ? i - 1 : i + 1];
      if (next) { next.focus(); next.select(); }
    });

    view.addEventListener('focusin', (e) => {
      if (e.target.matches && e.target.matches('.price-input')) e.target.select();
    });

    view.addEventListener('click', (e) => {
      if (S.view !== 'prices') return;
      const add = e.target.closest('[data-add]');
      if (add) {
        const sid = add.closest('[data-sid]').dataset.sid;
        const r = newRoute(sid, add.dataset.add === 'flat' ? 'flat' : 'route');
        // insert after the last route of this section
        let idx = -1;
        S.draft.routes.forEach((x, i) => { if (x.sectionId === sid) idx = i; });
        S.draft.routes.splice(idx + 1, 0, r);
        S.filter.q = '';
        const q = $('#pf-q'); if (q) q.value = '';
        renderZoneEditors(`#n-${r.id}`);
        refreshStatus();
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act) return;
      const rid = act.closest('[data-rid]').dataset.rid;
      if (act.dataset.act === 'more') return routeDialog(rid);
      moveRoute(rid, act.dataset.act === 'up' ? -1 : 1);
    });
  }

  function newRoute(sectionId, kind) {
    const prices = {};
    S.draft.vehicles.forEach((v) => { prices[v.id] = Object.fromEntries(S.draft.fareTypes.map((f) => [f.id, null])); });
    return { id: uid('r'), sectionId, name: '', kind, prices };
  }

  function moveRoute(rid, dir) {
    const list = S.draft.routes;
    const i = list.findIndex((r) => r.id === rid);
    const sid = list[i].sectionId;
    let j = i + dir;
    while (j >= 0 && j < list.length && list[j].sectionId !== sid) j += dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    renderZoneEditors(`tr[data-rid="${rid}"] [data-act="${dir < 0 ? 'up' : 'down'}"]`);
    refreshStatus();
  }

  function routeDialog(rid) {
    const r = findRoute(rid);
    if (!r) return;
    const d = S.draft;
    const dlg = document.createElement('dialog');
    dlg.className = 'modal row-dialog';
    dlg.innerHTML = `
      <form method="dialog">
        <div class="modal-body">
          <h2>خيارات الوجهة</h2>
          <div class="field"><label for="rd-name">اسم الوجهة</label>
            <textarea class="textarea" id="rd-name" rows="2">${esc(r.name)}</textarea>
            <span class="hint">افصل بين المناطق بشرطة « - » لتظهر كعناصر منفصلة.</span></div>
          <div class="field"><label for="rd-sec">المنطقة</label>
            <select class="select" id="rd-sec">${d.sections.map((s) => `<option value="${esc(s.id)}" ${s.id === r.sectionId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="rd-kind">طريقة التسعير</label>
            <select class="select" id="rd-kind">
              <option value="route" ${r.kind === 'route' ? 'selected' : ''}>توصيل — ${d.fareTypes.map((f) => esc(f.name)).join(' / ')}</option>
              <option value="flat" ${r.kind === 'flat' ? 'selected' : ''}>باقة بسعر ثابت واحد (أوفر داي، يومية)</option>
            </select></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" value="save">حفظ</button>
          <button class="btn" value="dup">${icon('duplicate')} تكرار</button>
          <button class="btn btn-danger" value="del">${icon('trash')} حذف</button>
          <button class="btn btn-ghost" value="cancel">إلغاء</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', async () => {
      const v = dlg.returnValue;
      const name = $('#rd-name', dlg).value.replace(/\s*\n\s*/g, ' ').trim();
      const sec = $('#rd-sec', dlg).value;
      const kind = $('#rd-kind', dlg).value;
      dlg.remove();
      if (v === 'save') {
        r.name = name;
        if (r.sectionId !== sec) {
          // move to the end of the new section
          S.draft.routes.splice(S.draft.routes.indexOf(r), 1);
          let idx = -1;
          S.draft.routes.forEach((x, i) => { if (x.sectionId === sec) idx = i; });
          r.sectionId = sec;
          S.draft.routes.splice(idx + 1, 0, r);
        }
        if (kind !== r.kind) {
          r.kind = kind;
          if (kind === 'flat') for (const vid of Object.keys(r.prices)) d.fareTypes.slice(1).forEach((f) => { r.prices[vid][f.id] = null; });
        }
      } else if (v === 'dup') {
        const copy = { ...clone(r), id: uid('r'), name: `${r.name} (نسخة)` };
        S.draft.routes.splice(S.draft.routes.indexOf(r) + 1, 0, copy);
        toast('تم تكرار الوجهة');
      } else if (v === 'del') {
        const ok = await confirmDialog({ title: 'حذف الوجهة؟', message: `«${r.name || 'بدون اسم'}» — يمكنك التراجع بتجاهل التغييرات قبل النشر.`, confirmText: 'حذف', danger: true });
        if (!ok) return;
        S.draft.routes = S.draft.routes.filter((x) => x.id !== r.id);
        toast('تم حذف الوجهة من المسودة');
      } else return;
      renderZoneEditors();
      refreshStatus();
    });
    dlg.showModal();
  }

  // ---------------- bulk adjust ----------------
  function bulkDialog() {
    const d = S.draft;
    const dlg = document.createElement('dialog');
    dlg.className = 'modal wide';
    dlg.innerHTML = `
      <form method="dialog" id="bulk-form">
        <div class="modal-body">
          <h2>تعديل جماعي للأسعار</h2>
          <p>يُطبّق على المسودة فقط، وتستطيع مراجعته قبل النشر.</p>
          <div class="bulk-grid">
            <div class="field"><label for="b-sec">المنطقة</label>
              <select class="select" id="b-sec"><option value="all">كل المناطق</option>${d.sections.map((s) => `<option value="${esc(s.id)}" ${S.filter.section === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="b-veh">فئة السيارة</label>
              <select class="select" id="b-veh"><option value="all">كل الفئات</option>${d.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="b-fare">نوع التعريفة</label>
              <select class="select" id="b-fare"><option value="all">كل الأنواع</option>${d.fareTypes.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></div>
            <div class="field"><label for="b-mode">طريقة التعديل</label>
              <select class="select" id="b-mode"><option value="pct">نسبة مئوية %</option><option value="abs">مبلغ ثابت (${esc(d.settings.currency)})</option></select></div>
            <div class="field"><label for="b-val">القيمة</label>
              <input class="input num" id="b-val" inputmode="decimal" value="10" dir="ltr">
              <span class="hint">استخدم سالباً للتخفيض، مثل ‎-5</span></div>
            <div class="field"><label for="b-round">التقريب</label>
              <select class="select" id="b-round"><option value="1">بدون</option><option value="5">لأقرب 5</option><option value="10">لأقرب 10</option><option value="50" selected>لأقرب 50</option><option value="100">لأقرب 100</option></select></div>
          </div>
          <div class="preview-box" id="b-preview" aria-live="polite"></div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-brass" value="ok" id="b-apply">تطبيق على المسودة</button>
          <button class="btn btn-ghost" value="cancel">إلغاء</button>
        </div>
      </form>`;
    document.body.appendChild(dlg);

    const plan = () => {
      const sec = $('#b-sec', dlg).value, veh = $('#b-veh', dlg).value, fare = $('#b-fare', dlg).value;
      const mode = $('#b-mode', dlg).value, step = Number($('#b-round', dlg).value);
      const val = Number(String($('#b-val', dlg).value).replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660)));
      const edits = [];
      if (!Number.isFinite(val) || val === 0) return { edits, invalid: !Number.isFinite(val) };
      for (const r of d.routes) {
        if (sec !== 'all' && r.sectionId !== sec) continue;
        for (const v of d.vehicles) {
          if (veh !== 'all' && v.id !== veh) continue;
          d.fareTypes.forEach((f, fi) => {
            if (fare !== 'all' && f.id !== fare && !(r.kind === 'flat' && fi === 0 && fare === 'all')) return;
            if (r.kind === 'flat' && fi > 0) return;
            const old = r.prices?.[v.id]?.[f.id];
            if (old == null) return;
            let n = mode === 'pct' ? old * (1 + val / 100) : old + val;
            n = Math.max(0, Math.round(n / step) * step);
            if (n !== old) edits.push({ r, v: v.id, f: f.id, old, n });
          });
        }
      }
      return { edits };
    };
    const preview = () => {
      const { edits, invalid } = plan();
      const box = $('#b-preview', dlg);
      $('#b-apply', dlg).disabled = !edits.length;
      if (invalid) { box.innerHTML = 'أدخل قيمة رقمية صحيحة.'; return; }
      if (!edits.length) { box.innerHTML = 'لن يتغير أي سعر بهذه الإعدادات.'; return; }
      box.innerHTML = `سيتغيّر <strong class="num">${edits.length}</strong> سعراً. أمثلة:
        <div class="preview-samples">${edits.slice(0, 6).map((x) => `<span class="num">${fmt(x.old)} ← <b>${fmt(x.n)}</b></span>`).join('')}</div>`;
    };
    $$('select, input', dlg).forEach((el) => el.addEventListener('input', preview));
    preview();
    dlg.addEventListener('close', () => {
      if (dlg.returnValue === 'ok') {
        const { edits } = plan();
        edits.forEach((x) => { x.r.prices[x.v][x.f] = x.n; });
        refreshStatus();
        if (S.view === 'prices') renderZoneEditors(); else go('prices');
        toast(`تم تعديل ${edits.length} سعر في المسودة — راجعها ثم انشر`);
      }
      dlg.remove();
    });
    dlg.showModal();
  }

  // ---------------- zones ----------------
  function renderZones(root) {
    const d = S.draft;
    const count = (id) => d.routes.filter((r) => r.sectionId === id).length;
    root.innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>المناطق (${d.sections.length})</h2><p>الترتيب هنا هو ترتيب الظهور في صفحة الأسعار.</p></div>
        <ol class="list-editor" id="zone-list">
          ${d.sections.map((s, i) => `
            <li data-sid="${esc(s.id)}">
              <span class="idx num">${i + 1}</span>
              <div class="fields">
                <label class="sr-only" for="zn-${esc(s.id)}">اسم المنطقة</label>
                <input class="input" id="zn-${esc(s.id)}" data-field="name" value="${esc(s.name)}" placeholder="اسم المنطقة">
                <label class="sr-only" for="zt-${esc(s.id)}">ملاحظة</label>
                <input class="input" id="zt-${esc(s.id)}" data-field="note" value="${esc(s.note || '')}" placeholder="ملاحظة قصيرة تظهر تحت اسم المنطقة (اختياري)">
                <span class="meta"><span class="num">${count(s.id)}</span> وجهة</span>
              </div>
              <div class="ops">
                <button class="icon-btn" type="button" data-op="up" aria-label="نقل لأعلى" ${i === 0 ? 'disabled' : ''}>${icon('chevronUp')}</button>
                <button class="icon-btn" type="button" data-op="down" aria-label="نقل لأسفل" ${i === d.sections.length - 1 ? 'disabled' : ''}>${icon('chevronDown')}</button>
                <button class="icon-btn" type="button" data-op="open" aria-label="تعديل أسعار المنطقة" title="تعديل الأسعار">${icon('tag')}</button>
                <button class="icon-btn danger" type="button" data-op="del" aria-label="حذف المنطقة" title="حذف">${icon('trash')}</button>
              </div>
            </li>`).join('')}
        </ol>
        <div class="panel-foot"><button class="btn" type="button" id="add-zone">${icon('plus')} إضافة منطقة</button></div>
      </section>`;

    $('#zone-list').addEventListener('input', (e) => {
      const li = e.target.closest('[data-sid]');
      const s = d.sections.find((x) => x.id === li.dataset.sid);
      s[e.target.dataset.field] = e.target.value;
      refreshStatusSoon();
    });
    $('#zone-list').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const sid = b.closest('[data-sid]').dataset.sid;
      const i = d.sections.findIndex((x) => x.id === sid);
      if (b.dataset.op === 'up' || b.dataset.op === 'down') {
        const j = i + (b.dataset.op === 'up' ? -1 : 1);
        [d.sections[i], d.sections[j]] = [d.sections[j], d.sections[i]];
        renderZones(root);
        $(`[data-sid="${sid}"] [data-op="${b.dataset.op}"]`)?.focus();
        refreshStatus();
      } else if (b.dataset.op === 'open') {
        S.filter = { q: '', section: sid };
        go('prices');
      } else if (b.dataset.op === 'del') {
        const n = count(sid);
        const ok = await confirmDialog({
          title: `حذف منطقة «${d.sections[i].name}»؟`,
          message: n ? `سيتم حذف ${n} وجهة تابعة لها أيضاً. يمكنك التراجع قبل النشر.` : 'المنطقة فارغة.',
          confirmText: 'حذف', danger: true,
        });
        if (!ok) return;
        d.sections.splice(i, 1);
        d.routes = d.routes.filter((r) => r.sectionId !== sid);
        renderZones(root);
        refreshStatus();
      }
    });
    $('#add-zone').addEventListener('click', () => {
      const s = { id: uid('s'), name: 'منطقة جديدة', note: '' };
      d.sections.push(s);
      renderZones(root);
      const el = $(`#zn-${s.id}`);
      el.focus(); el.select();
      refreshStatus();
    });
  }

  // ---------------- vehicles ----------------
  function renderVehicles(root) {
    const d = S.draft;
    root.innerHTML = `
      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>فئات السيارات</h2><p>كل فئة تظهر كمجموعة أعمدة أسعار مستقلة.</p></div>
          <ol class="list-editor" id="veh-list">
            ${d.vehicles.map((v, i) => `
              <li data-vid="${esc(v.id)}">
                <span class="idx num">${i + 1}</span>
                <div class="fields"><label class="sr-only" for="vn-${esc(v.id)}">اسم الفئة</label>
                  <input class="input" id="vn-${esc(v.id)}" value="${esc(v.name)}" placeholder="مثل: سيدان، ميني فان، فان VIP"></div>
                <div class="ops">
                  <button class="icon-btn" type="button" data-op="up" aria-label="نقل لأعلى" ${i === 0 ? 'disabled' : ''}>${icon('chevronUp')}</button>
                  <button class="icon-btn" type="button" data-op="down" aria-label="نقل لأسفل" ${i === d.vehicles.length - 1 ? 'disabled' : ''}>${icon('chevronDown')}</button>
                  <button class="icon-btn danger" type="button" data-op="del" aria-label="حذف الفئة" ${d.vehicles.length < 2 ? 'disabled' : ''}>${icon('trash')}</button>
                </div>
              </li>`).join('')}
          </ol>
          <div class="panel-foot"><button class="btn" type="button" id="add-veh" ${d.vehicles.length >= 8 ? 'disabled' : ''}>${icon('plus')} إضافة فئة</button></div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2>أنواع التعريفة</h2><p>عناوين أعمدة الأسعار داخل كل فئة. الباقات ذات السعر الثابت تستخدم العمود الأول.</p></div>
          <ol class="list-editor" id="fare-list">
            ${d.fareTypes.map((f, i) => `
              <li data-fid="${esc(f.id)}">
                <span class="idx num">${i + 1}</span>
                <div class="fields"><label class="sr-only" for="fn-${esc(f.id)}">اسم التعريفة</label>
                  <input class="input" id="fn-${esc(f.id)}" value="${esc(f.name)}"></div>
                <span></span>
              </li>`).join('')}
          </ol>
        </section>
      </div>`;

    $('#veh-list').addEventListener('input', (e) => {
      const v = d.vehicles.find((x) => x.id === e.target.closest('[data-vid]').dataset.vid);
      v.name = e.target.value;
      refreshStatusSoon();
    });
    $('#fare-list').addEventListener('input', (e) => {
      const f = d.fareTypes.find((x) => x.id === e.target.closest('[data-fid]').dataset.fid);
      f.name = e.target.value;
      refreshStatusSoon();
    });
    $('#veh-list').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const vid = b.closest('[data-vid]').dataset.vid;
      const i = d.vehicles.findIndex((x) => x.id === vid);
      if (b.dataset.op === 'del') {
        const ok = await confirmDialog({ title: `حذف فئة «${d.vehicles[i].name}»؟`, message: 'ستُحذف كل أسعار هذه الفئة من جميع الوجهات.', confirmText: 'حذف', danger: true });
        if (!ok) return;
        d.vehicles.splice(i, 1);
        d.routes.forEach((r) => { delete r.prices[vid]; });
      } else {
        const j = i + (b.dataset.op === 'up' ? -1 : 1);
        [d.vehicles[i], d.vehicles[j]] = [d.vehicles[j], d.vehicles[i]];
      }
      renderVehicles(root);
      refreshStatus();
    });
    $('#add-veh').addEventListener('click', () => {
      const v = { id: uid('v'), name: 'فئة جديدة' };
      d.vehicles.push(v);
      d.routes.forEach((r) => { r.prices[v.id] = Object.fromEntries(d.fareTypes.map((f) => [f.id, null])); });
      renderVehicles(root);
      const el = $(`#vn-${v.id}`); el.focus(); el.select();
      refreshStatus();
      toast('أضيفت الفئة — أدخل أسعارها من صفحة الأسعار');
    });
  }

  // ---------------- terms ----------------
  function renderTerms(root) {
    const d = S.draft;
    root.innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>الشروط (${d.notes.length})</h2></div>
        ${d.notes.length ? '' : '<p class="empty-note">لا توجد شروط بعد.</p>'}
        <ol class="list-editor" id="term-list">
          ${d.notes.map((n, i) => `
            <li data-nid="${esc(n.id)}">
              <span class="idx num">${i + 1}</span>
              <div class="fields"><label class="sr-only" for="t-${esc(n.id)}">نص الشرط</label>
                <textarea class="textarea" id="t-${esc(n.id)}" rows="2">${esc(n.text)}</textarea></div>
              <div class="ops">
                <button class="icon-btn" type="button" data-op="up" aria-label="نقل لأعلى" ${i === 0 ? 'disabled' : ''}>${icon('chevronUp')}</button>
                <button class="icon-btn" type="button" data-op="down" aria-label="نقل لأسفل" ${i === d.notes.length - 1 ? 'disabled' : ''}>${icon('chevronDown')}</button>
                <button class="icon-btn danger" type="button" data-op="del" aria-label="حذف الشرط">${icon('trash')}</button>
              </div>
            </li>`).join('')}
        </ol>
        <div class="panel-foot"><button class="btn" type="button" id="add-term">${icon('plus')} إضافة شرط</button></div>
      </section>`;
    $('#term-list').addEventListener('input', (e) => {
      const n = d.notes.find((x) => x.id === e.target.closest('[data-nid]').dataset.nid);
      n.text = e.target.value;
      refreshStatusSoon();
    });
    $('#term-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-op]');
      if (!b) return;
      const nid = b.closest('[data-nid]').dataset.nid;
      const i = d.notes.findIndex((x) => x.id === nid);
      if (b.dataset.op === 'del') d.notes.splice(i, 1);
      else {
        const j = i + (b.dataset.op === 'up' ? -1 : 1);
        [d.notes[i], d.notes[j]] = [d.notes[j], d.notes[i]];
      }
      renderTerms(root);
      refreshStatus();
    });
    $('#add-term').addEventListener('click', () => {
      const n = { id: uid('n'), text: '' };
      d.notes.push(n);
      renderTerms(root);
      $(`#t-${n.id}`).focus();
      refreshStatus();
    });
  }

  // ---------------- appearance ----------------
  const APPEAR = { mode: 'light', device: 'phone' };

  function themeDraft() {
    S.draft.theme = FaresTheme.normalize(S.draft.theme);
    return S.draft.theme;
  }

  const COLOR_FIELDS = [
    ['primary', 'اللون الرئيسي', 'الشريط العلوي والمنطقة المختارة'],
    ['accent', 'لون التمييز', 'الأيقونات والشارات وزر النسخ'],
    ['bg', 'الخلفية', 'خلفية الصفحة'],
    ['surface', 'البطاقات', 'خلفية المناطق والجداول'],
    ['text', 'النص', 'لون الكتابة الأساسي'],
  ];

  const seg = (key, value, options) => `
    <div class="segmented seg-wrap" data-seg="${key}" role="group">
      ${options.map(([v, label]) => `<button type="button" data-val="${v}" aria-pressed="${String(value) === String(v)}">${label}</button>`).join('')}
    </div>`;

  function sendPreview() {
    const f = $('#pv-frame');
    if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'fares:theme', theme: S.draft.theme, mode: APPEAR.mode }, location.origin);
  }
  const sendPreviewSoon = debounce(sendPreview, 40);
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data && e.data.type === 'fares:ready' && S.view === 'appearance') sendPreview();
  });

  function themeChanged() {
    sendPreviewSoon();
    refreshStatusSoon();
  }

  function renderAppearance(root) {
    const t = themeDraft();
    root.innerHTML = `
      <div class="appearance">
        <div class="appearance-main stack">
          <section class="panel">
            <div class="panel-head"><h2>القوالب الجاهزة</h2><p>اختر قالباً كنقطة بداية، ثم عدّل الألوان والخطوط كما تشاء.</p></div>
            <div class="panel-body presets" id="ap-presets">
              ${FaresTheme.PRESETS.map((p) => `
                <button type="button" class="preset" data-preset="${p.id}" aria-pressed="${t.preset === p.id}">
                  <span class="pm" aria-hidden="true">
                    <span class="pm-band"><span class="pm-dot"></span><span class="pm-title">قائمة الأسعار</span></span>
                    <span class="pm-body">
                      <span class="pm-card"><span class="pm-line"></span><span class="pm-price">1,250</span></span>
                      <span class="pm-card"><span class="pm-line short"></span><span class="pm-price">850</span></span>
                    </span>
                  </span>
                  <span class="preset-info"><strong>${esc(p.name)}</strong><span>${esc(p.desc)}</span></span>
                  <span class="preset-check" aria-hidden="true">${icon('check')}</span>
                </button>`).join('')}
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <h2>الألوان</h2>
              <div class="segmented" id="ap-mode" role="group" aria-label="الوضع الذي تعدّل ألوانه">
                <button type="button" data-mode="light" aria-pressed="${APPEAR.mode === 'light'}">${icon('sun')} الوضع الفاتح</button>
                <button type="button" data-mode="dark" aria-pressed="${APPEAR.mode === 'dark'}">${icon('moon')} الوضع الداكن</button>
              </div>
              <p>لكل وضع ألوانه الخاصة. الدرجات الثانوية (الحدود، الخلفيات الخفيفة) تُشتق تلقائياً بشكل متناسق.</p>
            </div>
            <div class="panel-body">
              <div class="color-grid" id="ap-colors"></div>
              <ul class="checks" id="ap-checks" aria-live="polite"></ul>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>الخطوط</h2><p>كل الخطوط مضمّنة في الموقع وتعمل بدون إنترنت.</p></div>
            <div class="panel-body stack" id="ap-fonts"></div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>طريقة العرض</h2><p>إعدادات تناسب السائقين: خط أكبر، ورأس صفحة مختصر، ومناطق مطوية.</p></div>
            <div class="panel-body stack" id="ap-layout"></div>
            <div class="panel-foot">
              <button class="btn btn-ghost" type="button" id="ap-reset">${icon('refresh')} استعادة المظهر الافتراضي</button>
            </div>
          </section>
        </div>

        <aside class="appearance-preview" aria-label="معاينة مباشرة">
          <div class="pv-bar">
            <strong>معاينة مباشرة</strong>
            <div class="segmented" id="pv-device-seg" role="group" aria-label="حجم المعاينة">
              <button type="button" data-device="phone" aria-pressed="${APPEAR.device === 'phone'}" aria-label="جوال" title="جوال">${icon('phoneDevice')}</button>
              <button type="button" data-device="desktop" aria-pressed="${APPEAR.device === 'desktop'}" aria-label="كمبيوتر" title="كمبيوتر">${icon('monitor')}</button>
            </div>
          </div>
          <div class="pv-stage" id="pv-stage">
            <div class="pv-device" id="pv-device" data-device="${APPEAR.device}">
              <iframe id="pv-frame" src="/?preview=1" title="معاينة صفحة الأسعار"></iframe>
            </div>
          </div>
          <p class="pv-note">${icon('eye')} تعرض المعاينة التعديلات قبل النشر، ولا يراها الزوار إلا بعد «مراجعة ونشر».</p>
        </aside>
      </div>`;

    paintPresets();
    paintColors();
    paintFonts();
    paintLayout();
    fitPreview();
    new ResizeObserver(fitPreview).observe($('#pv-stage'));

    // --- events ---
    $('#ap-presets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      const p = FaresTheme.PRESETS.find((x) => x.id === b.dataset.preset);
      Object.assign(t, {
        preset: p.id, light: { ...p.light }, dark: { ...p.dark },
        fontText: p.fontText, fontDisplay: p.fontDisplay, fontNumbers: p.fontNumbers,
        radius: p.radius, scale: p.scale || t.scale,
      });
      paintPresets(); paintColors(); paintFonts(); paintLayout();
      themeChanged();
      toast(`تم تطبيق قالب «${p.name}» على المسودة`);
    });

    $('#ap-mode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      APPEAR.mode = b.dataset.mode;
      $$('#ap-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      paintColors();
      sendPreview();
    });

    $('#ap-colors').addEventListener('input', (e) => {
      const el = e.target;
      const key = el.dataset.color || el.dataset.hex;
      if (!key) return;
      let v = el.value.trim();
      if (el.dataset.hex) {
        if (!v.startsWith('#')) v = `#${v}`;
        const ok = /^#[0-9a-f]{6}$/i.test(v);
        el.classList.toggle('invalid', !ok);
        if (!ok) return;
        $(`[data-color="${key}"]`).value = v.toLowerCase();
      } else {
        const hex = $(`[data-hex="${key}"]`);
        hex.value = v; hex.classList.remove('invalid');
      }
      t[APPEAR.mode][key] = v.toLowerCase();
      t.preset = 'custom';
      paintPresets();
      paintChecks();
      themeChanged();
    });

    $('#ap-fonts').addEventListener('change', (e) => {
      const k = e.target.dataset.font;
      if (!k) return;
      t[k] = e.target.value;
      t.preset = t.preset === 'custom' ? 'custom' : t.preset;
      paintFonts();
      themeChanged();
    });

    $('.appearance', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-seg] [data-val]');
      if (!b) return;
      const key = b.closest('[data-seg]').dataset.seg;
      t[key] = key === 'scale' ? Number(b.dataset.val) : b.dataset.val;
      $$(`[data-seg="${key}"] [data-val]`).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      if (key === 'numerals') paintFonts();
      if (key === 'scale') paintLayout();
      themeChanged();
    });

    $('#ap-layout').addEventListener('input', (e) => {
      if (e.target.id !== 'ap-scale') return;
      t.scale = Number(e.target.value);
      $('#ap-scale-val').textContent = `${t.scale}%`;
      themeChanged();
    });

    $('#ap-reset').addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'استعادة المظهر الافتراضي؟', message: 'سيعود القالب والألوان والخطوط وطريقة العرض إلى الإعداد الأصلي (في المسودة فقط).', confirmText: 'استعادة' });
      if (!ok) return;
      S.draft.theme = FaresTheme.normalize(null);
      renderAppearance(root);
      themeChanged();
    });

    $('#pv-device-seg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-device]');
      if (!b) return;
      APPEAR.device = b.dataset.device;
      $$('#pv-device-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $('#pv-device').dataset.device = APPEAR.device;
      fitPreview();
    });

    $('#pv-frame').addEventListener('load', sendPreview);
  }

  function paintPresets() {
    const t = S.draft.theme;
    $$('#ap-presets .preset').forEach((b) => {
      const p = FaresTheme.PRESETS.find((x) => x.id === b.dataset.preset);
      b.setAttribute('aria-pressed', String(t.preset === p.id));
      const pm = $('.pm', b);
      const L = p.light;
      pm.style.setProperty('--pm-primary', L.primary);
      pm.style.setProperty('--pm-on', FaresTheme.onColor(L.primary));
      pm.style.setProperty('--pm-accent', L.accent);
      pm.style.setProperty('--pm-bg', L.bg);
      pm.style.setProperty('--pm-surface', L.surface);
      pm.style.setProperty('--pm-text', L.text);
      $('.pm-title', pm).style.fontFamily = (p.fontDisplay === 'same' ? FaresTheme.font(p.fontText) : FaresTheme.font(p.fontDisplay)).family;
      $$('.pm-price', pm).forEach((x) => { x.style.fontFamily = (p.fontNumbers === 'same' ? FaresTheme.font(p.fontText) : FaresTheme.font(p.fontNumbers)).family; });
      $('.preset-info strong', b).style.fontFamily = FaresTheme.font(p.fontText).family;
    });
  }

  function paintColors() {
    const p = S.draft.theme[APPEAR.mode];
    $('#ap-colors').innerHTML = COLOR_FIELDS.map(([k, label, hint]) => `
      <div class="color-row">
        <label class="color-swatch" for="c-${k}">
          <input type="color" id="c-${k}" data-color="${k}" value="${p[k]}">
        </label>
        <div class="color-text">
          <label for="h-${k}">${label}</label>
          <span class="hint">${hint}</span>
        </div>
        <input class="input hex-input num" id="h-${k}" data-hex="${k}" value="${p[k]}" maxlength="7" dir="ltr" spellcheck="false" aria-label="${label} — كود اللون">
      </div>`).join('');
    paintChecks();
  }

  function paintChecks() {
    const p = S.draft.theme[APPEAR.mode];
    const C = FaresTheme.contrast;
    const rows = [
      ['النص على الخلفية', C(p.text, p.bg), 4.5],
      ['النص على البطاقات', C(p.text, p.surface), 4.5],
      ['لون التمييز على البطاقات', C(p.accent, p.surface), 3],
      ['الكتابة فوق اللون الرئيسي', C(FaresTheme.onColor(p.primary), p.primary), 4.5],
    ];
    const bad = rows.filter(([, r, min]) => r < min).length;
    $('#ap-checks').innerHTML = `
      <li class="checks-head">${bad ? `${icon('alert')} ${bad} ${bad === 1 ? 'تنبيه' : 'تنبيهات'} وضوح — قد يصعب القراءة في ضوء الشمس` : `${icon('check')} كل الألوان واضحة ومقروءة`}</li>
      ${rows.map(([label, r, min]) => `<li class="${r >= min ? 'ok' : 'warn'}">${icon(r >= min ? 'check' : 'alert')}<span>${label}</span><b class="num">${r.toFixed(1)}:1</b><small>المطلوب ${min}:1</small></li>`).join('')}`;
    $('#ap-checks').classList.toggle('has-warn', !!bad);
  }

  function paintFonts() {
    const t = S.draft.theme;
    const F = FaresTheme.FONTS;
    const opt = (list, sel) => list.map((f) => `<option value="${f.id}" ${f.id === sel ? 'selected' : ''}>${esc(f.name)} — ${esc(f.note)}</option>`).join('');
    const textFonts = F.filter((f) => f.ar && !f.display);
    const displayFonts = F.filter((f) => f.ar);
    const numFont = t.fontNumbers === 'same' ? FaresTheme.font(t.fontText) : FaresTheme.font(t.fontNumbers);
    const latinNumWithArab = t.numerals === 'arab' && !numFont.ar;
    const sampleNums = [450, 1600, 9300].map((n) => new Intl.NumberFormat(t.numerals === 'arab' ? 'ar-EG' : 'en-US').format(n)).join('  ·  ');
    $('#ap-fonts').innerHTML = `
      <div class="font-field">
        <div class="field"><label for="f-text">خط النصوص</label>
          <select class="select" id="f-text" data-font="fontText">${opt(textFonts, t.fontText)}</select></div>
        <p class="font-sample" data-sample="fontText">مطار القاهرة — مدينة نصر، التجمع، الرحاب</p>
      </div>
      <div class="font-field">
        <div class="field"><label for="f-display">خط العناوين</label>
          <select class="select" id="f-display" data-font="fontDisplay"><option value="same" ${t.fontDisplay === 'same' ? 'selected' : ''}>نفس خط النصوص</option>${opt(displayFonts, t.fontDisplay)}</select></div>
        <p class="font-sample big" data-sample="fontDisplay">الساحل الشمالي</p>
      </div>
      <div class="font-field">
        <div class="field"><label for="f-num">خط الأرقام والأسعار</label>
          <select class="select" id="f-num" data-font="fontNumbers"><option value="same" ${t.fontNumbers === 'same' ? 'selected' : ''}>نفس خط النصوص</option>${opt(F.filter((f) => !f.display), t.fontNumbers)}</select></div>
        <p class="font-sample nums" data-sample="fontNumbers">${sampleNums}</p>
        ${latinNumWithArab ? `<p class="hint warn-note">${icon('alert')} هذا الخط لا يدعم الأرقام العربية (١٢٣)، لذلك ستظهر الأسعار بخط النصوص.</p>` : ''}
      </div>
      <div class="field"><span class="field-label">شكل الأرقام</span>
        ${seg('numerals', t.numerals, [['latn', '<span class="num">123</span> إنجليزية'], ['arab', '١٢٣ عربية']])}
      </div>`;
    const text = FaresTheme.font(t.fontText);
    $('[data-sample="fontText"]').style.fontFamily = text.family;
    $('[data-sample="fontDisplay"]').style.fontFamily = (t.fontDisplay === 'same' ? text : FaresTheme.font(t.fontDisplay)).family;
    $('[data-sample="fontNumbers"]').style.fontFamily = (latinNumWithArab ? text : numFont).family;
  }

  function paintLayout() {
    const t = S.draft.theme;
    $('#ap-layout').innerHTML = `
      <div class="field">
        <label for="ap-scale">حجم الخط الأساسي <b class="num" id="ap-scale-val">${t.scale}%</b></label>
        <div class="scale-row">
          <span class="scale-a small" aria-hidden="true">أ</span>
          <input type="range" id="ap-scale" min="85" max="140" step="5" value="${t.scale}">
          <span class="scale-a big" aria-hidden="true">أ</span>
        </div>
        ${seg('scale', t.scale, [[100, 'عادي'], [112, 'كبير'], [125, 'كبير جداً']])}
        <span class="hint">يستطيع الزائر أيضاً تكبير الخط من زر «أ» أعلى الصفحة.</span>
      </div>
      <div class="field"><span class="field-label">رأس الصفحة</span>
        ${seg('header', t.header, [['compact', 'مختصر — يُظهر الأسعار أسرع'], ['full', 'كامل — مع الإحصائيات']])}</div>
      <div class="field"><span class="field-label">المناطق عند فتح الصفحة</span>
        ${seg('sections', t.sections, [['collapsed', 'كلها مطوية'], ['first', 'الأولى مفتوحة'], ['expanded', 'كلها مفتوحة']])}</div>
      <div class="field"><span class="field-label">الحواف</span>
        ${seg('radius', t.radius, [['sharp', 'حادة'], ['soft', 'ناعمة'], ['round', 'دائرية']])}</div>
      <div class="field"><span class="field-label">الوضع الافتراضي للزوار</span>
        ${seg('mode', t.mode, [['auto', 'حسب الجهاز'], ['light', 'فاتح'], ['dark', 'داكن']])}
        <span class="hint">«حسب الجهاز» يتحول للداكن ليلاً تلقائياً على أغلب الهواتف. ويمكن للزائر التبديل يدوياً.</span></div>`;
  }

  function fitPreview() {
    const stage = $('#pv-stage');
    const dev = $('#pv-device');
    const frame = $('#pv-frame');
    if (!stage || !frame) return;
    const [w, h] = APPEAR.device === 'phone' ? [390, 760] : [1280, 820];
    const avail = stage.clientWidth - (APPEAR.device === 'phone' ? 24 : 0);
    const scale = Math.min(1, avail / w);
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
    frame.style.transform = `scale(${scale})`;
    dev.style.width = `${Math.round(w * scale)}px`;
    dev.style.height = `${Math.round(h * scale)}px`;
  }

  // ---------------- settings ----------------
  function renderSettings(root) {
    const s = S.draft.settings;
    const f = (key, label, hint = '', attrs = '') => `
      <div class="field"><label for="st-${key}">${label}</label>
        <input class="input" id="st-${key}" data-key="${key}" value="${esc(s[key] || '')}" ${attrs}>
        ${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
    root.innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>بيانات القائمة</h2></div>
        <div class="panel-body grid-2" id="settings-form">
          ${f('brand', 'اسم الشركة', 'يظهر أعلى الصفحة وفي الطباعة.')}
          ${f('title', 'عنوان القائمة')}
          ${f('subtitle', 'وصف مختصر')}
          ${f('effectiveDate', 'تاريخ السريان', 'التاريخ الذي تبدأ فيه هذه الأسعار.', 'type="date"')}
          ${f('currency', 'العملة', 'مثل: ج.م')}
          ${f('phone', 'رقم الحجز والاستفسار', 'اختياري — يظهر أعلى الصفحة.', 'dir="ltr" inputmode="tel"')}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>النسخ الاحتياطي</h2><p>نزّل نسخة كاملة من القائمة المنشورة، أو حمّل نسخة سابقة كمسودة لمراجعتها ثم نشرها.</p></div>
        <div class="panel-foot">
          <button class="btn" type="button" id="backup-dl">${icon('download')} تنزيل نسخة احتياطية</button>
          <label class="btn" for="backup-file">${icon('upload')} تحميل نسخة كمسودة</label>
          <input class="sr-only" type="file" id="backup-file" accept="application/json,.json">
        </div>
      </section>`;
    $('#settings-form').addEventListener('input', (e) => {
      const k = e.target.dataset.key;
      if (!k) return;
      s[k] = e.target.value;
      refreshStatusSoon();
    });
    $('#backup-dl').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ ...docOf(S.server), version: S.server.version, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
      download(`fares-backup-v${S.server.version}.json`, blob);
    });
    $('#backup-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!REQUIRED_KEYS.every((k) => k in data) || !Array.isArray(data.routes)) throw new Error('bad');
        S.draft = clone(docOf(data));
        S.draft.version = S.server.version;
        refreshStatus();
        toast('تم تحميل النسخة كمسودة — راجعها ثم انشر');
        go('prices');
      } catch {
        toast('الملف ليس نسخة احتياطية صالحة', 'error');
      }
    });
  }

  // ---------------- history ----------------
  async function renderHistory(root) {
    root.innerHTML = `<section class="panel"><div class="panel-head"><h2>النسخ المنشورة</h2><p>يُحتفظ بآخر 60 نسخة. الاستعادة تحمّل النسخة كمسودة، ولا تُنشر إلا بعد مراجعتك.</p></div><ul class="timeline" id="hist"><li><span></span><small>جارٍ التحميل…</small></li></ul></section>`;
    try {
      const h = await api('/api/admin/history');
      const el = $('#hist');
      if (!el) return;
      el.innerHTML = h.map((x) => `
        <li data-hid="${esc(x.id)}"><span class="dot"></span>
          <div><strong>${esc(x.summary)}</strong>
            <small>${esc(x.by || '')} · ${esc(formatDateTime(x.savedAt))} · <span class="num">${x.routes}</span> وجهة</small></div>
          <div class="actions">
            ${x.version === S.server.version ? '<span class="tag live">المنشورة حالياً</span>' : `<span class="tag num">v${x.version}</span><button class="btn btn-sm" type="button" data-restore="${esc(x.id)}">${icon('undo')} استعادة كمسودة</button>`}
          </div>
        </li>`).join('') || '<li><span></span><small>لا يوجد سجل بعد</small></li>';
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-restore]');
        if (!b) return;
        if (changeCache.length) {
          const ok = await confirmDialog({ title: 'استبدال المسودة الحالية؟', message: 'لديك تغييرات غير منشورة ستُستبدل بهذه النسخة.', confirmText: 'استبدال', danger: true });
          if (!ok) return;
        }
        try {
          const entry = await api(`/api/admin/history/${encodeURIComponent(b.dataset.restore)}`);
          S.draft = clone(docOf(entry.doc));
          S.draft.version = S.server.version;
          refreshStatus();
          toast(`تم تحميل النسخة v${entry.doc.version} كمسودة — راجعها ثم انشر`);
          go('prices');
        } catch (err) { handleError(err); }
      });
    } catch (err) { handleError(err); }
  }

  // ---------------- account ----------------
  function renderAccount(root) {
    root.innerHTML = `
      <section class="panel">
        <div class="panel-head"><h2>تغيير كلمة المرور</h2><p>بعد التغيير يتم تسجيل خروج أي جلسة أخرى مفتوحة بهذا الحساب.</p></div>
        <form class="panel-body stack" id="pw-form" novalidate>
          <input type="text" name="username" autocomplete="username" value="${esc(S.user)}" hidden>
          <div class="field"><label for="pw-cur">كلمة المرور الحالية</label><input class="input" type="password" id="pw-cur" autocomplete="current-password" dir="ltr" required></div>
          <div class="grid-2">
            <div class="field"><label for="pw-new">كلمة المرور الجديدة</label><input class="input" type="password" id="pw-new" autocomplete="new-password" dir="ltr" minlength="8" required><span class="hint">8 أحرف على الأقل.</span></div>
            <div class="field"><label for="pw-rep">تأكيد كلمة المرور</label><input class="input" type="password" id="pw-rep" autocomplete="new-password" dir="ltr" required></div>
          </div>
          <p class="form-error" id="pw-err" role="alert" hidden></p>
          <div><button class="btn btn-primary" type="submit">حفظ كلمة المرور</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>الجلسة</h2><p>مسجّل الدخول باسم <strong>${esc(S.user)}</strong>. تنتهي الجلسة تلقائياً بعد 8 ساعات من عدم النشاط.</p></div>
        <div class="panel-foot"><button class="btn btn-danger" type="button" id="logout-2">${icon('logout')} تسجيل الخروج</button></div>
      </section>`;
    $('#logout-2').addEventListener('click', logout);
    $('#pw-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#pw-err');
      const cur = $('#pw-cur').value, nw = $('#pw-new').value, rep = $('#pw-rep').value;
      const show = (m) => { err.hidden = false; err.innerHTML = `${icon('alert')}<span>${esc(m)}</span>`; };
      if (nw.length < 8) return show('كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
      if (nw !== rep) return show('كلمتا المرور غير متطابقتين');
      try {
        await api('/api/admin/password', { method: 'POST', body: { current: cur, next: nw } });
        err.hidden = true;
        e.target.reset();
        toast('تم تغيير كلمة المرور');
      } catch (ex) {
        if (ex.status === 401) return handleError(ex);
        show(ex.message);
      }
    });
  }

  // ======================================================================
  // Auth & boot
  // ======================================================================
  function showLogin() {
    $('#shell').hidden = true;
    $('#login').hidden = false;
    document.body.classList.remove('is-loading');
    $('#username').focus();
  }

  async function logout() {
    if (changeCache.length) {
      const ok = await confirmDialog({ title: 'تسجيل الخروج؟', message: 'لديك تغييرات غير منشورة. ستبقى محفوظة كمسودة على هذا الجهاز.', confirmText: 'تسجيل الخروج' });
      if (!ok) return;
    }
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* ignore */ }
    location.hash = '';
    location.reload();
  }

  async function loadApp() {
    const data = await api('/api/admin/data');
    S.server = data;
    S.draft = clone(data);

    // Offer to recover a local draft left from an earlier session.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore */ }

    $('#login').hidden = true;
    $('#shell').hidden = false;
    document.body.classList.remove('is-loading');
    const brand = data.settings.brand || '';
    $('#side-brand').textContent = brand;
    $('#side-mark').textContent = brand.trim()[0] || 'ل';
    $('#user-name').textContent = S.user;
    $('#avatar').textContent = (S.user[0] || '?').toUpperCase();

    S.view = (location.hash || '#overview').slice(1);
    if (!VIEWS[S.view]) S.view = 'overview';
    refreshStatus();
    render();

    if (saved && saved.doc && saved.user === S.user) {
      const stale = saved.base !== data.version;
      const ok = await confirmDialog({
        title: 'وجدنا مسودة غير منشورة',
        message: stale
          ? 'لديك تعديلات محفوظة على هذا الجهاز، لكن القائمة نُشرت بعدها. استعادتها ستستبدل النسخة الأحدث عند النشر.'
          : 'لديك تعديلات محفوظة على هذا الجهاز من جلسة سابقة. هل تريد متابعتها؟',
        confirmText: 'استعادة المسودة',
      });
      if (ok) {
        S.draft = clone(saved.doc);
        refreshStatus();
        render();
      } else {
        try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      }
    }
  }

  function bindLogin() {
    $('#login-mark').textContent = 'ل';
    $('#login-back').innerHTML = `${icon('external')}<span>العودة إلى صفحة الأسعار</span>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = $('#login-error');
      const btn = $('#login-submit');
      const username = $('#username').value.trim();
      const password = $('#password').value;
      if (!username || !password) {
        err.hidden = false;
        err.innerHTML = `${icon('alert')}<span>أدخل اسم المستخدم وكلمة المرور</span>`;
        return;
      }
      btn.disabled = true;
      btn.textContent = 'جارٍ الدخول…';
      try {
        const res = await api('/api/login', { method: 'POST', body: { username, password } });
        S.user = res.username;
        err.hidden = true;
        $('#password').value = '';
        if (S.server) {
          // session expired mid-work: keep the in-memory draft
          $('#login').hidden = true;
          $('#shell').hidden = false;
        } else await loadApp();
      } catch (ex) {
        err.hidden = false;
        err.innerHTML = `${icon('alert')}<span>${esc(ex.message)}</span>`;
        $('#password').select();
      } finally {
        btn.disabled = false;
        btn.textContent = 'دخول';
      }
    });
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#menu-toggle').setAttribute('aria-expanded', 'false');
    $('.scrim')?.remove();
  }

  function bindShell() {
    $('#menu-toggle').innerHTML = icon('menu');
    $('#logout-btn').innerHTML = icon('logout');
    $('#view-public').innerHTML = `${icon('external')}<span>عرض صفحة الأسعار</span>`;
    $('#discard-btn').innerHTML = `${icon('undo')}<span>تجاهل</span>`;
    $('#publish-btn').innerHTML = `${icon('check')}<span>مراجعة ونشر</span>`;
    bindThemeButton($('#theme-btn'));

    $('#publish-btn').addEventListener('click', () => publish());
    $('#discard-btn').addEventListener('click', discard);
    $('#logout-btn').addEventListener('click', logout);
    $('#menu-toggle').addEventListener('click', () => {
      const sb = $('#sidebar');
      if (sb.classList.contains('open')) return closeSidebar();
      sb.classList.add('open');
      $('#menu-toggle').setAttribute('aria-expanded', 'true');
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      scrim.addEventListener('click', closeSidebar);
      document.body.appendChild(scrim);
    });
    $('#side-nav').addEventListener('click', (e) => {
      const a = e.target.closest('[data-view]');
      if (!a) return;
      e.preventDefault();
      go(a.dataset.view);
    });
    $('#view').addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (a && VIEWS[a.getAttribute('href').slice(1)]) { e.preventDefault(); go(a.getAttribute('href').slice(1)); }
    });
    window.addEventListener('hashchange', () => { const v = location.hash.slice(1); if (v !== S.view && VIEWS[v]) go(v); });
    window.addEventListener('beforeunload', (e) => {
      if (changeCache.length) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        refreshStatus();
        if (changeCache.length) publish();
      }
      if (e.key === 'Escape') closeSidebar();
    });
    bindPriceEditor();
  }

  async function init() {
    bindLogin();
    bindShell();
    try {
      const me = await api('/api/me');
      S.user = me.username;
      await loadApp();
    } catch (err) {
      if (err.status === 401) showLogin();
      else {
        document.body.classList.remove('is-loading');
        toast(err.message, 'error');
        showLogin();
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
