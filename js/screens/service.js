/*
 * ZoeWeb — Service screen: guided service procedures and health reports.
 *
 * Everything here uses only operations verified against CanZE's field database
 * (and, for the water pump reset, the community DDT4All script). Config tweaks
 * that float around forums (auto door locking, DRL behaviour, mirror folding)
 * are deliberately NOT included: their write requests differ per BCM software
 * version and blindly replaying them can misconfigure the car — use DDT4All
 * with the correct XML for your ECU, or the Pro console, if you need those.
 */
import { Screen } from './screens.js';
import { el, section } from '../ui/widgets.js';

/* ---------- shared helpers ---------- */

function makeLog() {
  const root = el('div', { class: 'console mono', style: 'height:160px' });
  const line = (cls, text) => {
    root.append(el('div', { class: cls }, text));
    root.scrollTop = root.scrollHeight;
  };
  return { root, line };
}

/** Perform one diag request and decode every field of its response. */
async function readGroup(ctx, frameIdHex, requestId) {
  const ecu = ctx.db.ecuByFromId(frameIdHex);
  const entry = ctx.db.registry.diagRequests.get(`${frameIdHex}.${requestId}`);
  const payload = await ctx.elm.requestIsoTp(ecu, requestId, { timeout: 5000 });
  if (entry) {
    let bin = '';
    for (const c of payload) bin += parseInt(c, 16).toString(2).padStart(4, '0');
    for (const f of ctx.db.registry.fieldsForResponse(frameIdHex, entry.responseId)) {
      f.decodeFromBinaryString(bin);
    }
  }
  return payload;
}

const fmt = (ctx, sid, dec = null) => {
  const f = ctx.db.registry.getBySid(sid);
  if (!f || f.value == null || Number.isNaN(f.value)) return null;
  if (typeof f.value === 'string') return f.value;
  return dec == null ? f.format() : f.value.toFixed(dec);
};
const num = (ctx, sid) => {
  const f = ctx.db.registry.getBySid(sid);
  return f && typeof f.value === 'number' ? f.value : NaN;
};

function reportTable() {
  const table = el('table', { class: 'table' });
  const rows = [];
  return {
    root: el('div', { class: 'scroll-x' }, table),
    add(label, value, note = '') {
      rows.push([label, value ?? '—', note]);
      table.append(el('tr', {},
        el('td', {}, label),
        el('td', { class: 'mono' }, value ?? '—'),
        el('td', { class: 'hint' }, note)));
    },
    clear() { rows.length = 0; table.replaceChildren(); },
    text(title) {
      return `${title}\n${new Date().toISOString()}\n` +
        rows.map(r => `${r[0]}: ${r[1]}${r[2] ? '  (' + r[2] + ')' : ''}`).join('\n');
    },
  };
}

function runGuard(ctx, log) {
  return async fn => {
    if (!ctx.elm.initialized) { log.line('err', '! connect to the car first'); return; }
    await ctx.poller.pause();
    try { await fn(); } catch (e) { log.line('err', '! ' + e.message); }
    finally { ctx.poller.resume(); }
  };
}

function copyButton(getText) {
  const btn = el('button', { class: 'btn', onclick: async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = 'Copy report'; }, 1500);
    } catch (_) { prompt('Copy the report:', getText()); }
  } }, 'Copy report');
  return btn;
}

/* ---------- 1. HV battery health report (the ZE40 special) ---------- */

function batteryReportCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const table = reportTable();

  const runBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    log.line('tx', '> reading LBC + EVC battery data…');
    for (const req of [['7bb', '2101'], ['7bb', '2103'], ['7bb', '2104'], ['7bb', '2141'],
      ['7bb', '2142'], ['7bb', '2107'], ['7bb', '2161'], ['7bb', '2162'], ['7bb', '2166'],
      ['7ec', '223206'], ['7ec', '223203'], ['7ec', '223204']]) {
      try { await readGroup(ctx, req[0], req[1]); log.line('rx', `< ${req[1]} ok`); }
      catch (e) { log.line('err', `! ${req[1]}: ${e.message}`); }
    }

    // cell statistics from all 96 cells
    const cells = [];
    for (let i = 0; i < 96; i++) {
      const v = num(ctx, i < 62 ? `7bb.6141.${16 + 16 * i}` : `7bb.6142.${16 + 16 * (i - 62)}`);
      if (!Number.isNaN(v) && v > 0.5) cells.push(v);
    }
    const min = Math.min(...cells), max = Math.max(...cells);
    const spreadMv = cells.length ? (max - min) * 1000 : NaN;
    let balancing = 0;
    for (let i = 0; i < 96; i++) {
      if (num(ctx, `7bb.6107.${16 + 8 * i}`) > 0) balancing++;
    }
    const soh = num(ctx, '7ec.623206.24');
    const sohNote = soh >= 90 ? 'good' : soh >= 80 ? 'fair — normal ageing' : soh > 0 ? 'significantly degraded' : '';
    const spreadNote = !cells.length ? '' : spreadMv < 30 ? 'excellent balance'
      : spreadMv < 60 ? 'acceptable' : 'high — possible weak cell or pending balancing';

    table.add('State of health (SOH)', fmt(ctx, '7ec.623206.24') && fmt(ctx, '7ec.623206.24') + ' %', sohNote);
    table.add('Real SOC', fmt(ctx, '7bb.6103.192') && fmt(ctx, '7bb.6103.192') + ' %');
    table.add('Pack voltage / current', `${fmt(ctx, '7ec.623203.24') ?? '—'} V / ${fmt(ctx, '7ec.623204.24') ?? '—'} A`);
    table.add('Cells read', cells.length ? `${cells.length} / 96` : null);
    table.add('Cell min / max', cells.length ? `${min.toFixed(3)} / ${max.toFixed(3)} V` : null);
    table.add('Cell spread', cells.length ? spreadMv.toFixed(0) + ' mV' : null, spreadNote);
    table.add('Cells balancing now', String(balancing));
    table.add('Max charge power', fmt(ctx, '7bb.6101.336') && fmt(ctx, '7bb.6101.336') + ' kW');
    table.add('Avg battery temperature', fmt(ctx, '7bb.6104.600') && fmt(ctx, '7bb.6104.600') + ' °C');
    table.add('Battery distance', fmt(ctx, '7bb.6161.96', 0) && fmt(ctx, '7bb.6161.96', 0) + ' km');
    table.add('Energy delivered (lifetime)', fmt(ctx, '7bb.6161.120', 0) && fmt(ctx, '7bb.6161.120', 0) + ' kWh');
    table.add('Battery serial', fmt(ctx, '7bb.6162.16'));
    table.add('Full / partial charges', `${fmt(ctx, '7bb.6166.48', 0) ?? '—'} / ${fmt(ctx, '7bb.6166.64', 0) ?? '—'}`);
    log.line('rx', '✓ report ready');
  }) }, 'Generate report');

  return section('HV battery health report (ZE40 check)',
    el('p', { class: 'hint' },
      'One-shot deep battery check: SOH, all 96 cell voltages with spread analysis, balancing activity, ' +
      'lifetime counters and serial number. Ideal when buying/selling a used ZE40 or arguing a warranty case. Read-only — always safe.'),
    el('div', { class: 'toolbar' }, runBtn, copyButton(() => table.text('ZoeWeb battery health report'))),
    table.root, log.root);
}

/* ---------- 2. 12V battery & DC-DC converter check ---------- */

function aux12vCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const table = reportTable();

  const runBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    for (const req of [['7ec', '222005'], ['7ec', '223024'], ['7ec', '223025'], ['7ec', '223023']]) {
      try { await readGroup(ctx, req[0], req[1]); } catch (e) { log.line('err', `! ${req[1]}: ${e.message}`); }
    }
    const v = num(ctx, '7ec.622005.24');
    const note = Number.isNaN(v) ? '' :
      v >= 13.2 ? 'DC-DC charging — normal with ignition on' :
      v >= 12.4 ? 'resting voltage OK (DC-DC not active?)' :
      v >= 11.8 ? 'LOW — charge or replace the 12V battery soon' :
      'CRITICAL — the car may fail to wake up';
    table.add('12V battery voltage', fmt(ctx, '7ec.622005.24') && fmt(ctx, '7ec.622005.24') + ' V', note);
    table.add('DC-DC output voltage', fmt(ctx, '7ec.623024.24') && fmt(ctx, '7ec.623024.24') + ' V');
    table.add('DC-DC output current', fmt(ctx, '7ec.623025.24') && fmt(ctx, '7ec.623025.24') + ' A');
    table.add('14V voltage setpoint', fmt(ctx, '7ec.623023.24') && fmt(ctx, '7ec.623023.24') + ' V');
    log.line('rx', '✓ done');
  }) }, 'Check 12V system');

  return section('12V battery & DC-DC check',
    el('p', { class: 'hint' },
      'The single most common Zoe breakdown is a tired 12V battery. This reads the actual 12V voltage and what ' +
      'the DC-DC converter is doing. Best done twice: once with the car OFF-but-awake, once READY. Read-only.'),
    el('div', { class: 'toolbar' }, runBtn),
    table.root, log.root);
}

/* ---------- 3. TPMS reference pressures ---------- */

const WHEELS = [
  ['AVG', 'Front left'], ['AVD', 'Front right'], ['ARG', 'Rear left'], ['ARD', 'Rear right'],
];

function tpmsCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const table = reportTable();

  const runBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    await readGroup(ctx, '765', '216d').catch(e => log.line('err', '! 216d: ' + e.message));
    await readGroup(ctx, '765', '2171').catch(() => {});
    // current reference pressures start at bit 104, customer refs at 168; temps at 136
    WHEELS.forEach(([code, label], i) => {
      const cur = num(ctx, `765.616d.${104 + 8 * i}`);
      const cust = num(ctx, `765.616d.${168 + 8 * i}`);
      const temp = num(ctx, `765.616d.${136 + 8 * i}`);
      table.add(`${label} (${code})`,
        Number.isNaN(cur) ? null : `${(cur / 1000).toFixed(2)} bar`,
        (Number.isNaN(cust) ? '' : `customer ref ${(cust / 1000).toFixed(2)} bar`) +
        (Number.isNaN(temp) ? '' : `, ${temp.toFixed(0)} °C`));
    });
    const state = fmt(ctx, '765.6171.16');
    if (state != null) table.add('TPMS state', state);
    log.line('rx', '✓ done');
  }) }, 'Read TPMS data');

  return section('TPMS reference pressures',
    el('p', { class: 'hint' },
      'Shows the pressure references the BCM has learned per wheel — useful after a seasonal wheel swap or when ' +
      'chasing a phantom pressure warning. Learning NEW sensor IDs still needs a TPMS tool or DDT4All with your ' +
      'exact BCM file. Read-only.'),
    el('div', { class: 'toolbar' }, runBtn),
    table.root, log.root);
}

/* ---------- 4. Charging system quick check ---------- */

const CHARGE_CHAIN = ['BCB-OBC', 'EVC', 'LBC'];

function chargeFixCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const results = el('div', {});

  const scan = () => exec(async () => {
    results.replaceChildren();
    let total = 0;
    for (const mn of CHARGE_CHAIN) {
      const ecu = ctx.db.ecuByMnemonic(mn);
      if (!ecu) continue;
      try {
        const dtcs = await ctx.uds.readDtcs(ecu);
        const faults = dtcs.filter(d => d.active);
        total += faults.length;
        log.line(faults.length ? 'err' : 'rx',
          `${mn}: ${faults.length} actual fault(s)` +
          (dtcs.length > faults.length ? ` (${dtcs.length - faults.length} self-tests not yet run — ignorable)` : ''));
        for (const d of faults) {
          results.append(el('p', { class: 'hint' }, `${mn} — DF ${d.code}.${d.failureType} ${d.name} [${d.statusText}]`));
        }
      } catch (e) { log.line('err', `! ${mn}: ${e.message}`); }
    }
    log.line(total ? 'err' : 'rx', total ? `${total} actual fault(s) in the charging chain` : '✓ charging chain clean — anything listed as "not yet run" is normal');
  });

  const scanBtn = el('button', { class: 'btn', onclick: scan }, 'Scan charging chain');
  const clearBtn = el('button', { class: 'btn danger', onclick: async () => {
    if (!confirm('Clear stored DTCs on BCB-OBC + EVC + LBC?\n\nNote the codes first (they help diagnose a bad ' +
      'charge point vs. a car problem). Persistent faults will come back on the next charge attempt.')) return;
    await exec(async () => {
      for (const mn of CHARGE_CHAIN) {
        const ecu = ctx.db.ecuByMnemonic(mn);
        if (!ecu) continue;
        try { await ctx.uds.clearDtcs(ecu); log.line('rx', `${mn}: cleared`); }
        catch (e) { log.line('err', `! ${mn}: ${e.message}`); }
      }
    });
    await scan();
  } }, 'Clear charging DTCs ⚠');

  return section('Charging problems quick check',
    el('p', { class: 'hint' },
      'After a failed charge ("charging impossible", red ZE light) the charger (BCB), vehicle controller (EVC) and ' +
      'battery (LBC) often hold stored faults that keep the car refusing some charge points. This scans all three ' +
      'at once and can clear them after you have noted the codes.'),
    el('div', { class: 'toolbar' }, scanBtn, clearBtn),
    results, log.root);
}

/* ---------- 5. ECU identification report ---------- */

function ecuIdCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const table = reportTable();

  const runBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    for (const ecu of ctx.db.ecus.filter(e => e.addressable && e.mnemonic && e.mnemonic !== '-')) {
      try {
        const p = await ctx.elm.requestIsoTp(ecu, '2180', { timeout: 3000 });
        // 6180 layout: supplier ASCII @ bytes 8-10, soft @ 16-17, version @ 18-19
        const ascii = (a, b) => p.substring(a * 2, b * 2).replace(/../g, h => {
          const c = parseInt(h, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '';
        });
        const soft = p.substring(32, 36), ver = p.substring(36, 40);
        table.add(`${ecu.name} (${ecu.mnemonic})`,
          `soft ${soft || '—'} / ver ${ver || '—'}`,
          ascii(8, 11) ? 'supplier ' + ascii(8, 11) : '');
        log.line('rx', `${ecu.mnemonic} ok`);
      } catch (e) {
        table.add(`${ecu.name} (${ecu.mnemonic})`, null, 'no answer');
      }
    }
    log.line('rx', '✓ scan complete');
  }) }, 'Scan ECU versions');

  return section('ECU identification report',
    el('p', { class: 'hint' },
      'Reads software/version numbers of every reachable ECU. Save one before a dealer visit and compare after — ' +
      'you will know exactly what they reflashed. Read-only.'),
    el('div', { class: 'toolbar' }, runBtn, copyButton(() => table.text('ZoeWeb ECU identification report'))),
    table.root, log.root);
}

/* ---------- 6. Water pump counter reset (unchanged procedure) ---------- */

function waterPumpCard(ctx) {
  const reads = [
    { did: '3349', label: 'WEP hours @ low speed' },
    { did: '334a', label: 'WEP hours @ middle speed' },
    { did: '334b', label: 'WEP hours @ high speed' },
    { did: '3531', label: 'WEP ON timer' },
  ];
  const ecu = ctx.db.ecuByMnemonic('EVC');
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const valueCells = new Map();
  const table = el('table', { class: 'table' },
    el('tr', {}, el('th', {}, 'Counter'), el('th', {}, 'DID'), el('th', {}, 'Raw value')));
  for (const r of reads) {
    const td = el('td', { class: 'mono' }, '—');
    valueCells.set(r.did, td);
    table.append(el('tr', {}, el('td', {}, r.label), el('td', { class: 'mono' }, r.did.toUpperCase()), td));
  }

  const readCounters = () => exec(async () => {
    await ctx.uds.startSession(ecu).catch(() => {});
    for (const r of reads) {
      try {
        const payload = await ctx.uds.raw(ecu, '22' + r.did);
        const hex = payload.substring(6);
        valueCells.get(r.did).textContent = `${hex} (${parseInt(hex, 16)})`;
        log.line('rx', `${r.did.toUpperCase()} = ${hex}`);
      } catch (e) {
        valueCells.get(r.did).textContent = 'error';
        log.line('err', `! ${r.did.toUpperCase()}: ${e.message}`);
      }
    }
  });

  const resetBtn = el('button', { class: 'btn danger', onclick: async () => {
    const answer = prompt(
      '⚠️ Reset the water pump counters on the EVC?\n\n' +
      'Do this ONLY after replacing the pump or verifying it runs. Car stationary, ignition on, NOT charging.\n\n' +
      'The current values above are your rollback record. Type EVC to confirm:');
    if (answer?.trim().toUpperCase() !== 'EVC') { log.line('err', '! cancelled'); return; }
    await exec(async () => {
      log.line('tx', '> extended diagnostic session');
      await ctx.uds.startSession(ecu);
      for (const did of ['3349', '334a', '334b', '3531']) {
        log.line('tx', `> 2E ${did.toUpperCase()} 00000000`);
        await ctx.uds.writeDid(ecu, did, '00000000');
        log.line('rx', '< ok');
      }
      log.line('tx', '> clear stored DTCs (14 FFFFFF)');
      await ctx.uds.clearDtcs(ecu).catch(e => log.line('err', '! DTC clear: ' + e.message));
      log.line('rx', '✓ done — verifying…');
    });
    await readCounters();
    log.line('rx', '✓ finished. If the dash warning persists, drive a short cycle and re-check DTCs.');
  } }, 'Reset counters ⚠');

  return section('Water pump counter reset — "Check Electric System"',
    el('p', { class: 'hint' },
      'The electric water pump (WEP) has programmed wear counters in the EVC. When one exceeds its limit the dash ' +
      'shows "Check Electric System" (DTC 0463) even if the pump works. After REPLACING the pump (or verifying it truly ' +
      'runs), reset the counters — same operations dealers and DDT4All perform. Resetting without checking the pump ' +
      'only hides a real warning: a seized pump can overheat the motor and charger.'),
    el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: readCounters }, 'Read counters'), resetBtn),
    el('div', { class: 'scroll-x' }, table), log.root);
}

/* ---------- 7. Odometer / mileage check ---------- */

function odometerCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const table = reportTable();

  const runBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    const tdb = ctx.db.ecuByMnemonic('TDB');
    if (tdb) await ctx.uds.startSession(tdb).catch(() => {});
    for (const req of [['7ec', '222006'], ['763', '220206'], ['763', '220104'],
      ['763', '222604'], ['763', '222605'], ['7bb', '2161']]) {
      try { await readGroup(ctx, req[0], req[1]); }
      catch (e) { log.line('err', `! ${req[0]} ${req[1]}: ${e.message}`); }
    }
    const evc = num(ctx, '7ec.622006.24');
    const dash = num(ctx, '763.620206.24');
    const unit = num(ctx, '763.620104.24');
    const diff = dash - evc;
    const ratio = dash / evc;

    let verdict = '';
    if (!Number.isNaN(evc) && !Number.isNaN(dash)) {
      if (Math.abs(diff) < 150) {
        verdict = 'EVC and cluster agree — the stored mileage is consistent. If the DISPLAY still looks wrong, ' +
          'suspect the km/miles unit setting below or a cluster display/segment fault.';
      } else if (ratio > 1.55 && ratio < 1.67) {
        verdict = 'Cluster value ≈ EVC × 1.61 — the cluster is counting/displaying MILES as if they were km (unit mismatch).';
      } else if (ratio > 0.60 && ratio < 0.645) {
        verdict = 'Cluster value ≈ EVC × 0.62 — unit mismatch the other way (km shown where miles are expected).';
      } else if (diff > 0) {
        verdict = 'Cluster shows MORE than the true (EVC) mileage — typical of a second-hand cluster from a ' +
          'higher-mileage car. Odometers can only count UP (anti-fraud), so this cannot be corrected down: ' +
          'the fix is a cluster with lower mileage, recalibrated by a dealer.';
      } else {
        verdict = 'Cluster shows LESS than the true (EVC) mileage — it can legitimately be recalibrated UP to the ' +
          'EVC value by a dealer (CLIP) or with DDT4All using the XML for your exact cluster.';
      }
    }

    table.add('True mileage (EVC)', Number.isNaN(evc) ? null : evc.toFixed(0) + ' km', 'the authoritative counter');
    table.add('Cluster odometer (dash)', Number.isNaN(dash) ? null : dash.toFixed(0) + ' km', verdict);
    table.add('Difference', Number.isNaN(diff) ? null : `${diff > 0 ? '+' : ''}${diff.toFixed(0)} km`);
    table.add('Display unit setting', Number.isNaN(unit) ? null : (unit === 16 ? 'Miles' : unit === 0 ? 'Km' : `raw ${unit}`),
      'readable via Pro console: 22 0104 on the cluster');
    table.add('HV battery mileage (LBC)', fmt(ctx, '7bb.6161.96', 0) && fmt(ctx, '7bb.6161.96', 0) + ' km',
      'a third, independent counter — big gaps hint at swapped parts');
    table.add('Odo before ABS→cluster resync', fmt(ctx, '763.622605.24', 0) && fmt(ctx, '763.622605.24', 0) + ' km');
    table.add('Odo before cluster→ABS resync', fmt(ctx, '763.622604.24', 0) && fmt(ctx, '763.622604.24', 0) + ' km');
    log.line('rx', '✓ comparison ready');
  }) }, 'Compare odometers');

  return section('Odometer / mileage check',
    el('p', { class: 'hint' },
      'The Zoe keeps mileage in several places: the EVC (authoritative), the instrument cluster (what the dash shows), ' +
      'and the battery controller. This compares them and diagnoses why the dash may show the wrong number. Read-only. ' +
      'Note: correcting a cluster is only legitimate UP to the true EVC value — lowering an odometer is fraud in most countries.'),
    el('div', { class: 'toolbar' }, runBtn, copyButton(() => table.text('ZoeWeb odometer comparison'))),
    table.root, log.root);
}

/* ---------- 8. Cluster preferences & feature flags ---------- */

/*
 * One-byte configuration DIDs of the Zoe Ph1 instrument cluster (TDB), taken
 * verbatim from CanZE's TDB database ("Config Generale_*") — the same
 * parameters DDT4All's TdB screens flip. Read = 22 01xx, write = 2E 01xx
 * <byte> in an extended session, always verified by read-back.
 */
const CLUSTER_PREFS = [
  { did: '0121', label: 'Clock on cluster', values: [[0, 'Off (factory)'], [16, '12-hour'], [32, '24-hour']] },
  { did: '0122', label: 'Outside temperature display', values: [[0, 'Off'], [16, 'On (factory)']] },
  { did: '0104', label: 'Distance unit', values: [[0, 'km'], [16, 'miles']] },
  { did: '0107', label: 'Tire pressure unit', values: [[0, 'bar'], [16, 'PSI']] },
  { did: '0116', label: 'Indicator (blinker) sound', values: [[0, 'Standard'], [16, 'Tuned']] },
  { did: '010f', label: 'Overspeed warning', values: [[0, 'Off'], [16, 'On']] },
  { did: '0119', label: 'Rear wiper on reverse gear', values: [[0, 'Off'], [16, 'On']] },
  { did: '0101', label: 'Cluster language', values: [
    [0, 'Français'], [16, 'English'], [32, 'Italiano'], [48, 'Deutsch'], [64, 'Español'],
    [80, 'Nederlands'], [96, 'Português'], [112, 'Türkçe'], [128, 'Polski'], [145, 'Svenska'],
    [146, 'Suomi'], [147, 'Български'], [149, 'Ελληνικά'], [150, 'Română'], [151, 'Magyar'],
    [152, 'Slovenčina'], [153, 'Čeština'], [154, 'Dansk'], [158, 'Hrvatski']] },
];

/*
 * Feature-presence flags: they tell the cluster which systems the car has.
 * "TPMS = Without" is the classic winter-wheels-without-sensors tweak — the
 * cluster stops monitoring and warning. Wrong values here can log a
 * "configuration error" DTC on the cluster (harmless, clearable) — always
 * reversible by writing the old value back.
 */
const CLUSTER_FEATURES = [
  { did: '010e', label: 'TPMS (tire pressure monitoring)', values: [[0, 'Without (disabled)'], [16, 'With, no reset strategy'], [32, 'With, reset strategy']] },
  { did: '0108', label: 'Cruise control / speed limiter', values: [[0, 'None'], [16, 'Cruise + limiter'], [32, 'ACC + limiter'], [48, 'Limiter only']] },
  { did: '010d', label: 'Park assist (UPA)', values: [[0, 'None'], [16, 'Front + rear'], [32, 'Rear only']] },
  { did: '010c', label: 'Climate control', values: [[0, 'Without'], [16, 'With']] },
  { did: '0102', label: 'Heated seats', values: [[0, 'Without'], [16, 'With']] },
  { did: '0110', label: 'Telematics unit (TCU)', values: [[0, 'Without'], [16, 'With']] },
  { did: '0111', label: 'Automatic headlights (ALS)', values: [[0, 'Without'], [16, 'With']] },
  { did: '0129', label: 'Navigation (R-Link/MFD)', values: [[0, 'Without'], [16, 'With']] },
];

function tdbPrefsCard(ctx, title, hint, prefs) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const tdb = () => ctx.db.ecuByMnemonic('TDB');
  const rows = new Map(); // did → {cur, sel}

  const readByte = async did => {
    const p = await ctx.uds.raw(tdb(), '22' + did);
    return parseInt(p.substring(6, 8), 16);
  };
  const nameOf = (pref, v) => (pref.values.find(x => x[0] === v) || [v, 'raw ' + v])[1];

  const readAll = () => exec(async () => {
    await ctx.uds.startSession(tdb()).catch(() => {});
    for (const pref of prefs) {
      const r = rows.get(pref.did);
      try {
        const v = await readByte(pref.did);
        r.cur.textContent = nameOf(pref, v);
        r.sel.value = String(v);
        log.line('rx', `${pref.label}: ${nameOf(pref, v)}`);
      } catch (e) {
        r.cur.textContent = 'error';
        log.line('err', `! ${pref.label}: ${e.message}`);
      }
    }
  });

  const table = el('table', { class: 'table' },
    el('tr', {}, el('th', {}, 'Setting'), el('th', {}, 'Current'), el('th', {}, 'New value'), el('th', {}, '')));
  for (const pref of prefs) {
    const cur = el('td', { class: 'mono' }, '—');
    const sel = el('select', { class: 'input' });
    for (const [v, label] of pref.values) sel.append(el('option', { value: String(v) }, label));
    const apply = el('button', { class: 'btn danger', onclick: async () => {
      const v = parseInt(sel.value, 10);
      if (!confirm(`Write "${pref.label}" = ${nameOf(pref, v)} to the instrument cluster?\n\n` +
        'Same one-byte configuration write DDT4All performs. The previous value stays in the ' +
        'log for rollback. Ignition on, car stationary.')) return;
      await exec(async () => {
        await ctx.uds.startSession(tdb());
        const before = await readByte(pref.did).catch(() => null);
        log.line('tx', `> ${pref.label}: ${before === null ? '?' : nameOf(pref, before)} → ${nameOf(pref, v)} (2E ${pref.did} ${v.toString(16).padStart(2, '0')})`);
        await ctx.uds.writeDid(tdb(), pref.did, v.toString(16).padStart(2, '0'));
        const after = await readByte(pref.did);
        cur.textContent = nameOf(pref, after);
        log.line(after === v ? 'rx' : 'err',
          after === v ? `✓ verified: ${nameOf(pref, after)} — cycle the ignition to see it on the dash`
                      : `! read-back shows ${nameOf(pref, after)} — the cluster refused or remapped the value`);
      });
    } }, 'Apply ⚠');
    rows.set(pref.did, { cur, sel });
    table.append(el('tr', {}, el('td', {}, pref.label), cur, el('td', {}, sel), el('td', {}, apply)));
  }

  return section(title,
    el('p', { class: 'hint' }, hint),
    el('div', { class: 'toolbar' }, el('button', { class: 'btn', onclick: readAll }, 'Read current settings')),
    el('div', { class: 'scroll-x' }, table), log.root);
}

const clusterPrefsCard = ctx => tdbPrefsCard(ctx,
  'Cluster preferences — clock, temperature, units',
  'The famous DDT4All cluster tweaks: enable the clock and outside temperature on the dash, switch units or ' +
  'language, overspeed beep, rear wiper on reverse, indicator sound. Each write is verified by read-back and ' +
  'can always be written back. Read the current values first.',
  CLUSTER_PREFS);

const clusterFeaturesCard = ctx => tdbPrefsCard(ctx,
  'Cluster feature flags — TPMS and equipment',
  'Tells the cluster which systems the car has. Setting TPMS to "Without" silences tire-pressure monitoring — ' +
  'the classic winter-wheels-without-sensors tweak (remember to set it back in spring: you lose puncture ' +
  'warnings while it is off). A wrong equipment flag can log a clearable "config error" DTC on the cluster; ' +
  'everything here is reversible by writing the old value back.',
  CLUSTER_FEATURES);

/* ---------- 9. Android Auto on R-Link ---------- */

/*
 * The R-Link ADAS configuration byte (DID 6C1C, after-sales session 10C0) is
 * what DDT4All's "ECU Configuration ADAS" screen writes; C4 and E4 are the two
 * community-known "Android Auto enabled" values (variant dependent). The unit
 * lives on the multimedia CAN (OBD pins 12/13) — reachable only through a
 * rewired extension cable (ELM pin 6 → car pin 13, ELM pin 14 → car pin 12).
 */
function androidAutoCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  let ecu = null;
  let original = null;

  const reqIn = el('input', { class: 'input mono', placeholder: 'req id', style: 'min-width:70px;width:80px' });
  const respIn = el('input', { class: 'input mono', placeholder: 'resp id', style: 'min-width:70px;width:80px' });
  const current = el('span', { class: 'mono' }, '—');

  const makeEcu = (requestId, responseId) => ({
    toIdHex: requestId, fromIdHex: responseId, isExtended: false,
    sessionRequestId: '10c0', startDiag: '50c0', dtcResponseIds: [],
    mnemonic: 'R-LINK', name: 'R-Link (MFD)',
  });

  const scanBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    log.line('tx', '> scanning the bus for a diagnostic responder (this only works through the rewired cable)…');
    await ctx.elm.probeBegin();
    ecu = null;
    try {
      const ranges = [];
      for (let id = 0x700; id <= 0x7ff; id++) ranges.push(id);
      for (let id = 0x600; id <= 0x6ff; id++) ranges.push(id);
      for (let i = 0; i < ranges.length; i++) {
        const idHex = ranges[i].toString(16);
        if (i % 32 === 0) log.line('hint', `… probing 0x${idHex}`);
        const hit = await ctx.elm.probeId(idHex).catch(() => null);
        if (hit) {
          ecu = makeEcu(hit.requestId, hit.responseId);
          reqIn.value = hit.requestId;
          respIn.value = hit.responseId;
          log.line('rx', `✓ found a responder: request ${hit.requestId} / response ${hit.responseId}`);
          const known = ctx.db.ecus.find(e => e.toIdHex === hit.requestId || e.fromIdHex === hit.responseId);
          if (known) {
            log.line('err', `! ${hit.requestId} is the ${known.name} (${known.mnemonic}) — you are on the NORMAL ` +
              'diagnostic bus, not the multimedia bus. Check the rewired cable; do NOT write here.');
          }
          break;
        }
      }
      if (!ecu) log.line('err', '! nothing answered. Is the rewired cable in place and the R-Link awake (screen on)?');
    } finally {
      await ctx.elm.probeEnd();
    }
  }) }, 'Scan for R-Link');

  const useManual = () => {
    const r = reqIn.value.trim().toLowerCase(), a = respIn.value.trim().toLowerCase();
    if (/^[0-9a-f]{3}$/.test(r) && /^[0-9a-f]{3}$/.test(a)) ecu = makeEcu(r, a);
    return ecu;
  };

  const readBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    if (!useManual()) { log.line('err', '! scan first, or enter the request/response ids'); return; }
    await ctx.uds.startSession(ecu);
    const p = await ctx.uds.raw(ecu, '226c1c');
    original = p.substring(6);
    current.textContent = original.toUpperCase();
    log.line('rx', `ADAS config (6C1C) = ${original.toUpperCase()} — kept as rollback value`);
  }) }, 'Read ADAS config');

  const writeVal = val => exec(async () => {
    if (!useManual()) { log.line('err', '! scan first, or enter the request/response ids'); return; }
    if (original === null) { log.line('err', '! read the ADAS config first — a unit that cannot answer 22 6C1C is not an R-Link and must not be written to'); return; }
    if (!confirm(`Write ADAS config (6C1C) = ${val.toUpperCase()} to the R-Link?\n\n` +
      'Same write DDT4All performs for "Android Auto feature = Present". If this firmware variant refuses, ' +
      'nothing is changed. Afterwards press the R-Link Home button 5× to restart it.')) return;
    await ctx.uds.startSession(ecu);
    await ctx.uds.writeDid(ecu, '6c1c', val);
    const back = (await ctx.uds.raw(ecu, '226c1c')).substring(6, 6 + val.length);
    current.textContent = back.toUpperCase();
    log.line(back === val ? 'rx' : 'err', back === val
      ? `✓ verified ${back.toUpperCase()} — restart the R-Link (Home 5×), then plug the phone in via USB`
      : `! read-back shows ${back.toUpperCase()}`);
  });

  const writeC4 = el('button', { class: 'btn danger', onclick: () => writeVal('c4') }, 'Enable AA (C4) ⚠');
  const writeE4 = el('button', { class: 'btn danger', onclick: () => writeVal('e4') }, 'Enable AA (E4) ⚠');
  const restore = el('button', { class: 'btn', onclick: () => {
    if (!original) { log.line('err', '! read the config first — there is nothing to restore'); return; }
    writeVal(original);
  } }, 'Restore original');

  return section('Android Auto on R-Link (ZE40)',
    el('p', { class: 'hint' },
      'Needs the rewired OBD extension cable (ELM pin 6 → car pin 13, pin 14 → car pin 12: the multimedia CAN) ' +
      'and up-to-date R-Link firmware. Flow: scan → read current config → enable (try C4 first; E4 is the ' +
      'alternate variant) → restart R-Link with 5× Home. A firmware that refuses the write changes nothing.'),
    el('div', { class: 'toolbar' }, scanBtn, reqIn, respIn, readBtn, el('span', { class: 'hint' }, 'ADAS config:'), current),
    el('div', { class: 'toolbar' }, writeC4, writeE4, restore),
    log.root);
}

/* ---------- screen ---------- */

export class ServiceScreen extends Screen {
  constructor() { super('service', 'Service', '🔧'); }

  render(c, ctx) {
    if (ctx.db.carKey !== 'ZOE') {
      c.append(section('Service procedures',
        el('p', { class: 'hint' },
          `The guided procedures target the Zoe Ph1 / ZE40 and are not yet verified for ${ctx.db.car.label}. ` +
          'Switch the car model in Settings if that is your car; otherwise use Fault codes, All data and the Pro console.')));
      return;
    }
    c.append(
      batteryReportCard(ctx),
      aux12vCard(ctx),
      chargeFixCard(ctx),
      waterPumpCard(ctx),
      odometerCard(ctx),
      tpmsCard(ctx),
      clusterPrefsCard(ctx),
      clusterFeaturesCard(ctx),
      androidAutoCard(ctx),
      ecuIdCard(ctx),
    );
  }
}
