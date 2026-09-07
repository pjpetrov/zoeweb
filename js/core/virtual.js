/*
 * ZoeWeb — virtual fields: values computed from other fields,
 * ported from CanZE's Fields.addVirtualField*().
 */
import { Sid } from './sid.js';

export class VirtualField {
  constructor(sid, unit, decimals, deps, compute) {
    this.sid = sid;
    this.unit = unit;
    this.decimals = decimals;
    this.deps = deps;           // array of dependency sids
    this.compute = compute;     // (get: sid → value) → value
    this.name = sid;
    this.list = '';
    this.isVirtual = true;
    this.value = NaN;
    this.lastUpdated = 0;
    this.listeners = new Set();
  }

  recompute(getValue) {
    const v = this.compute(getValue);
    this.value = v;
    this.lastUpdated = Date.now();
    for (const l of this.listeners) {
      try { l(this); } catch (e) { console.error('virtual listener', this.sid, e); }
    }
  }

  format() {
    if (Number.isNaN(this.value)) return '—';
    return this.value.toFixed(this.decimals);
  }

  label() { return this.name; }
}

export function createVirtualFields() {
  const v = [];
  const add = (sid, unit, dec, deps, fn) => v.push(new VirtualField(sid, unit, dec, deps, fn));

  add(Sid.DcPowerIn, 'kW', 1, [Sid.TractionBatteryVoltage, Sid.TractionBatteryCurrent],
    get => get(Sid.TractionBatteryVoltage) * get(Sid.TractionBatteryCurrent) / 1000);

  add(Sid.DcPowerOut, 'kW', 1, [Sid.TractionBatteryVoltage, Sid.TractionBatteryCurrent],
    get => -get(Sid.TractionBatteryVoltage) * get(Sid.TractionBatteryCurrent) / 1000);

  add(Sid.InstantConsumption, 'kWh/100km', 1, [Sid.TractionBatteryVoltage, Sid.TractionBatteryCurrent, Sid.RealSpeed],
    get => {
      const speed = get(Sid.RealSpeed);
      if (!(speed > 5)) return NaN;
      return -get(Sid.TractionBatteryVoltage) * get(Sid.TractionBatteryCurrent) / 1000 / speed * 100;
    });

  add(Sid.FrictionTorque, 'Nm', 0, [Sid.DriverBrakeWheelTorqueRequest, Sid.ElecBrakeWheelsTorqueApplied],
    get => get(Sid.DriverBrakeWheelTorqueRequest) - get(Sid.ElecBrakeWheelsTorqueApplied));

  add(Sid.ElecBrakeTorque, 'Nm', 0, [Sid.ElecBrakeWheelsTorqueApplied],
    get => -get(Sid.ElecBrakeWheelsTorqueApplied));

  add(Sid.TotalPositiveTorque, 'Nm', 0, [Sid.MeanEffectiveTorque],
    get => Math.max(0, get(Sid.MeanEffectiveTorque)) * 9.32); // motor → wheel torque ratio

  add(Sid.TotalNegativeTorque, 'Nm', 0, [Sid.MeanEffectiveTorque, Sid.ElecBrakeWheelsTorqueApplied, Sid.DriverBrakeWheelTorqueRequest],
    get => Math.min(0, get(Sid.MeanEffectiveTorque)) * 9.32
      - Math.max(0, get(Sid.ElecBrakeWheelsTorqueApplied))
      - Math.max(0, get(Sid.DriverBrakeWheelTorqueRequest)));

  add(Sid.ACPilot, 'A', 0, [Sid.ACPilotAmps], get => get(Sid.ACPilotAmps));

  return v;
}
