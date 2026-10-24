/* SPARK PERFORMANCE DYNO · v1.0 · dependency-free SVG gauges.
 * Browser: window.DynoGauges.throughput(options), .percent(options).
 * Node: const { throughput, percent } = require('./gauges.js').
 * See assets/gauges/geometry.json and docs/06-assets.md for the contract.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DynoGauges = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var serial = 0;
  var START = 135;
  var SWEEP = 270;
  var C = {
    accent: 'var(--accent, #B0FF43)',
    text: 'var(--text, #F1F5F8)',
    muted: 'var(--text-muted, #A4B1BC)',
    track: 'var(--track, #36444F)',
    border: 'var(--border, #34414D)',
    display: 'var(--font-display, sans-serif)',
    mono: 'var(--font-mono, monospace)'
  };

  function escape(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function positive(value) { return finite(value) && value >= 0; }
  function number(value) {
    var scaled = value * 1000;
    return Number.isFinite(scaled) ? String(Math.round(scaled) / 1000) : String(value);
  }
  function reading(value) {
    if (value >= 1000000) return value.toExponential(2);
    return value.toFixed(1);
  }
  function tick(value) {
    if (Math.abs(value) >= 1000000) return value.toExponential(1);
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  }
  function percentReading(value) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
  function ids(id, fallback) {
    var safe = String(id || fallback).replace(/[^A-Za-z0-9_-]/g, '-');
    return 'dyno-' + safe + '-' + (++serial);
  }
  function point(cx, cy, radius, degrees) {
    var radians = degrees * Math.PI / 180;
    return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
  }
  function xy(p) { return number(p[0]) + ' ' + number(p[1]); }
  function arc(cx, cy, radius, fraction) {
    var end = START + SWEEP * fraction;
    return 'M ' + xy(point(cx, cy, radius, START)) + ' A ' + radius + ' ' + radius + ' 0 ' +
      (SWEEP * fraction > 180 ? '1' : '0') + ' 1 ' + xy(point(cx, cy, radius, end));
  }
  function line(from, to, stroke, width, extra) {
    return '<path d="M ' + xy(from) + ' L ' + xy(to) + '" fill="none" stroke="' + stroke +
      '" stroke-width="' + width + '"' + (extra || '') + '/>';
  }
  function text(x, y, content, size, color, extra) {
    return '<text x="' + number(x) + '" y="' + number(y) + '" text-anchor="middle" fill="' + color +
      '" font-family="' + C.mono + '" font-size="' + size + '"' + (extra || '') + '>' + escape(content) + '</text>';
  }
  function needle(cx, cy, angle) {
    var inner = point(cx, cy, 88, angle);
    var left = point(inner[0], inner[1], 3.2, angle - 90);
    var right = point(inner[0], inner[1], 3.2, angle + 90);
    var tip = point(cx, cy, 156, angle);
    return '<path class="dyno-gauge__needle" d="M ' + xy(left) + ' L ' + xy(tip) + ' L ' + xy(right) +
      ' Z" fill="' + C.accent + '"/>';
  }
  function peakMarker(cx, cy, angle) {
    var center = point(cx, cy, 167, angle);
    var outer = point(center[0], center[1], 5.2, angle);
    var sideA = point(center[0], center[1], 3.8, angle + 90);
    var inner = point(center[0], center[1], 5.2, angle + 180);
    var sideB = point(center[0], center[1], 3.8, angle - 90);
    return '<path class="dyno-gauge__peak-marker" d="M ' + xy(outer) + ' L ' + xy(sideA) + ' L ' +
      xy(inner) + ' L ' + xy(sideB) + ' Z" fill="' + C.text + '" stroke="' + C.border + '" stroke-width="1.25"/>';
  }

  function throughput(options) {
    options = options || {};
    var available = !options.unavailable && positive(options.value);
    var value = available ? options.value : null;
    var peak = !options.unavailable && positive(options.peak) ? options.peak : null;
    var max = finite(options.max) && options.max > 0 ? Math.max(200, options.max) : 200;
    var extent = Math.max(value === null ? 0 : value, peak === null ? 0 : peak);
    if (extent > max) max = Math.ceil(extent / 50) * 50;
    var ratio = value === null ? 0 : value / max;
    var angle = START + SWEEP * ratio;
    var peakAngle = peak === null ? null : START + SWEEP * peak / max;
    var label = options.label === undefined ? 'INFERENCE' : String(options.label);
    var unit = options.unit === undefined ? 'TOKENS / S' : String(options.unit);
    var id = ids(options.id, 'throughput');
    var description = 'Scale: 0 to ' + tick(max) + ' ' + unit + ', increasing clockwise. ' +
      (available ? 'Current reading ' + reading(value) + '. ' : 'Current reading unavailable; no needle is shown. ') +
      (peak === null ? 'Recorded peak unavailable.' : 'Recorded peak ' + reading(peak) + ' ' + unit + '; this is an observed peak, not a capacity limit.');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" class="dyno-gauge dyno-gauge--throughput" viewBox="0 0 420 350" width="100%" height="auto" style="display:block;overflow:visible" role="img" focusable="false" aria-labelledby="' + id + '-title" aria-describedby="' + id + '-desc" data-unavailable="' + (!available) + '" data-range="' + number(max) + '"' +
      (available ? ' data-value="' + number(value) + '" data-needle-angle="' + number(angle) + '"' : '') +
      (peak !== null ? ' data-peak="' + number(peak) + '" data-peak-angle="' + number(peakAngle) + '"' : '') + '>';
    svg += '<title id="' + id + '-title">' + escape(label + ': ' + (available ? reading(value) + ' ' + unit : 'unavailable')) + '</title>';
    svg += '<desc id="' + id + '-desc">' + escape(description) + '</desc>';
    svg += '<g class="dyno-gauge__face" aria-hidden="true">';
    svg += '<path d="' + arc(210, 189, 176, 1) + '" fill="none" stroke="' + C.border + '" stroke-width="1.25"/>';
    svg += '<path d="' + arc(210, 189, 167, 1) + '" fill="none" stroke="' + C.track + '" stroke-width="5"/>';
    if (available && ratio > 0) svg += '<path class="dyno-gauge__value-arc" d="' + arc(210, 189, 167, ratio) + '" fill="none" stroke="' + C.accent + '" stroke-width="5"/>';
    if (peak !== null) svg += peakMarker(210, 189, peakAngle);
    if (available) svg += needle(210, 189, angle);
    for (var i = 0; i <= 40; i++) {
      var major = i % 10 === 0;
      var medium = i % 5 === 0;
      var a = START + SWEEP * i / 40;
      svg += line(point(210, 189, major ? 148 : (medium ? 153 : 157), a), point(210, 189, 161, a), major ? C.text : C.muted, major ? 1.75 : 1);
    }
    for (var j = 0; j <= 4; j++) {
      var position = point(210, 189, 132, START + SWEEP * j / 4);
      svg += text(position[0], position[1] + 5, tick(max * j / 4), 13, C.muted, ' style="paint-order:stroke;stroke:var(--surface, #151B21);stroke-width:3px;stroke-linejoin:round"');
    }
    svg += text(210, 133, label, 13, C.muted, ' letter-spacing="1.8"');
    svg += '<text class="dyno-gauge__reading" x="210" y="213" text-anchor="middle" fill="' + C.text + '" font-family="' + C.display + '" font-weight="600" font-size="' + (available && reading(value).length > 6 ? 49 : 76) + '" style="font-variant-numeric:tabular-nums">' + (available ? escape(reading(value)) : '—') + '</text>';
    svg += text(210, 243, unit, 14, C.muted, ' letter-spacing="1.5"');
    svg += text(210, 320, peak === null ? 'RECORDED PEAK —' : 'RECORDED PEAK ' + reading(peak), 11, C.muted, ' letter-spacing="0.8"');
    if (!available) svg += text(210, 342, 'NO CURRENT DATA', 10, C.muted, ' letter-spacing="1.3"');
    svg += '</g></svg>';
    return svg;
  }

  function percent(options) {
    options = options || {};
    var available = !options.unavailable && positive(options.value) && options.value <= 100;
    var value = available ? options.value : null;
    var label = options.label === undefined ? 'UTILIZATION' : String(options.label);
    var id = ids(options.id, 'percent');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" class="dyno-gauge dyno-gauge--percent" viewBox="0 0 240 210" width="100%" height="auto" style="display:block;overflow:visible" role="img" focusable="false" aria-labelledby="' + id + '-title" aria-describedby="' + id + '-desc" data-unavailable="' + (!available) + '" data-range="100"' + (available ? ' data-value="' + number(value) + '"' : '') + '>';
    svg += '<title id="' + id + '-title">' + escape(label + ': ' + (available ? percentReading(value) + ' percent' : 'unavailable')) + '</title>';
    svg += '<desc id="' + id + '-desc">' + escape('Scale: 0 to 100 percent, increasing clockwise. ' + (available ? 'Current reading ' + percentReading(value) + ' percent.' : 'Current reading unavailable; no filled arc is shown.')) + '</desc>';
    svg += '<g aria-hidden="true"><path d="' + arc(120, 111, 98, 1) + '" fill="none" stroke="' + C.border + '" stroke-width="1"/>';
    svg += '<path d="' + arc(120, 111, 88, 1) + '" fill="none" stroke="' + C.track + '" stroke-width="10"/>';
    if (available && value > 0) svg += '<path class="dyno-gauge__value-arc" d="' + arc(120, 111, 88, value / 100) + '" fill="none" stroke="' + C.accent + '" stroke-width="10"/>';
    for (var i = 0; i <= 4; i++) {
      var a = START + SWEEP * i / 4;
      svg += line(point(120, 111, 95, a), point(120, 111, 99, a), C.muted, 1);
      var p = point(120, 111, 71, a);
      svg += text(p[0], p[1] + 3.5, String(i * 25), 9, C.muted);
    }
    svg += '<text class="dyno-gauge__reading" x="120" y="120" text-anchor="middle" fill="' + C.text + '" font-family="' + C.display + '" font-weight="600" font-size="48" style="font-variant-numeric:tabular-nums">' + (available ? escape(percentReading(value)) + '<tspan font-size="25">%</tspan>' : '—') + '</text>';
    svg += text(120, 143, label, 11, C.muted, ' letter-spacing="1.1"');
    if (!available) svg += text(120, 192, 'NO CURRENT DATA', 9, C.muted, ' letter-spacing="1"');
    svg += '</g></svg>';
    return svg;
  }

  return Object.freeze({ throughput: throughput, percent: percent });
});
