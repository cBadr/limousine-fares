/* global Fares, FaresTheme, ExcelJS */
/*
 * Professional exports shared by the public page and the print page.
 *  - xlsx(): fully formatted workbook (brand colours, frozen headers, A4 print setup,
 *    repeated header rows, page numbers, terms sheet, filterable data sheet).
 *  - csv(): plain UTF-8 CSV for other systems.
 * ExcelJS (~950 KB) is loaded only when an Excel export is requested.
 */
window.FaresExport = (() => {
  const { formatDate, formatDateTime, download, toast } = Fares;

  let excelLoading = null;
  function loadExcel() {
    if (window.ExcelJS) return Promise.resolve();
    excelLoading ||= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/exceljs.min.js';
      s.onload = resolve;
      s.onerror = () => { excelLoading = null; reject(new Error('تعذّر تحميل مكتبة Excel')); };
      document.head.appendChild(s);
    });
    return excelLoading;
  }

  const argb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`;
  const places = (name) => name.split(' - ').map((p) => p.trim()).filter(Boolean);
  const fileBase = (s) => `${s.title}${s.effectiveDate ? ` - ${s.effectiveDate}` : ''}`.replace(/[\\/:*?"<>|]/g, '-');

  // Colours for documents always come from the light palette (paper is white).
  function palette() {
    const t = FaresTheme.current;
    const p = t.light;
    const f = FaresTheme.fareTokens(t, p, false);
    const mix = FaresTheme.mix;
    return {
      primary: p.primary,
      onPrimary: FaresTheme.onColor(p.primary),
      accent: p.accent,
      text: '#1b1b1b',
      muted: '#6b6b6b',
      line: mix('#ffffff', p.text, 0.18),
      band: mix('#ffffff', p.accent, 0.16),
      zebra: mix('#ffffff', p.text, 0.03),
      fareMode: t.fareColors.mode,
      fare: (i) => ({ bg: f[`--f${i}-bg`], ink: f[`--f${i}-ink`], dot: f[`--f${i}-dot`] }),
    };
  }

  /**
   * opts: { data, groups: [{section, rows}], vehicles, scope: string[] }
   */
  async function xlsx(opts) {
    const { data, groups, vehicles } = opts;
    await loadExcel();
    const s = data.settings;
    const fares = data.fareTypes;
    const nF = fares.length;
    const C = palette();
    const hasNotes = groups.some((g) => g.rows.some((r) => r.note));
    const FONT = 'Arial';

    const wb = new ExcelJS.Workbook();
    wb.creator = s.brand;
    wb.title = s.title;
    wb.created = new Date();

    // ------------------------------------------------ main sheet
    const priceCols = vehicles.length * nF;
    const first = hasNotes ? 4 : 3; // first price column (1-based)
    const lastCol = first + priceCols - 1;
    const ws = wb.addWorksheet('قائمة الأسعار', {
      views: [{ rightToLeft: true, state: 'frozen', ySplit: 6, showGridLines: false }],
      properties: { defaultRowHeight: 20 },
      pageSetup: {
        paperSize: 9,
        orientation: priceCols > 6 ? 'landscape' : 'portrait',
        fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        horizontalCentered: true,
        margins: { left: 0.35, right: 0.35, top: 0.55, bottom: 0.6, header: 0.25, footer: 0.3 },
      },
    });
    const cols = [{ width: 5 }, { width: 50 }];
    if (hasNotes) cols.push({ width: 26 });
    for (let i = 0; i < priceCols; i++) cols.push({ width: 12.5 });
    ws.columns = cols;

    const thin = { style: 'thin', color: { argb: argb(C.line) } };
    const box = { top: thin, bottom: thin, left: thin, right: thin };
    const fill = (hex) => (hex && hex !== 'transparent' ? { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) } } : undefined);
    const font = (o = {}) => ({ name: FONT, size: 11, color: { argb: argb(C.text) }, ...o });
    const rtl = (o = {}) => ({ readingOrder: 'rtl', vertical: 'middle', ...o });
    const styleCell = (cell, st) => Object.entries(st).forEach(([k, v]) => { if (v !== undefined) cell[k] = v; });

    // Title block
    ws.mergeCells(1, 1, 1, lastCol);
    styleCell(ws.getCell(1, 1), {
      value: s.brand,
      font: font({ size: 18, bold: true, color: { argb: argb(C.onPrimary) } }),
      fill: fill(C.primary),
      alignment: rtl({ horizontal: 'right', indent: 1 }),
    });
    ws.getRow(1).height = 34;

    ws.mergeCells(2, 1, 2, lastCol);
    styleCell(ws.getCell(2, 1), {
      value: `${s.title}${s.effectiveDate ? `   —   سارية اعتباراً من ${formatDate(s.effectiveDate)}` : ''}`,
      font: font({ size: 14, bold: true, color: { argb: argb(C.primary) } }),
      alignment: rtl({ horizontal: 'right', indent: 1 }),
      border: { bottom: { style: 'medium', color: { argb: argb(C.accent) } } },
    });
    ws.getRow(2).height = 28;

    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    const meta = [
      `الأسعار بـ${s.currency}`,
      `${total} وجهة في ${groups.length} منطقة`,
      ...(opts.scope && opts.scope.length ? [`نطاق التصدير: ${opts.scope.join(' · ')}`] : []),
      `إصدار رقم ${data.version}`,
      `صدر في ${formatDateTime(new Date().toISOString())}`,
    ].join('     ·     ');
    ws.mergeCells(3, 1, 3, lastCol);
    styleCell(ws.getCell(3, 1), {
      value: meta,
      font: font({ size: 9.5, color: { argb: argb(C.muted) } }),
      alignment: rtl({ horizontal: 'right', indent: 1 }),
    });
    ws.getRow(3).height = 20;
    ws.getRow(4).height = 6;

    // Column headers (rows 5–6), repeated on every printed page
    const hdr = (r, c, value, extra = {}) => styleCell(ws.getCell(r, c), {
      value,
      font: font({ bold: true, color: { argb: argb(C.onPrimary) } }),
      fill: fill(C.primary),
      alignment: rtl({ horizontal: 'center', wrapText: true }),
      border: box,
      ...extra,
    });
    ws.mergeCells(5, 1, 6, 1); hdr(5, 1, '#');
    ws.mergeCells(5, 2, 6, 2); hdr(5, 2, 'الوجهة', { alignment: rtl({ horizontal: 'right', indent: 1 }) });
    if (hasNotes) { ws.mergeCells(5, 3, 6, 3); hdr(5, 3, 'ملاحظات'); }
    vehicles.forEach((v, vi) => {
      const c0 = first + vi * nF;
      if (nF > 1) ws.mergeCells(5, c0, 5, c0 + nF - 1);
      hdr(5, c0, v.name, { font: font({ size: 12, bold: true, color: { argb: argb(C.onPrimary) } }) });
      fares.forEach((f, fi) => {
        const tint = C.fareMode === 'off' ? null : C.fare(fi);
        styleCell(ws.getCell(6, c0 + fi), {
          value: f.name,
          font: font({ bold: true, size: 10.5, color: { argb: argb(tint ? tint.ink : C.text) } }),
          fill: fill(tint ? tint.bg : C.zebra),
          alignment: rtl({ horizontal: 'center', wrapText: true }),
          border: { ...box, bottom: { style: 'medium', color: { argb: argb(tint ? tint.dot : C.primary) } } },
        });
      });
    });
    ws.getRow(5).height = 24;
    ws.getRow(6).height = 22;
    ws.pageSetup.printTitlesRow = '5:6';

    // Area bands + destination rows
    let r = 7;
    let serial = 0;
    for (const { section, rows } of groups) {
      ws.mergeCells(r, 1, r, lastCol);
      const band = ws.getCell(r, 1);
      band.value = {
        richText: [
          { text: section.name, font: font({ size: 12.5, bold: true, color: { argb: argb(C.primary) } }) },
          { text: `     ${rows.length} ${rows.length >= 3 && rows.length <= 10 ? 'وجهات' : 'وجهة'}`, font: font({ size: 9.5, color: { argb: argb(C.muted) } }) },
          ...(section.note ? [{ text: `     —  ${section.note}`, font: font({ size: 9.5, italic: true, color: { argb: argb(C.muted) } }) }] : []),
        ],
      };
      styleCell(band, {
        fill: fill(C.band),
        alignment: rtl({ horizontal: 'right', indent: 1 }),
        border: { top: { style: 'medium', color: { argb: argb(C.accent) } }, bottom: thin },
      });
      ws.getRow(r).height = 24;
      r++;

      rows.forEach((route, idx) => {
        serial++;
        const zebra = idx % 2 === 1 ? C.zebra : null;
        styleCell(ws.getCell(r, 1), {
          value: serial,
          font: font({ size: 9.5, color: { argb: argb(C.muted) } }),
          alignment: rtl({ horizontal: 'center' }), border: box, fill: fill(zebra),
        });
        const dest = route.kind === 'flat' ? `${route.name}  (باقة)` : places(route.name).join('  ،  ');
        styleCell(ws.getCell(r, 2), {
          value: dest,
          font: font({ bold: route.kind === 'flat' }),
          alignment: rtl({ horizontal: 'right', wrapText: true, indent: 1 }), border: box, fill: fill(zebra),
        });
        if (hasNotes) {
          styleCell(ws.getCell(r, 3), {
            value: route.note || '',
            font: font({ size: 9.5, italic: true, color: { argb: argb(C.muted) } }),
            alignment: rtl({ horizontal: 'right', wrapText: true }), border: box, fill: fill(zebra),
          });
        }
        vehicles.forEach((v, vi) => {
          const c0 = first + vi * nF;
          const pr = route.prices[v.id] || {};
          if (route.kind === 'flat') {
            if (nF > 1) ws.mergeCells(r, c0, r, c0 + nF - 1);
            const val = pr[fares[0].id];
            const tint = C.fareMode === 'off' ? null : C.fare(0);
            styleCell(ws.getCell(r, c0), {
              value: val == null ? '—' : val,
              numFmt: '#,##0"  سعر ثابت"',
              font: font({ bold: true, size: 11.5, color: { argb: argb(val == null ? C.muted : C.text) } }),
              fill: fill(tint ? tint.bg : zebra),
              alignment: rtl({ horizontal: 'center' }), border: box,
            });
            return;
          }
          fares.forEach((f, fi) => {
            const val = pr[f.id];
            const tint = C.fareMode === 'off' ? null : C.fare(fi);
            styleCell(ws.getCell(r, c0 + fi), {
              value: val == null ? '—' : val,
              numFmt: '#,##0',
              font: font({ bold: val != null, size: 11.5, color: { argb: argb(val == null ? C.line : C.text) } }),
              fill: fill(tint ? tint.bg : zebra),
              alignment: rtl({ horizontal: 'center' }), border: box,
            });
          });
        });
        r++;
      });
    }

    if (data.notes.length) {
      r++;
      ws.mergeCells(r, 1, r, lastCol);
      styleCell(ws.getCell(r, 1), {
        value: `الشروط والإضافات (${data.notes.length} بنود) — في ورقة «الشروط والإضافات»`,
        font: font({ size: 10, italic: true, color: { argb: argb(C.muted) } }),
        alignment: rtl({ horizontal: 'right', indent: 1 }),
      });
    }

    const footerDate = s.effectiveDate ? `سارية من ${formatDate(s.effectiveDate)}` : '';
    ws.headerFooter = {
      differentFirst: false,
      oddHeader: `&R&"${FONT},Bold"&10${s.title}&L&"${FONT},Regular"&9${s.brand}`,
      oddFooter: `&R&"${FONT},Regular"&8${footerDate}&C&"${FONT},Regular"&9صفحة &P من &N&L&"${FONT},Regular"&8${s.brand}`,
    };

    // ------------------------------------------------ terms sheet
    if (data.notes.length) {
      const wt = wb.addWorksheet('الشروط والإضافات', {
        views: [{ rightToLeft: true, showGridLines: false }],
        pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
      });
      wt.columns = [{ width: 6 }, { width: 100 }];
      wt.mergeCells(1, 1, 1, 2);
      styleCell(wt.getCell(1, 1), {
        value: `الشروط والإضافات — ${s.title}`,
        font: font({ size: 15, bold: true, color: { argb: argb(C.onPrimary) } }),
        fill: fill(C.primary), alignment: rtl({ horizontal: 'right', indent: 1 }),
      });
      wt.getRow(1).height = 30;
      wt.getRow(2).height = 8;
      data.notes.forEach((n, i) => {
        const row = wt.getRow(i + 3);
        styleCell(row.getCell(1), {
          value: i + 1,
          font: font({ bold: true, color: { argb: argb(C.accent) } }),
          alignment: rtl({ horizontal: 'center', vertical: 'top' }),
          border: { bottom: thin },
        });
        styleCell(row.getCell(2), {
          value: n.text,
          font: font(),
          alignment: rtl({ horizontal: 'right', vertical: 'top', wrapText: true }),
          border: { bottom: thin },
        });
        // Wrapped single cells autofit in Excel; give long lines a sensible minimum too.
        row.height = Math.max(22, Math.ceil(n.text.length / 95) * 18 + 6);
      });
      wt.headerFooter = { oddFooter: `&C&"${FONT},Regular"&9صفحة &P من &N&L&"${FONT},Regular"&8${s.brand}` };
    }

    // ------------------------------------------------ data sheet (filterable, for systems)
    const wd = wb.addWorksheet('بيانات للتصفية', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    const head = ['المنطقة', 'الوجهة', 'ملاحظة', 'النوع'];
    vehicles.forEach((v) => fares.forEach((f) => head.push(`${v.name} - ${f.name}`)));
    wd.columns = head.map((h, i) => ({ header: h, width: [18, 54, 28, 11][i] || 16 }));
    for (const { section, rows } of groups) {
      for (const route of rows) {
        const row = [section.name, route.name, route.note || '', route.kind === 'flat' ? 'سعر ثابت' : 'توصيل'];
        vehicles.forEach((v) => fares.forEach((f, fi) => {
          const val = route.kind === 'flat' && fi > 0 ? null : route.prices[v.id]?.[f.id];
          row.push(val == null ? null : val);
        }));
        wd.addRow(row);
      }
    }
    wd.getRow(1).eachCell((c) => {
      c.font = font({ bold: true, color: { argb: argb(C.onPrimary) } });
      c.fill = fill(C.primary);
      c.alignment = rtl({ horizontal: 'center', wrapText: true });
    });
    wd.getRow(1).height = 30;
    wd.eachRow((row, i) => {
      if (i === 1) return;
      row.eachCell({ includeEmpty: true }, (c, ci) => {
        c.font = font({ size: 10.5 });
        c.alignment = rtl({ horizontal: ci <= 4 ? 'right' : 'center', wrapText: ci === 2 });
        if (ci > 4) c.numFmt = '#,##0';
        c.border = { bottom: thin };
      });
    });
    wd.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } };

    const buf = await wb.xlsx.writeBuffer();
    download(`${fileBase(s)}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }

  function csv(opts) {
    const { data, groups, vehicles } = opts;
    const head = ['المنطقة', 'الوجهة', 'ملاحظة', 'النوع'];
    vehicles.forEach((v) => data.fareTypes.forEach((f) => head.push(`${v.name} - ${f.name}`)));
    const rows = [head];
    for (const { section, rows: rs } of groups) {
      for (const r of rs) {
        const row = [section.name, r.name, r.note || '', r.kind === 'flat' ? 'سعر ثابت' : 'توصيل'];
        vehicles.forEach((v) => data.fareTypes.forEach((f, i) => {
          const val = r.kind === 'flat' && i > 0 ? null : r.prices[v.id]?.[f.id];
          row.push(val == null ? '' : val);
        }));
        rows.push(row);
      }
    }
    const esc = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
    const text = rows.map((r) => r.map(esc).join(',')).join('\r\n');
    download(`${fileBase(data.settings)}.csv`, new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  }

  // Wraps an export with user feedback.
  async function run(kind, opts) {
    try {
      if (kind === 'xlsx') {
        toast('جارٍ تجهيز ملف Excel…');
        await xlsx(opts);
        toast('تم تصدير ملف Excel منسّق وجاهز للطباعة');
      } else {
        csv(opts);
        toast('تم تصدير ملف CSV');
      }
    } catch (err) {
      console.error(err);
      toast(err.message || 'تعذّر التصدير', 'error');
    }
  }

  return { xlsx, csv, run, loadExcel };
})();
