/*
 * ZoeWeb — screen framework + the live-data screens replicating CanZE's
 * activities (Dashboard, Driving, Battery, Charging, Range, Climate, Tires,
 * Braking, Consumption).
 */
import { el, tile, gauge, hbar, heatmap, timeplot, section, ringGauge, readout } from '../ui/widgets.js';
import { Sid } from '../core/sid.js';

const fmtN = (v, dec, unit) => Number.isNaN(v) ? '—' : v.toFixed(dec) + unit;

export class Screen {
  constructor(id, title, icon) {
    this.id = id; this.title = title; this.icon = icon;
    this._bindings = [];
  }

  /** Subscribe sid and wire its updates to widget.update(field). */
  bind(ctx, sid, widget, intervalMs = 2000, transform = null) {
    ctx.poller.subscribe(sid, intervalMs, this.id);
    const field = ctx.poller.getField(sid);
    if (!field) { widget.set?.('n/a'); return; }
    const listener = f => widget.update(transform ? transform(f) : f);
    field.listeners.add(listener);
    this._bindings.push({ field, listener });
    if (field.lastUpdated) listener(field);
  }

  mount(container, ctx) { this.render(container, ctx); }

  unmount(ctx) {
    for (const { field, listener } of this._bindings) field.listeners.delete(listener);
    this._bindings.length = 0;
    ctx.poller.clearOwner(this.id);
  }
}

/* ------------------------------------------------------------------ */

export class DashboardScreen extends Screen {
  constructor() { super('dashboard', 'Dashboard', '🏠'); }
  render(c, ctx) {
    this._acquireWakeLock();
    const speed = ringGauge('km/h', 0, 150, 'SPEED', { hud: true });
    const aura = el('div', { class: 'dial-aura' });
    const kw = el('div', { class: 'dial-kw' }, '—');
    speed.root.querySelector('.ring-center').append(kw);
    this._widgets = [speed];

    // power → aura colour/intensity + embedded kW readout, eased for smoothness
    let curP = NaN, shownP = NaN;
    const paint = () => {
      if (!Number.isNaN(curP)) shownP = Number.isNaN(shownP) ? curP : shownP + (curP - shownP) * 0.25;
      if (!Number.isNaN(shownP)) {
        const drive = shownP >= 0;
        const rgb = drive ? '65,176,245' : '65,217,140';
        const mag = Math.min(1, Math.abs(shownP) / 60);
        aura.style.background = `radial-gradient(circle at 50% 45%, rgba(${rgb},${0.06 + mag * 0.4}), rgba(${rgb},0) 60%)`;
        kw.textContent = `${drive ? '▲' : '▼'} ${Math.abs(shownP).toFixed(1)} kW`;
        kw.style.color = drive ? 'var(--accent)' : 'var(--good)';
      }
      this._paintRaf = requestAnimationFrame(paint);
    };
    paint();
    this._widgets.push({ stop: () => cancelAnimationFrame(this._paintRaf) });

    // readouts embedded around the dial
    const avg = readout('Consumption', 'kWh/100km');
    const range = readout('Range', 'km');
    const odo = readout('Odometer', 'km');
    const battery = this.stack(ctx, { title: 'Battery', items: [
      { sid: Sid.UserSoC, unit: '%', dec: 0, interval: 3000 },
      { sid: Sid.HvTemp, unit: '°C', dec: 0, interval: 5000 },
    ] });
    const climate = this.stack(ctx, { items: [
      { sid: Sid.CabinTemp, label: 'Cabin', unit: '°C', dec: 0, interval: 5000 },
      { sid: Sid.OutsideTemp, label: 'Outside', unit: '°C', dec: 0, interval: 5000 },
    ] });

    c.append(
      el('div', { class: 'hud' },
        el('div', { class: 'dial' },
          el('div', { class: 'dial-row top' },
            el('div', { class: 'ro-cell' }, avg.root),
            el('div', { class: 'ro-cell' }, range.root)),
          el('div', { class: 'dial-mid' }, aura, el('div', { class: 'dial-ring' }, speed.root)),
          el('div', { class: 'dial-row bottom' },
            el('div', { class: 'ro-cell' }, battery),
            el('div', { class: 'ro-cell' }, odo.root),
            el('div', { class: 'ro-cell' }, climate)))),
    );

    this.bind(ctx, Sid.RealSpeed, speed, 300, f => f.value);
    // custom power binding drives the aura
    ctx.poller.subscribe(Sid.DcPowerOut, 200, this.id);
    const pf = ctx.poller.getField(Sid.DcPowerOut);
    if (pf) {
      const l = f => { curP = f.value; };
      pf.listeners.add(l);
      this._bindings.push({ field: pf, listener: l });
      if (pf.lastUpdated) curP = pf.value;
    }
    this.bind(ctx, Sid.RangeEstimate, range, 3000);
    this.bind(ctx, Sid.AverageConsumption, avg, 5000);
    this.bind(ctx, Sid.EvcOdometer, odo, 8000);
  }

  /** Values stacked one under the other, with an optional group title and
   *  optional per-line labels. */
  stack(ctx, { title, items }) {
    const root = el('div', { class: 'ro ro-stack' });
    if (title) root.append(el('div', { class: 'ro-label' }, title));
    for (const it of items) {
      const v = el('span', { class: 'ro-val' }, '—');
      const line = el('div', { class: 'ro-lineitem' });
      if (it.label) line.append(el('div', { class: 'ro-sub' }, it.label));
      line.append(el('div', { class: 'ro-row' }, v, el('span', { class: 'ro-unit' }, it.unit)));
      root.append(line);
      this.bind(ctx, it.sid, { update: f => { v.textContent = fmtN(f.value, it.dec, ''); } }, it.interval);
    }
    return root;
  }

  unmount(ctx) {
    for (const w of this._widgets || []) w.stop?.();
    this._releaseWakeLock();
    super.unmount(ctx);
  }

  /** Keep the screen awake while the dashboard is open (Screen Wake Lock API). */
  async _acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      // the lock drops when the tab is hidden — re-acquire on return
      this._visHandler = () => {
        if (document.visibilityState === 'visible' && !this._wakeLock) this._acquireWakeLock();
      };
      document.addEventListener('visibilitychange', this._visHandler);
      this._wakeLock.addEventListener?.('release', () => { this._wakeLock = null; });
    } catch (_) { /* denied or unsupported — ignore */ }
  }

  _releaseWakeLock() {
    if (this._visHandler) { document.removeEventListener('visibilitychange', this._visHandler); this._visHandler = null; }
    try { this._wakeLock?.release(); } catch (_) {}
    this._wakeLock = null;
  }
}

export class DrivingScreen extends Screen {
  constructor() { super('driving', 'Driving', '🚗'); }
  render(c, ctx) {
    const speed = gauge('Speed', 0, 150, 'km/h');
    const power = gauge('Power out', -45, 80, 'kW', { zeroCentered: true, decimals: 1 });
    const pedal = hbar('Accelerator pedal', 0, 125, '%');
    const posTorque = hbar('Drive torque', 0, 2200, 'Nm');
    const negTorque = hbar('Brake torque', -2200, 0, 'Nm', { zeroCentered: true });
    const resistive = hbar('Max regen torque available', -4096, 0, 'Nm', { zeroCentered: true });
    const odo = tile('Odometer', 'km');
    const tripKm = tile('Trip B', 'km');
    const tripKwh = tile('Trip B energy', 'kWh');
    const soc = tile('SOC', '%');
    const range = tile('Range', 'km');
    const rpm = tile('Motor', 'rpm');

    c.append(
      el('div', { class: 'gauges' }, speed.root, power.root),
      section('Pedals & torque', pedal.root, posTorque.root, negTorque.root, resistive.root),
      el('div', { class: 'grid' }, odo.root, tripKm.root, tripKwh.root, soc.root, range.root, rpm.root),
    );
    this.bind(ctx, Sid.RealSpeed, speed, 300, f => f.value);
    this.bind(ctx, Sid.DcPowerOut, power, 300, f => f.value);
    this.bind(ctx, Sid.Pedal, pedal, 300);
    this.bind(ctx, Sid.TotalPositiveTorque, posTorque, 300);
    this.bind(ctx, Sid.TotalNegativeTorque, negTorque, 300);
    this.bind(ctx, Sid.TotalPotentialResistiveWheelsTorque, resistive, 1000, f => ({ value: -Math.abs(f.value) }));
    this.bind(ctx, Sid.EvcOdometer, odo, 6000);
    this.bind(ctx, Sid.TripMeterB, tripKm, 6000);
    this.bind(ctx, Sid.TripEnergyB, tripKwh, 6000);
    this.bind(ctx, Sid.SoC, soc, 7000);
    this.bind(ctx, Sid.RangeEstimate, range, 7000);
    this.bind(ctx, Sid.ElecEngineRPM, rpm, 1000);
  }
}

export class BatteryScreen extends Screen {
  constructor() { super('battery', 'Battery', '🔋'); }
  render(c, ctx) {
    const items = [
      [Sid.RealSoC, 'Real SOC', 5000], [Sid.UserSoC, 'User SOC', 5000],
      [Sid.SOH, 'State of health (SOH)', 8000], [Sid.AvailableEnergy, 'Available energy', 5000],
      [Sid.TractionBatteryVoltage, 'Pack voltage', 2000], [Sid.TractionBatteryCurrent, 'Pack current', 2000],
      [Sid.MaxCellVoltage, 'Highest cell', 5000], [Sid.MinCellVoltage, 'Lowest cell', 5000],
      [Sid.AverageBatteryTemperature, 'Avg temperature', 8000], [Sid.HvKilometers, 'Battery km', 30000],
      [Sid.TotalKWh, 'Energy delivered (life)', 30000], [Sid.BatterySerial, 'Battery serial', 60000],
      [Sid.CounterFull, 'Full charges', 60000], [Sid.CounterPartial, 'Partial charges', 60000],
    ];
    const grid = el('div', { class: 'grid' });
    for (const [sid, label, interval] of items) {
      const f = ctx.poller.getField(sid);
      const t = tile(label, f?.unit || '');
      grid.append(t.root);
      this.bind(ctx, sid, t, interval);
    }
    c.append(grid);

    // 96 cell voltages
    const cellMap = heatmap(96, 3.3, 4.25, 3, 'V');
    c.append(section('Cell voltages (V)', cellMap.root));
    for (let i = 0; i < 96; i++) {
      const sid = i < 62 ? `7bb.6141.${16 + 16 * i}` : `7bb.6142.${16 + 16 * (i - 62)}`;
      const idx = i;
      if (ctx.poller.getField(sid)) {
        this.bind(ctx, sid, { update: f => cellMap.update(idx, f.value) }, 10000);
      }
    }
    // 12 module temperatures
    const tempMap = heatmap(12, 5, 45, 0, '°C');
    c.append(section('Module temperatures (°C)', tempMap.root));
    for (let i = 0; i < 12; i++) {
      const sid = `7bb.6104.${32 + 24 * i}`;
      const idx = i;
      if (ctx.poller.getField(sid)) {
        this.bind(ctx, sid, { update: f => tempMap.update(idx, f.value) }, 10000);
      }
    }
  }
}

export class ChargingScreen extends Screen {
  constructor() { super('charging', 'Charging', '⚡'); }
  render(c, ctx) {
    const items = [
      [Sid.AvailableChargingPower, 'Max charge power avail.', 5000],
      [Sid.ChargingPower, 'Charging power', 3000],
      [Sid.DcPowerIn, 'DC power in', 3000],
      [Sid.UserSoC, 'User SOC', 5000], [Sid.RealSoC, 'Real SOC', 5000],
      [Sid.SOH, 'SOH', 10000], [Sid.RangeEstimate, 'Range', 5000],
      [Sid.HvTemp, 'Battery temp', 5000],
      [Sid.ACPilotAmps, 'Pilot current', 3000],
      [Sid.MainsCurrentType, 'Mains type', 5000],
      [Sid.SupervisorState, 'Charger state', 3000],
      [Sid.GroundResistance, 'Ground resistance', 8000],
      [Sid.PhaseVoltage1, 'Phase 1 V', 5000], [Sid.PhaseVoltage2, 'Phase 2 V', 5000],
      [Sid.PhaseVoltage3, 'Phase 3 V', 5000],
      [Sid.Phase1currentRMS, 'Phase 1 A', 5000], [Sid.Phase2CurrentRMS, 'Phase 2 A', 5000],
      [Sid.Phase3CurrentRMS, 'Phase 3 A', 5000],
      [Sid.MainsActivePower, 'Mains power', 5000],
      [Sid.MaxCharge, 'Max charge', 8000],
    ];
    const grid = el('div', { class: 'grid' });
    for (const [sid, label, interval] of items) {
      const f = ctx.poller.getField(sid);
      const t = tile(label, f?.unit || '');
      grid.append(t.root);
      this.bind(ctx, sid, t, interval);
    }
    c.append(grid);

    const plot = timeplot([
      { label: 'kW in', color: '#41b0f5', min: 0, max: 50, unit: 'kW', decimals: 1 },
      { label: 'SOC', color: '#41d98c', min: 0, max: 100, unit: '%', decimals: 1 },
    ], { spanSec: 1800 });
    c.append(section('Charging session', plot.root));
    this.bind(ctx, Sid.DcPowerIn, { update: f => plot.push(0, f.value) }, 5000);
    this.bind(ctx, Sid.RealSoC, { update: f => plot.push(1, f.value) }, 5000);
  }
}

export class RangeScreen extends Screen {
  constructor() { super('range', 'Range', '🛣️'); }
  render(c, ctx) {
    const items = [
      [Sid.RangeEstimate, 'Range estimate', 2000],
      [Sid.AvailableEnergy, 'Available energy', 2000],
      [Sid.AverageConsumption, 'Average consumption', 2000],
      [Sid.BestAverageConsumption, 'Best consumption', 8000],
      [Sid.WorstAverageConsumption, 'Worst consumption', 8000],
      [Sid.UserSoC, 'SOC', 3000],
    ];
    const grid = el('div', { class: 'grid' });
    for (const [sid, label, interval] of items) {
      const f = ctx.poller.getField(sid);
      const t = tile(label, f?.unit || '');
      grid.append(t.root);
      this.bind(ctx, sid, t, interval);
    }
    c.append(grid);
  }
}

export class ConsumptionScreen extends Screen {
  constructor() { super('consumption', 'Consumption', '📈'); }
  render(c, ctx) {
    const plot = timeplot([
      { label: 'Power out', color: '#f5a441', min: -45, max: 80, unit: 'kW', decimals: 1 },
      { label: 'Speed', color: '#41b0f5', min: 0, max: 150, unit: 'km/h', decimals: 0 },
    ], { spanSec: 300 });
    c.append(section('Last 5 minutes', plot.root));
    const inst = tile('Instant consumption', 'kWh/100km', 'big');
    const avg = tile('Average consumption', 'kWh/100km', 'big');
    c.append(el('div', { class: 'grid' }, inst.root, avg.root));
    this.bind(ctx, Sid.DcPowerOut, { update: f => plot.push(0, f.value) }, 500);
    this.bind(ctx, Sid.RealSpeed, { update: f => plot.push(1, f.value) }, 500);
    this.bind(ctx, Sid.InstantConsumption, inst, 1000);
    this.bind(ctx, Sid.AverageConsumption, avg, 5000);
  }
}

export class ClimateScreen extends Screen {
  constructor() { super('climate', 'Climate', '❄️'); }
  render(c, ctx) {
    const items = [
      [Sid.ClimTempDisplay, 'Cabin setpoint', 5000],
      [Sid.ThermalComfortPower, 'Climate power', 2000],
      [Sid.Pressure, 'Refrigerant pressure', 3000],
      [Sid.HvEvaporationTemp, 'Evaporator temp', 5000],
      [Sid.HvCoolingState, 'HV cooling state', 3000],
      [Sid.ClimaLoopMode, 'Climate loop mode', 3000],
      [Sid.BatteryConditioningMode, 'Battery conditioning', 3000],
      [Sid.EngineFanSpeed, 'Fan speed', 3000],
      [Sid.HeaterSetpoint, 'Heater setpoint', 5000],
      [Sid.DcPowerOut, 'Total DC power', 2000],
    ];
    const grid = el('div', { class: 'grid' });
    for (const [sid, label, interval] of items) {
      const f = ctx.poller.getField(sid);
      const t = tile(label, f?.unit || '');
      grid.append(t.root);
      this.bind(ctx, sid, t, interval);
    }
    c.append(grid);
  }
}

export class TiresScreen extends Screen {
  constructor() { super('tires', 'Tires', '🛞'); }
  render(c, ctx) {
    const mk = (labelP, labelS) => ({ p: tile(labelP, 'bar'), s: tile(labelS) });
    const fl = mk('Front left', 'FL state'), fr = mk('Front right', 'FR state');
    const rl = mk('Rear left', 'RL state'), rr = mk('Rear right', 'RR state');
    c.append(el('div', { class: 'tires-layout' },
      el('div', { class: 'grid two' }, fl.p.root, fr.p.root, fl.s.root, fr.s.root),
      el('div', { class: 'grid two' }, rl.p.root, rr.p.root, rl.s.root, rr.s.root),
    ));
    const state = f => ({ format: () => ['?', 'ok', 'not monitored', 'low pressure', 'leak!'][Math.round(f.value)] ?? f.format() });
    // CanZE Ph1 pressures come in mbar ÷ 100
    const bar = f => ({ format: () => Number.isNaN(f.value) ? '—' : (f.unit.toLowerCase() === 'mbar' ? (f.value / 1000).toFixed(2) : f.value.toFixed(2)) });
    this.bind(ctx, Sid.TireFLPressure, fl.p, 6000, bar);
    this.bind(ctx, Sid.TireFRPressure, fr.p, 6000, bar);
    this.bind(ctx, Sid.TireRLPressure, rl.p, 6000, bar);
    this.bind(ctx, Sid.TireRRPressure, rr.p, 6000, bar);
    this.bind(ctx, Sid.TireFLState, fl.s, 6000, state);
    this.bind(ctx, Sid.TireFRState, fr.s, 6000, state);
    this.bind(ctx, Sid.TireRLState, rl.s, 6000, state);
    this.bind(ctx, Sid.TireRRState, rr.s, 6000, state);
  }
}

export class BrakingScreen extends Screen {
  constructor() { super('braking', 'Braking', '🛑'); }
  render(c, ctx) {
    const driver = hbar('Driver brake request', 0, 4000, 'Nm');
    const elec = hbar('Electric (regen) braking', 0, 2200, 'Nm');
    const friction = hbar('Friction braking', 0, 4000, 'Nm');
    const hydraulic = hbar('Hydraulic torque request', 0, 4000, 'Nm');
    c.append(section('Brake blending', driver.root, elec.root, friction.root, hydraulic.root),
      el('p', { class: 'hint' }, 'Shows how braking is split between the motor (regeneration) and the friction brakes.'));
    this.bind(ctx, Sid.DriverBrakeWheelTorqueRequest, driver, 300, f => ({ value: Math.abs(f.value) }));
    this.bind(ctx, Sid.ElecBrakeTorque, elec, 300, f => ({ value: Math.abs(f.value) }));
    this.bind(ctx, Sid.FrictionTorque, friction, 300, f => ({ value: Math.max(0, f.value) }));
    this.bind(ctx, Sid.HydraulicTorqueRequest, hydraulic, 500, f => ({ value: Math.abs(f.value) }));
  }
}
