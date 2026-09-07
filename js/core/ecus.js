/*
 * ZoeWeb — ECU registry, DTC databases and the vehicle database loader.
 * Data files come verbatim from CanZE (GPL-3.0).
 */
import { FieldRegistry, parseCsv } from './fields.js';
import { embeddedAssets } from './embedded.js';

export const CARS = {
  ZOE:          { dir: 'ZOE',          label: 'Zoe Ph1 (Q210/R240/Q90/R90)', ph2: false },
  ZOE_Ph2:      { dir: 'ZOE_Ph2',      label: 'Zoe Ph2 (ZE50)',              ph2: true },
  Twingo_3_Ph2: { dir: 'Twingo_3_Ph2', label: 'Twingo III Ph2 Electric',     ph2: true },
  Twizy:        { dir: 'Twizy',        label: 'Twizy',                       ph2: false },
};

export class Ecu {
  constructor(cols) {
    this.name = cols[0];
    this.renaultId = cols[1];
    this.networks = cols[2];
    this.fromIdHex = (cols[3] || '0').toLowerCase(); // responses come FROM the ecu on this id
    this.toIdHex = (cols[4] || '0').toLowerCase();   // requests are sent TO the ecu on this id
    this.mnemonic = cols[5];
    this.aliases = (cols[6] || '').split(';').filter(Boolean);
    this.dtcResponseIds = (cols[7] || '').toLowerCase().split(';').filter(Boolean);
    this.startDiag = (cols[8] || '').toLowerCase();  // expected response to the session request
    this.sessionRequired = cols[9] === '1';
    this.fromId = parseInt(this.fromIdHex, 16);
    this.toId = parseInt(this.toIdHex, 16);
    this.dtcs = new Map();   // code (4 hex chars) → description
    this.tests = new Map();  // failure-type byte → description
  }

  get addressable() { return this.fromId > 0 && this.fromId < 0x800 * 0x10000; }
  get isExtended() { return this.fromId >= 0x800; }
  /** The request that opens the diag session ("50c0" response → "10c0" request). */
  get sessionRequestId() { return this.startDiag ? '1' + this.startDiag.substring(1) : '10c0'; }
}

export class VehicleDb {
  constructor(carKey) {
    this.carKey = carKey;
    this.car = CARS[carKey];
    this.registry = new FieldRegistry();
    this.ecus = [];
  }

  ecuByMnemonic(m) {
    m = m.toUpperCase();
    return this.ecus.find(e => e.mnemonic.toUpperCase() === m || e.aliases.some(a => a.toUpperCase() === m));
  }

  ecuByFromId(fromIdHex) {
    fromIdHex = fromIdHex.toLowerCase();
    return this.ecus.find(e => e.fromIdHex === fromIdHex);
  }

  async load(baseUrl = 'assets') {
    const dir = `${baseUrl}/${this.car.dir}`;
    const embedded = embeddedAssets();
    const get = async (name, optional = true) => {
      if (embedded) {
        const map = await embedded;
        const text = map[`${this.car.dir}/${name}`];
        if (text !== undefined) return text;
        if (optional) return null;
        throw new Error(`${name}: missing from embedded assets`);
      }
      try {
        const r = await fetch(`${dir}/${name}`);
        if (!r.ok) { if (optional) return null; throw new Error(`${name}: HTTP ${r.status}`); }
        return await r.text();
      } catch (e) {
        if (optional) return null;
        throw e;
      }
    };

    // ECU list
    const ecusTxt = await get('_Ecus.csv', false);
    for (const cols of parseCsv(ecusTxt)) {
      if (cols.length >= 9) this.ecus.push(new Ecu(cols));
    }

    // frame intervals + general (free frame) fields
    const framesTxt = await get('_Frames.csv');
    if (framesTxt) this.registry.loadFramesCsv(framesTxt);
    const fieldsTxt = await get('_Fields.csv');
    if (fieldsTxt) this.registry.loadFieldsCsv(fieldsTxt);

    // per-ECU field + DTC + test files, loaded in parallel
    await Promise.all(this.ecus.map(async ecu => {
      if (!ecu.mnemonic || ecu.mnemonic === '-') return;
      const [f, d, t] = await Promise.all([
        get(`${ecu.mnemonic}_Fields.csv`),
        get(`${ecu.mnemonic}_Dtcs.csv`),
        get(`${ecu.mnemonic}_Tests.csv`),
      ]);
      if (f) this.registry.loadFieldsCsv(f);
      if (d) for (const cols of parseCsv(d)) {
        if (cols.length >= 2) ecu.dtcs.set(cols[0].toUpperCase(), cols.slice(1).join(','));
      }
      if (t) for (const cols of parseCsv(t)) {
        if (cols.length >= 2) ecu.tests.set(cols[0].toUpperCase(), cols.slice(1).join(','));
      }
    }));

    return this;
  }
}
