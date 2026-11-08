/*
 * Theme engine — loaded synchronously in <head> on every page.
 * Holds the font catalog and ready-made templates, derives every colour token
 * from five base colours, and applies the cached theme before first paint.
 */
(function () {
  'use strict';

  var FONTS = [
    { id: 'plex', name: 'IBM Plex Arabic', family: '"Plex Arabic"', ar: true, note: 'واضح ورسمي' },
    { id: 'cairo', name: 'Cairo', family: '"Cairo Var"', ar: true, note: 'عصري ومقروء جداً' },
    { id: 'tajawal', name: 'Tajawal', family: '"Tajawal"', ar: true, note: 'خفيف وأنيق' },
    { id: 'almarai', name: 'Almarai', family: '"Almarai"', ar: true, note: 'عريض ومريح للعين' },
    { id: 'noto-kufi', name: 'Noto Kufi', family: '"Noto Kufi Var"', ar: true, note: 'كوفي هندسي' },
    { id: 'readex', name: 'Readex Pro', family: '"Readex Var"', ar: true, note: 'مصمم للقراءة على الشاشات' },
    { id: 'rubik', name: 'Rubik', family: '"Rubik Var"', ar: true, note: 'حواف ناعمة' },
    { id: 'changa', name: 'Changa', family: '"Changa Var"', ar: true, note: 'مضغوط وقوي' },
    { id: 'messiri', name: 'El Messiri', family: '"Messiri Var"', ar: true, note: 'طابع فاخر' },
    { id: 'naskh', name: 'Noto Naskh', family: '"Naskh Var"', ar: true, note: 'نسخ كلاسيكي' },
    { id: 'reem-kufi', name: 'Reem Kufi', family: '"Reem Kufi"', ar: true, display: true, note: 'للعناوين فقط' },
    { id: 'inter', name: 'Inter', family: '"Inter Var"', ar: false, digits: true, note: 'أرقام إنجليزية واضحة' },
    { id: 'oswald', name: 'Oswald', family: '"Oswald Var"', ar: false, digits: true, note: 'أرقام طويلة وبارزة' },
    { id: 'roboto-mono', name: 'Roboto Mono', family: '"Roboto Mono Var"', ar: false, digits: true, note: 'أرقام بعرض ثابت' },
  ];

  // Each template: light + dark palettes (5 base colours) and a font pairing.
  var PRESETS = [
    {
      id: 'classic', name: 'كحلي ونحاسي', desc: 'رسمي وهادئ — الطابع الأصلي',
      light: { primary: '#141d36', accent: '#8a6420', bg: '#f4efe4', surface: '#fffcf5', text: '#131a2b' },
      dark: { primary: '#0a0e19', accent: '#d6aa5c', bg: '#0e1320', surface: '#161d2e', text: '#ece5d6' },
      fontText: 'plex', fontDisplay: 'reem-kufi', fontNumbers: 'same', radius: 'soft',
    },
    {
      id: 'royal', name: 'أسود ملكي', desc: 'أسود وذهبي لخدمة VIP',
      light: { primary: '#121212', accent: '#8f6f1f', bg: '#f5f3ee', surface: '#ffffff', text: '#161616' },
      dark: { primary: '#000000', accent: '#d9b44a', bg: '#0a0a0a', surface: '#161616', text: '#f3efe4' },
      fontText: 'tajawal', fontDisplay: 'messiri', fontNumbers: 'same', radius: 'soft',
    },
    {
      id: 'airport', name: 'أزرق المطار', desc: 'نظيف وواضح مثل لوحات المطارات',
      light: { primary: '#0b4a92', accent: '#b45f06', bg: '#eef3f9', surface: '#ffffff', text: '#0f1e33' },
      dark: { primary: '#082a52', accent: '#f4b740', bg: '#0a1522', surface: '#12233a', text: '#e6eef8' },
      fontText: 'cairo', fontDisplay: 'cairo', fontNumbers: 'inter', radius: 'round',
    },
    {
      id: 'emerald', name: 'زمردي', desc: 'أخضر داكن مع لمسة ذهبية',
      light: { primary: '#0f4c3a', accent: '#946020', bg: '#f2f0e8', surface: '#fffdf7', text: '#13241e' },
      dark: { primary: '#072a20', accent: '#e0b062', bg: '#0b1612', surface: '#13221d', text: '#e7efe9' },
      fontText: 'noto-kufi', fontDisplay: 'noto-kufi', fontNumbers: 'same', radius: 'soft',
    },
    {
      id: 'burgundy', name: 'عنابي', desc: 'دافئ وفخم',
      light: { primary: '#5a1625', accent: '#9a5f22', bg: '#f6f0ea', surface: '#fffaf5', text: '#2a1418' },
      dark: { primary: '#2a0a11', accent: '#e3a65f', bg: '#160a0d', surface: '#22121a', text: '#f3e7e9' },
      fontText: 'almarai', fontDisplay: 'messiri', fontNumbers: 'same', radius: 'soft',
    },
    {
      id: 'slate', name: 'رمادي عصري', desc: 'بسيط مع تمييز فيروزي',
      light: { primary: '#1f2937', accent: '#0f766e', bg: '#f3f4f6', surface: '#ffffff', text: '#111827' },
      dark: { primary: '#0b1220', accent: '#2dd4bf', bg: '#0f172a', surface: '#1e293b', text: '#e5e7eb' },
      fontText: 'readex', fontDisplay: 'readex', fontNumbers: 'inter', radius: 'round',
    },
    {
      id: 'desert', name: 'رملي', desc: 'ألوان الصحراء الدافئة',
      light: { primary: '#5e3219', accent: '#a64a22', bg: '#f5ecdd', surface: '#fffaf1', text: '#2b1d12' },
      dark: { primary: '#2e1a0e', accent: '#ec8f5f', bg: '#18110b', surface: '#261b13', text: '#f4e8d8' },
      fontText: 'changa', fontDisplay: 'changa', fontNumbers: 'same', radius: 'sharp',
    },
    {
      id: 'contrast', name: 'تباين عالٍ', desc: 'أوضح قراءة تحت الشمس وللنظر الضعيف',
      light: { primary: '#000000', accent: '#b23c00', bg: '#ffffff', surface: '#ffffff', text: '#000000' },
      dark: { primary: '#000000', accent: '#ffd400', bg: '#000000', surface: '#0f0f0f', text: '#ffffff' },
      fontText: 'cairo', fontDisplay: 'cairo', fontNumbers: 'oswald', radius: 'sharp', scale: 112,
    },
  ];

  var DEFAULT = {
    preset: 'classic',
    light: PRESETS[0].light,
    dark: PRESETS[0].dark,
    fontText: 'plex',
    fontDisplay: 'reem-kufi',
    fontNumbers: 'same',
    numerals: 'latn', // latn = 123, arab = ١٢٣
    scale: 100, // % of base text size
    radius: 'soft', // sharp | soft | round
    mode: 'auto', // auto | light | dark  (visitor can still switch)
    header: 'compact', // compact | full
    sections: 'first', // collapsed | first | expanded
  };

  var HEX = /^#[0-9a-f]{6}$/i;
  var KEYS = ['primary', 'accent', 'bg', 'surface', 'text'];

  function palette(p, fallback) {
    var out = {};
    KEYS.forEach(function (k) { out[k] = p && HEX.test(p[k] || '') ? p[k].toLowerCase() : fallback[k]; });
    return out;
  }

  function pick(v, allowed, d) { return allowed.indexOf(v) >= 0 ? v : d; }

  function normalize(t) {
    t = t || {};
    var fontIds = FONTS.map(function (f) { return f.id; });
    var scale = Number(t.scale);
    return {
      preset: typeof t.preset === 'string' ? t.preset : DEFAULT.preset,
      light: palette(t.light, DEFAULT.light),
      dark: palette(t.dark, DEFAULT.dark),
      fontText: pick(t.fontText, fontIds, DEFAULT.fontText),
      fontDisplay: t.fontDisplay === 'same' ? 'same' : pick(t.fontDisplay, fontIds, DEFAULT.fontDisplay),
      fontNumbers: t.fontNumbers === 'same' ? 'same' : pick(t.fontNumbers, fontIds, DEFAULT.fontNumbers),
      numerals: pick(t.numerals, ['latn', 'arab'], DEFAULT.numerals),
      scale: scale >= 85 && scale <= 140 ? Math.round(scale) : DEFAULT.scale,
      radius: pick(t.radius, ['sharp', 'soft', 'round'], DEFAULT.radius),
      mode: pick(t.mode, ['auto', 'light', 'dark'], DEFAULT.mode),
      header: pick(t.header, ['compact', 'full'], DEFAULT.header),
      sections: pick(t.sections, ['collapsed', 'first', 'expanded'], DEFAULT.sections),
    };
  }

  // ---------- colour maths ----------
  function rgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function hex(c) {
    return '#' + c.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('');
  }
  // mix(a, b, t): t = share of b
  function mix(a, b, t) {
    var x = rgb(a), y = rgb(b);
    return hex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; }));
  }
  function lum(h) {
    var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function onColor(bg) {
    return contrast(bg, '#ffffff') >= contrast(bg, '#111111') ? '#ffffff' : '#111111';
  }

  // Derive the full token set used by the stylesheets from 5 base colours.
  function tokens(p, dark) {
    var onPrimary = onColor(p.primary);
    var focus = contrast(p.accent, p.bg) > contrast(p.primary, p.bg) ? p.accent : p.primary;
    return {
      '--paper': p.bg,
      '--paper-2': mix(p.bg, p.text, dark ? 0.07 : 0.05),
      '--card': p.surface,
      '--card-2': mix(p.surface, p.text, dark ? 0.045 : 0.025),
      '--ink': p.text,
      '--ink-2': mix(p.text, p.surface, 0.2),
      '--muted': mix(p.text, p.surface, dark ? 0.35 : 0.38),
      '--line': mix(p.surface, p.text, dark ? 0.16 : 0.13),
      '--line-strong': mix(p.surface, p.text, dark ? 0.28 : 0.25),
      '--band': p.primary,
      '--band-ink': onPrimary,
      '--band-muted': mix(onPrimary, p.primary, 0.32),
      '--brass': p.accent,
      '--brass-bright': mix(p.accent, dark ? '#ffffff' : p.accent, dark ? 0.12 : 0),
      '--brass-soft': mix(p.surface, p.accent, dark ? 0.2 : 0.14),
      '--on-brass': onColor(p.accent),
      '--band-accent': contrast(p.accent, p.primary) >= 3 ? p.accent : mix(p.accent, onPrimary, 0.55),
      '--focus': focus,
      '--mark': mix(p.surface, p.accent, dark ? 0.42 : 0.3),
      '--row-hover': mix(p.surface, p.accent, dark ? 0.1 : 0.07),
    };
  }

  var RADII = { sharp: ['5px', '4px'], soft: ['14px', '9px'], round: ['22px', '14px'] };

  function font(id) {
    for (var i = 0; i < FONTS.length; i++) if (FONTS[i].id === id) return FONTS[i];
    return FONTS[0];
  }
  var FALLBACK = ', "Segoe UI", Tahoma, Arial, sans-serif';

  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } }

  function resolveMode(theme, opts) {
    var forced = opts && opts.mode;
    if (forced === 'light' || forced === 'dark') return forced;
    var user = opts && opts.ignoreUser ? null : storageGet('fares-theme');
    if (user === 'light' || user === 'dark') return user;
    if (theme.mode === 'light' || theme.mode === 'dark') return theme.mode;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // apply(theme, { mode, userZoom, ignoreUser, root })
  function apply(input, opts) {
    opts = opts || {};
    var t = normalize(input);
    var root = opts.root || document.documentElement;
    var mode = resolveMode(t, opts);
    var dark = mode === 'dark';
    var tk = tokens(dark ? t.dark : t.light, dark);
    root.setAttribute('data-theme', mode);
    for (var k in tk) root.style.setProperty(k, tk[k]);

    var text = font(t.fontText);
    var display = t.fontDisplay === 'same' ? text : font(t.fontDisplay);
    var num = t.fontNumbers === 'same' ? text : font(t.fontNumbers);
    // Latin-only number fonts can't draw Arabic-Indic digits; fall back to the text font.
    if (t.numerals === 'arab' && !num.ar) num = text;
    root.style.setProperty('--font', text.family + FALLBACK);
    root.style.setProperty('--font-display', display.family + ', ' + text.family + FALLBACK);
    root.style.setProperty('--font-num', num.family + ', ' + text.family + FALLBACK);
    root.style.setProperty('--radius', RADII[t.radius][0]);
    root.style.setProperty('--radius-sm', RADII[t.radius][1]);

    var zoom = opts.userZoom ? Number(storageGet('fares-zoom')) || 1 : 1;
    root.style.fontSize = (16 * (t.scale / 100) * zoom).toFixed(2) + 'px';
    root.setAttribute('data-header', t.header);
    root.setAttribute('data-radius', t.radius);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', (dark ? t.dark : t.light).primary);

    api.current = t;
    api.mode = mode;
    return t;
  }

  function cache(theme) { storageSet('fares-theme-cache', JSON.stringify(normalize(theme))); }

  var api = {
    FONTS: FONTS, PRESETS: PRESETS, DEFAULT: DEFAULT,
    normalize: normalize, apply: apply, cache: cache, tokens: tokens,
    contrast: contrast, onColor: onColor, mix: mix, font: font,
    current: normalize(null), mode: 'light',
  };
  window.FaresTheme = api;

  // Boot: paint with the last known theme (public page caches it after each load).
  var page = document.documentElement.getAttribute('data-page');
  var cached = null;
  try { cached = JSON.parse(storageGet('fares-theme-cache') || 'null'); } catch (e) { cached = null; }
  apply(page === 'admin' ? null : cached, { userZoom: page === 'public' });
})();
