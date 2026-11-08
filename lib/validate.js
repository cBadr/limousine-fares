'use strict';

// Validates and normalises a full price-list document coming from the admin client.
// Throws an Error with a user-facing Arabic message on invalid input.

const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const MAX_PRICE = 10_000_000;

function fail(msg) {
  const err = new Error(msg);
  err.status = 400;
  throw err;
}

function str(v, max, field, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(`قيمة غير صالحة في "${field}"`);
  const out = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (required && !out) fail(`الحقل "${field}" مطلوب`);
  if (out.length > max) fail(`الحقل "${field}" أطول من المسموح (${max} حرف)`);
  return out;
}

function id(v, field) {
  if (typeof v !== 'string' || !ID_RE.test(v)) fail(`معرّف غير صالح في "${field}"`);
  return v;
}

function price(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) fail(`سعر غير صالح في "${field}"`);
  return n === 0 ? null : Math.round(n);
}

function list(v, field, max) {
  if (!Array.isArray(v)) fail(`القائمة "${field}" غير صالحة`);
  if (v.length > max) fail(`عدد العناصر في "${field}" يتجاوز الحد`);
  return v;
}

function unique(items, field) {
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) fail(`معرّف مكرر في "${field}"`);
    seen.add(it.id);
  }
}

function validateDocument(input) {
  if (!input || typeof input !== 'object') fail('بيانات غير صالحة');
  const s = input.settings || {};
  const settings = {
    brand: str(s.brand, 80, 'اسم الشركة', { required: true }),
    title: str(s.title, 120, 'عنوان القائمة', { required: true }),
    subtitle: str(s.subtitle, 240, 'الوصف'),
    effectiveDate: str(s.effectiveDate, 10, 'تاريخ السريان'),
    currency: str(s.currency, 12, 'العملة', { required: true }),
    phone: str(s.phone, 40, 'رقم التواصل'),
  };
  if (settings.effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(settings.effectiveDate)) fail('تاريخ السريان غير صالح');

  const vehicles = list(input.vehicles, 'فئات السيارات', 8).map((v, i) => ({
    id: id(v && v.id, `فئة ${i + 1}`),
    name: str(v && v.name, 40, 'اسم الفئة', { required: true }),
  }));
  if (!vehicles.length) fail('يجب وجود فئة سيارة واحدة على الأقل');
  unique(vehicles, 'فئات السيارات');

  const fareTypes = list(input.fareTypes, 'أنواع التعريفة', 6).map((f, i) => ({
    id: id(f && f.id, `تعريفة ${i + 1}`),
    name: str(f && f.name, 30, 'اسم التعريفة', { required: true }),
  }));
  if (!fareTypes.length) fail('يجب وجود نوع تعريفة واحد على الأقل');
  unique(fareTypes, 'أنواع التعريفة');

  const sections = list(input.sections, 'المناطق', 100).map((sec, i) => ({
    id: id(sec && sec.id, `منطقة ${i + 1}`),
    name: str(sec && sec.name, 80, 'اسم المنطقة', { required: true }),
    note: str(sec && sec.note, 300, 'ملاحظة المنطقة'),
  }));
  unique(sections, 'المناطق');
  const sectionIds = new Set(sections.map((x) => x.id));

  const routes = list(input.routes, 'خطوط السير', 2000).map((r, i) => {
    const sectionId = id(r && r.sectionId, `خط ${i + 1}`);
    if (!sectionIds.has(sectionId)) fail(`خط السير رقم ${i + 1} مرتبط بمنطقة غير موجودة`);
    const kind = r.kind === 'flat' ? 'flat' : 'route';
    const name = str(r.name, 300, `اسم خط السير رقم ${i + 1}`, { required: true });
    const prices = {};
    for (const v of vehicles) {
      const src = (r.prices && r.prices[v.id]) || {};
      prices[v.id] = {};
      fareTypes.forEach((f, fi) => {
        // Flat items carry a single price stored in the first fare type.
        prices[v.id][f.id] = kind === 'flat' && fi > 0 ? null : price(src[f.id], name);
      });
    }
    const note = str(r.note, 200, `ملاحظة خط السير رقم ${i + 1}`);
    return { id: id(r.id, `خط ${i + 1}`), sectionId, name, ...(note ? { note } : {}), kind, prices };
  });
  unique(routes, 'خطوط السير');

  const notes = list(input.notes, 'الشروط', 60).map((n, i) => ({
    id: id(n && n.id, `شرط ${i + 1}`),
    text: str(n && n.text, 600, `الشرط رقم ${i + 1}`, { required: true }),
  }));
  unique(notes, 'الشروط');

  return { settings, theme: validateTheme(input.theme), vehicles, fareTypes, sections, routes, notes };
}

// Appearance settings. Unknown or missing values fall back to defaults on the client,
// so the server only enforces shape and safe values.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const FONT_RE = /^[a-z0-9-]{1,30}$/;
function validateTheme(t) {
  if (t === undefined || t === null) return null;
  if (typeof t !== 'object') fail('إعدادات المظهر غير صالحة');
  const palette = (p, name) => {
    if (!p || typeof p !== 'object') fail(`ألوان ${name} غير صالحة`);
    const out = {};
    for (const k of ['primary', 'accent', 'bg', 'surface', 'text']) {
      if (typeof p[k] !== 'string' || !HEX_RE.test(p[k])) fail(`لون غير صالح في ${name}`);
      out[k] = p[k].toLowerCase();
    }
    return out;
  };
  const oneOf = (v, list, label) => {
    if (!list.includes(v)) fail(`قيمة غير صالحة في "${label}"`);
    return v;
  };
  const font = (v, label, allowSame) => {
    if (allowSame && v === 'same') return v;
    if (typeof v !== 'string' || !FONT_RE.test(v)) fail(`خط غير صالح في "${label}"`);
    return v;
  };
  const scale = Number(t.scale);
  if (!Number.isFinite(scale) || scale < 85 || scale > 140) fail('حجم الخط يجب أن يكون بين 85% و140%');
  return {
    preset: typeof t.preset === 'string' && FONT_RE.test(t.preset) ? t.preset : 'custom',
    light: palette(t.light, 'الوضع الفاتح'),
    dark: palette(t.dark, 'الوضع الداكن'),
    fontText: font(t.fontText, 'خط النصوص'),
    fontDisplay: font(t.fontDisplay, 'خط العناوين', true),
    fontNumbers: font(t.fontNumbers, 'خط الأرقام', true),
    numerals: oneOf(t.numerals, ['latn', 'arab'], 'شكل الأرقام'),
    scale: Math.round(scale),
    radius: oneOf(t.radius, ['sharp', 'soft', 'round'], 'الحواف'),
    mode: oneOf(t.mode, ['auto', 'light', 'dark'], 'الوضع الافتراضي'),
    header: oneOf(t.header, ['compact', 'full'], 'رأس الصفحة'),
    sections: oneOf(t.sections, ['collapsed', 'first', 'expanded'], 'عرض المناطق'),
    fareColors: fareColors(t.fareColors),
  };

  function fareColors(fc) {
    if (fc === undefined || fc === null) return { mode: 'tonal', custom: [] };
    if (typeof fc !== 'object') fail('ألوان أنواع الأسعار غير صالحة');
    const custom = Array.isArray(fc.custom) ? fc.custom.slice(0, 6) : [];
    return {
      mode: oneOf(fc.mode, ['tonal', 'multi', 'custom', 'off'], 'تمييز أنواع الأسعار'),
      custom: custom.map((c) => {
        if (c === null || c === undefined || c === '') return null;
        if (typeof c !== 'string' || !HEX_RE.test(c)) fail('لون غير صالح في ألوان أنواع الأسعار');
        return c.toLowerCase();
      }),
    };
  }
}

// Human-readable summary of what changed between two documents.
function summarize(prev, next) {
  const parts = [];
  const prevRoutes = new Map(prev.routes.map((r) => [r.id, r]));
  const nextIds = new Set(next.routes.map((r) => r.id));
  let added = 0, removed = 0, priceChanges = 0, renamed = 0;
  for (const r of next.routes) {
    const old = prevRoutes.get(r.id);
    if (!old) { added++; continue; }
    if (old.name !== r.name || (old.note || '') !== (r.note || '')) renamed++;
    for (const v of Object.keys(r.prices)) {
      for (const f of Object.keys(r.prices[v])) {
        const a = old.prices?.[v]?.[f] ?? null;
        if (a !== r.prices[v][f]) priceChanges++;
      }
    }
  }
  for (const r of prev.routes) if (!nextIds.has(r.id)) removed++;
  if (priceChanges) parts.push(`تعديل ${priceChanges} سعر`);
  if (added) parts.push(`إضافة ${added} خط`);
  if (removed) parts.push(`حذف ${removed} خط`);
  if (renamed) parts.push(`إعادة تسمية ${renamed} خط`);
  if (JSON.stringify(prev.sections) !== JSON.stringify(next.sections)) parts.push('تعديل المناطق');
  if (JSON.stringify(prev.notes) !== JSON.stringify(next.notes)) parts.push('تعديل الشروط');
  if (JSON.stringify(prev.settings) !== JSON.stringify(next.settings)) parts.push('تعديل الإعدادات');
  if (JSON.stringify(prev.theme || null) !== JSON.stringify(next.theme || null)) parts.push('تعديل المظهر');
  if (JSON.stringify(prev.vehicles) !== JSON.stringify(next.vehicles) || JSON.stringify(prev.fareTypes) !== JSON.stringify(next.fareTypes)) parts.push('تعديل فئات السيارات');
  if (!parts.length && JSON.stringify(prev.routes) !== JSON.stringify(next.routes)) parts.push('إعادة ترتيب');
  return parts.join('، ') || 'بدون تغييرات';
}

module.exports = { validateDocument, summarize };
