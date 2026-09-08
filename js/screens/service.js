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
import { journaledWrite } from '../core/journal.js';

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

/* ---------- 4b. Cluster self-test (lamps / buzzer / display) ---------- */

/*
 * Cluster output self-test, verified against TdB_X10 (KWP service 30 I/O
 * control on 743→763). These are TRANSIENT: they revert when stopped or on
 * the next ignition cycle, so nothing is persisted and no backup is needed.
 *   30012001 all warning lamps on / 30012000 off / 300111 release
 *   30032000 buzzer on / 300311 release
 *   300420FF display test / 300411 release
 */
function clusterTestCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const tdb = () => ctx.db.ecuByMnemonic('TDB');
  let stopper = null;

  const stopAll = () => exec(async () => {
    for (const stop of ['300111', '300311', '300411', '300611']) {
      await ctx.uds.raw(tdb(), stop).catch(() => {});
    }
    if (stopper) { clearTimeout(stopper); stopper = null; }
    log.line('rx', '✓ outputs released — cluster back to normal');
  });

  const run = (onCmd, label) => exec(async () => {
    await ctx.uds.startSession(tdb()).catch(() => {});
    log.line('tx', `> ${label} (10 s)`);
    await ctx.uds.raw(tdb(), onCmd);
    log.line('rx', '< active — watch the dashboard');
    if (stopper) clearTimeout(stopper);
    stopper = setTimeout(() => stopAll(), 10000); // safety auto-stop
  });

  return section('Cluster self-test (lamps, buzzer, display)',
    el('p', { class: 'hint' },
      'Momentarily drives the instrument cluster outputs to check them — light every warning lamp at once ' +
      '(spot a dead LED), sound the buzzer, run the display test. Transient only: everything returns to normal ' +
      'when you press Stop or cycle the ignition. Car stationary.'),
    el('div', { class: 'toolbar' },
      el('button', { class: 'btn', onclick: () => run('30012001', 'all warning lamps ON') }, 'Test warning lamps'),
      el('button', { class: 'btn', onclick: () => run('30032000', 'buzzer ON') }, 'Test buzzer'),
      el('button', { class: 'btn', onclick: () => run('300420ff', 'display test') }, 'Test display'),
      el('button', { class: 'btn danger', onclick: stopAll }, 'Stop')),
    log.root);
}

/* ---------- 4c. TCU / connected-services inspection ---------- */

/*
 * Read-only inspection of the telematics unit (TCU/DCM, 7CA→7DA). Reads a
 * union of the GEN2 and AIVC configuration identifiers (from the DDT TCU
 * files) so it works whichever generation the car has, and shows the SIM,
 * APN and backend-server settings as text. This is the first step for anyone
 * looking into the dead Renault connected-services backend: it reveals what
 * the TCU is, and which backend URL / APN it is pointed at.
 */
const TCU_DIDS = [
  ['22fd1c', 'IMEI (modem id)'],
  ['22fd30', 'GPRS/APN parameters (GEN2)'],
  ['226c10', 'OBS backend URL (GEN2)'],
  ['226d7c', 'KEP server address (GEN2)'],
  ['226d49', 'IP address (GEN2)'],
  ['2185', 'network management (GEN2)'],
  ['22416b', 'backend URL (AIVC)'],
  ['224201', 'eCall URL (AIVC)'],
  ['224100', 'off-board server number (AIVC)'],
  ['220104', 'communication network (AIVC)'],
  ['224006', 'APN 1 profile 1 (AIVC)'],
  ['22400c', 'SIM SMS centre (AIVC)'],
  ['224131', 'WiFi hotspot status (AIVC)'],
];

function tcuCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const table = reportTable();
  const tcu = () => ctx.db.ecuByMnemonic('TCU') || ctx.db.ecuByMnemonic('DCM');

  const ascii = hex => {
    let out = '';
    for (let i = 0; i + 2 <= hex.length; i += 2) {
      const c = parseInt(hex.substring(i, i + 2), 16);
      out += (c >= 32 && c < 127) ? String.fromCharCode(c) : '';
    }
    return out.replace(/\0+$/, '').trim();
  };

  // universal identifiers almost every UDS ECU answers — used to prove the
  // TCU is reachable at all before blaming a specific config DID
  const IDENT_DIDS = [
    ['22f190', 'VIN'], ['22f18c', 'ECU serial number'],
    ['22f1a0', 'diagnostic spec version'], ['22f194', 'supplier ECU sw number'],
  ];

  /** Try to wake a sleeping TCU: tester-present flood + session, a few times. */
  const wake = async ecu => {
    for (let i = 0; i < 5; i++) {
      await ctx.uds.raw(ecu, '3e00', { timeout: 500 }).catch(() => {});
      const ok = await ctx.uds.raw(ecu, '1003', { timeout: 800 }).catch(() =>
        ctx.uds.raw(ecu, '10c0', { timeout: 800 }).catch(() => null));
      if (ok) return true;
    }
    return false;
  };

  const runBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    const ecu = tcu();
    if (!ecu) { log.line('err', '! no TCU in this car database'); return; }

    log.line('tx', '> waking the TCU (tester-present + session)…');
    const awake = await wake(ecu);
    // prove reachability with universal ident DIDs first
    let reachable = awake;
    for (const [did, label] of IDENT_DIDS) {
      try {
        const p = await ctx.uds.raw(ecu, did, { timeout: 2500 });
        const t = ascii(p.substring(4));
        table.add(label, t || p.substring(4).toUpperCase(), '');
        reachable = true;
      } catch (_) {}
    }
    if (!reachable) {
      log.line('err', '! No answer from the TCU.');
      log.line('hint', 'The TCU is on the vehicle CAN and IS reachable on the normal OBD connector (others have ' +
        'read it and hard-reset it with DDT4All). A silent read almost always means it is asleep — put the car in ' +
        'READY (foot on brake, press Start), keep it awake, and run this again. It is NOT the R-Link — no ' +
        'pin-12/13 cable is needed for the TCU.');
      return;
    }
    log.line('rx', '✓ TCU is reachable — reading config…');

    let answered = 0;
    for (const [did, label] of TCU_DIDS) {
      try {
        const payload = await ctx.uds.raw(ecu, did.length === 4 ? '22' + did : did, { timeout: 2500 });
        const data = payload.substring(did.length === 4 ? 4 : 6);
        const text = ascii(data);
        table.add(label, text || data.toUpperCase() || '(empty)', text ? '' : did.toUpperCase());
        answered++;
      } catch (_) { /* DID not on this TCU generation — skip quietly */ }
    }
    log.line('rx', answered
      ? `✓ ${answered} config parameter(s) read — the ones that answered tell you the TCU generation`
      : '· TCU reachable but returned no config values (locked without a security session, or a different generation)');
  }) }, 'Read TCU / SIM config');

  return section('TCU / connected-services inspection (read-only)',
    el('p', { class: 'hint' },
      'Read-only. Reads the telematics unit\u2019s SIM, APN and backend-server settings. The TCU is on the ' +
      'vehicle CAN and is reachable on the normal OBD connector (no R-Link pin-12/13 cable needed); if it does ' +
      'not answer it is usually asleep — put the car in READY and retry. Renault shut down the Zoe\u2019s ' +
      'connected-services backend. For remote pre-heat/climate and status that works today, the proven route is ' +
      'an OVMS module (docs.openvehicles.com, Renault Zoe Ph1). The Zoe TCU is a Ficosa / Sierra Wireless ' +
      'AirPrime unit; the opencarwings project revives Ficosa TCUs on the Nissan Leaf, but Zoe compatibility is ' +
      'unconfirmed. The eCall (emergency) URL is safety-related — leave it alone.'),
    el('div', { class: 'toolbar' }, runBtn, copyButton(() => table.text('ZoeWeb TCU inspection'))),
    table.root, log.root);
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
        await journaledWrite(ctx, ecu, did, '00000000', 'Water pump driving counter ' + did.toUpperCase());
        log.line('rx', '< ok (backed up)');
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
      el('button', { class: 'btn', onclick: readCounters }, 'Read counters'), resetBtn,
      waterPumpExtras(ctx, ecu, log, exec)),
    el('div', { class: 'scroll-x' }, table), log.root);
}

/*
 * Read-only pump health + opt-in charge-pump reset. All DIDs verified against
 * the EVC DDT definition (223386 pump lifetime, 223318/2233E6 driving feedback,
 * 223319/2233E5 charge feedback; charge counters 334D/334E/334F/3530). The
 * tested driving-counter reset above is deliberately left untouched.
 */
function waterPumpExtras(ctx, ecu, log, exec) {
  const checkBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    await ctx.uds.startSession(ecu).catch(() => {});
    for (const [did, label] of [
      ['223386', 'pump lifetime (VPM memory)'],
      ['223318', 'driving pump feedback'],
      ['2233e6', 'driving WEP feedback diag'],
      ['223319', 'charge pump feedback'],
      ['2233e5', 'charge WEP feedback diag'],
    ]) {
      try {
        const hex = (await ctx.uds.raw(ecu, did)).substring(6);
        log.line('rx', `${label}: ${hex} (${parseInt(hex, 16)})`);
      } catch (e) { log.line('err', `! ${did}: ${e.message}`); }
    }
    log.line('hint', 'feedback ≠ 0 while the car is READY means the pump is actually running — verify before resetting');
  }) }, 'Check pump health');

  const chargeBtn = el('button', { class: 'btn danger', onclick: async () => {
    if (!confirm('Also reset the CHARGE-pump wear counters (334D/334E/334F/3530)?\n\n' +
      'A full pump replacement resets these too; the driving-counter reset alone does not touch them. ' +
      'Only after replacing/verifying the pump. Type-to-confirm on the next prompt.')) return;
    const answer = prompt('Type EVC to reset the charge-pump counters:');
    if (answer?.trim().toUpperCase() !== 'EVC') { log.line('err', '! cancelled'); return; }
    await exec(async () => {
      await ctx.uds.startSession(ecu);
      for (const did of ['334d', '334e', '334f', '3530']) {
        log.line('tx', `> 2E ${did.toUpperCase()} 00000000`);
        await journaledWrite(ctx, ecu, did, '00000000', 'Water pump charge counter ' + did.toUpperCase());
        log.line('rx', '< ok (backed up)');
      }
      log.line('rx', '✓ charge-pump counters reset');
    });
  } }, 'Also reset charge pump ⚠');

  return el('span', { class: 'toolbar', style: 'display:contents' }, checkBtn, chargeBtn);
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

/* ---------- 7b. Maintenance / service reminder ---------- */

/*
 * Cluster service-interval reminder (verified against TdB_X10):
 *   22 0201 = configured interval (km @ bytes 0-1, days @ 2-3)
 *   22 0202 = remaining until next service   22 2603 = value shown on dash
 * Resetting after a service = copy the interval (0201) into the current
 * countdown (0202). Uses the car's OWN configured interval, and is journaled.
 */
function maintenanceCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  const tdb = () => ctx.db.ecuByMnemonic('TDB');
  const table = reportTable();
  let initHex = null;

  const parse = hex => ({ km: parseInt(hex.substring(0, 4), 16), days: parseInt(hex.substring(4, 8), 16) });

  const readBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    table.clear();
    await ctx.uds.startSession(tdb()).catch(() => {});
    initHex = (await ctx.uds.raw(tdb(), '220201')).substring(6, 14);
    const cur = (await ctx.uds.raw(tdb(), '220202')).substring(6, 14);
    const i = parse(initHex), c = parse(cur);
    let odo = null;
    try { odo = parseInt((await ctx.uds.raw(tdb(), '220206')).substring(6, 12), 16); } catch (_) {}
    table.add('Service interval (configured)', `${i.km} km / ${i.days} days`);
    table.add('Remaining until service', `${c.km} km / ${c.days} days`,
      c.km <= 0 || c.days <= 0 ? 'DUE now' : '');
    if (odo != null) table.add('Odometer', odo + ' km');
    log.line('rx', `interval=${initHex} current=${cur}`);
  }) }, 'Read service status');

  const resetBtn = el('button', { class: 'btn danger', onclick: async () => {
    if (initHex === null) { log.line('err', '! read the service status first'); return; }
    if (!confirm('Reset the service reminder to a full interval?\n\n' +
      `This sets the countdown to the car's configured ${parse(initHex).km} km / ${parse(initHex).days} days. ` +
      'Do this only after you have actually done the service. Backed up for restore.')) return;
    await exec(async () => {
      await ctx.uds.startSession(tdb());
      await journaledWrite(ctx, tdb(), '0202', initHex, 'Service reminder reset');
      log.line('rx', '✓ service reminder reset — verifying…');
    });
    await readBtn.onclick();
  } }, 'Reset service reminder ⚠');

  return section('Maintenance / service reminder',
    el('p', { class: 'hint' },
      'Reads the cluster\u2019s service-interval countdown and resets it after you service the car (annual ' +
      'service, brake fluid, cabin filter…). The reset uses the interval the car itself is configured with, ' +
      'and is recorded in Backups so it can be undone.'),
    el('div', { class: 'toolbar' }, readBtn, resetBtn),
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
        log.line('tx', `> ${pref.label} → ${nameOf(pref, v)} (2E ${pref.did} ${v.toString(16).padStart(2, '0')})`);
        const hex = await journaledWrite(ctx, tdb(), pref.did, v.toString(16).padStart(2, '0'), 'Cluster: ' + pref.label);
        const after = parseInt(hex, 16);
        cur.textContent = nameOf(pref, after);
        log.line(after === v ? 'rx' : 'err',
          after === v ? `✓ verified: ${nameOf(pref, after)} — backed up (Backups screen); cycle the ignition to see it`
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
 * R-Link (MFD) phone-projection configuration, verified against the official
 * MFD v5.x DDT definitions: diag addresses 747 → 767, byte at DID 6C1C
 * ("DataRead/DataWrite.ECU"), bits MSB-first:
 *   0x80 SPVR iPhone (Siri)   0x40 Android Auto      0x20 MirrorLink
 *   0x10 MW radio band        0x08 LW radio band     0x04 SPVR other phones
 * The classic community value C4 = iPhone + Android Auto + other phones.
 */
const RLINK_BITS = [
  [0x40, 'Android Auto'],
  [0x80, 'SPVR for iPhone (Siri)'],
  [0x04, 'SPVR for other phones (Google Assistant)'],
  [0x20, 'MirrorLink'],
  [0x10, 'MW radio band'],
  [0x08, 'LW radio band'],
];

function androidAutoCard(ctx) {
  const log = makeLog();
  const exec = runGuard(ctx, log);
  let ecu = null;
  let original = null;

  const reqIn = el('input', { class: 'input mono', value: '747', style: 'min-width:70px;width:80px' });
  const respIn = el('input', { class: 'input mono', value: '767', style: 'min-width:70px;width:80px' });

  const makeEcu = (requestId, responseId) => ({
    toIdHex: requestId, fromIdHex: responseId, isExtended: false,
    sessionRequestId: '10c0', startDiag: '50c0', dtcResponseIds: [],
    mnemonic: 'R-LINK', name: 'R-Link (MFD)',
  });

  const useManual = () => {
    const r = reqIn.value.trim().toLowerCase(), a = respIn.value.trim().toLowerCase();
    if (/^[0-9a-f]{3}$/.test(r) && /^[0-9a-f]{3}$/.test(a)) ecu = makeEcu(r, a);
    return ecu;
  };

  const scanBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    log.line('tx', '> scanning the bus (needs the rewired cable; R-Link awake)…');
    await ctx.elm.probeBegin();
    ecu = null;
    try {
      const ids = [0x747, ...Array.from({ length: 0x200 }, (_, i) => 0x600 + i).filter(x => x !== 0x747)];
      for (let i = 0; i < ids.length; i++) {
        const idHex = ids[i].toString(16);
        if (i % 32 === 0) log.line('hint', `… probing 0x${idHex}`);
        const hit = await ctx.elm.probeId(idHex).catch(() => null);
        if (hit) {
          ecu = makeEcu(hit.requestId, hit.responseId);
          reqIn.value = hit.requestId;
          respIn.value = hit.responseId;
          log.line('rx', `✓ responder found: ${hit.requestId} → ${hit.responseId}`);
          const known = ctx.db.ecus.find(e => e.toIdHex === hit.requestId || e.fromIdHex === hit.responseId);
          if (known) {
            log.line('err', `! ${hit.requestId} is the ${known.name} (${known.mnemonic}) — you are on the NORMAL ` +
              'diagnostic bus, not the multimedia bus. Check the rewired cable; do NOT write here.');
          }
          break;
        }
      }
      if (!ecu) log.line('err', '! nothing answered — check the cable and that the R-Link screen is on');
    } finally {
      await ctx.elm.probeEnd();
    }
  }) }, 'Scan for R-Link');

  // bit editor
  const checks = new Map();
  const bitsBox = el('div', { class: 'toolbar', style: 'flex-direction:column;align-items:flex-start;gap:4px' });
  for (const [mask, label] of RLINK_BITS) {
    const cb = el('input', { type: 'checkbox', disabled: '' });
    checks.set(mask, cb);
    bitsBox.append(el('label', { style: 'min-width:0' }, cb, ' ', label));
  }
  const current = el('span', { class: 'mono' }, '—');

  const readBtn = el('button', { class: 'btn', onclick: () => exec(async () => {
    if (!useManual()) { log.line('err', '! enter/scan the ids first'); return; }
    await ctx.uds.startSession(ecu);
    const p = await ctx.uds.raw(ecu, '226c1c');
    original = parseInt(p.substring(6, 8), 16);
    current.textContent = '0x' + original.toString(16).padStart(2, '0').toUpperCase();
    for (const [mask, cb] of checks) { cb.checked = (original & mask) !== 0; cb.disabled = false; }
    log.line('rx', `phone-projection config (6C1C) = ${current.textContent} — kept as rollback value`);
  }) }, 'Read config');

  const presetBtn = el('button', { class: 'btn', onclick: () => {
    if (original === null) { log.line('err', '! read the config first'); return; }
    checks.get(0x40).checked = true;   // Android Auto
    checks.get(0x80).checked = true;   // Siri
    checks.get(0x04).checked = true;   // Google Assistant
    checks.get(0x20).checked = false;  // MirrorLink off (recommended)
    log.line('hint', 'preset applied (the classic "C4" recipe) — press Write to send it');
  } }, 'Preset: enable Android Auto');

  const writeBtn = el('button', { class: 'btn danger', onclick: async () => {
    if (!useManual() || original === null) { log.line('err', '! read the config first'); return; }
    let value = 0;
    for (const [mask, cb] of checks) if (cb.checked) value |= mask;
    const hex = value.toString(16).padStart(2, '0');
    if (!confirm(`Write phone-projection config = 0x${hex.toUpperCase()} to the R-Link?\n\n` +
      `Current value 0x${original.toString(16).padStart(2, '0').toUpperCase()} stays in the log for rollback. ` +
      'Afterwards restart the R-Link (Home button 5×).')) return;
    await exec(async () => {
      await ctx.uds.startSession(ecu);
      const rb = await journaledWrite(ctx, ecu, '6c1c', hex, 'R-Link phone projection (6C1C)');
      const back = parseInt(rb.substring(0, 2), 16);
      current.textContent = '0x' + back.toString(16).padStart(2, '0').toUpperCase();
      log.line(back === value ? 'rx' : 'err', back === value
        ? '✓ verified — restart the R-Link (Home 5×), then connect the phone via USB'
        : `! read-back shows 0x${back.toString(16)} — this firmware refused the write`);
    });
  } }, 'Write config ⚠');

  const restoreBtn = el('button', { class: 'btn', onclick: () => {
    if (original === null) { log.line('err', '! nothing to restore'); return; }
    for (const [mask, cb] of checks) cb.checked = (original & mask) !== 0;
    log.line('hint', 'checkboxes reset to the original value — press Write to send it back');
  } }, 'Restore original');

  return section('Android Auto on R-Link (ZE40)',
    el('p', { class: 'hint' },
      'Configures the R-Link phone projection exactly like DDT4All\u2019s "MFD → ECU Configuration ADAS" screen ' +
      '(verified addresses 747→767, config byte 6C1C). Needs the rewired OBD cable (ELM pin 6 → car pin 13, ' +
      'pin 14 → car pin 12: the multimedia CAN) and up-to-date R-Link firmware. Flow: Read config → tick the ' +
      'features (or use the preset) → Write → restart R-Link with 5× Home.'),
    el('div', { class: 'toolbar' }, scanBtn, reqIn, respIn, readBtn, el('span', { class: 'hint' }, 'config:'), current),
    bitsBox,
    el('div', { class: 'toolbar' }, presetBtn, writeBtn, restoreBtn),
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
      maintenanceCard(ctx),
      tpmsCard(ctx),
      clusterTestCard(ctx),
      clusterPrefsCard(ctx),
      clusterFeaturesCard(ctx),
      androidAutoCard(ctx),
      tcuCard(ctx),
      ecuIdCard(ctx),
    );
  }
}
