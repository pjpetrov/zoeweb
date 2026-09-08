/*
 * ZoeWeb — automatic car detection.
 *
 * There is no "what car am I?" command, so we probe signature ECUs with the
 * same real data reads the app relies on (a bare 10c0 session is unreliable —
 * many Renault ECUs answer data reads but ignore it), then decide by unique
 * markers in priority order. Addresses come from the shipped CanZE _Ecus.csv.
 */
import { ElmError } from '../device/elm327.js';

const mkEcu = (toIdHex, fromIdHex) => ({
  toIdHex, fromIdHex, isExtended: fromIdHex.length > 3, sessionRequestId: '10c0',
});

// Signature probes: {to, from, req} — req is a request known to elicit a
// response on that ECU (positive or a UDS negative both prove it is present).
const PROBES = {
  EVC:      { to: '7e4', from: '7ec', req: '222006' },       // Zoe Ph1 vehicle controller (odometer)
  LBC_Ph1:  { to: '79b', from: '7bb', req: '2103' },         // Zoe Ph1 / Twingo / Twizy battery
  LBC_Ph2:  { to: '18dadbf1', from: '18daf1db', req: '2180' }, // ZE50 battery (29-bit)
  MIU:      { to: '714', from: '734', req: '2180' },         // Twingo III multimedia
  NAV:      { to: '747', from: '767', req: '2180' },         // Twingo III navigation
  TDB:      { to: '743', from: '763', req: '220206' },       // cluster (Zoe & Twizy)
  BCB:      { to: '792', from: '793', req: '2180' },         // charger (Zoe Ph1 & Twizy)
};

async function responds(elm, p) {
  try {
    await elm.requestIsoTp(mkEcu(p.to, p.from), p.req, { timeout: 900 });
    return true;
  } catch (e) {
    if (e instanceof ElmError && e.nrc) return true; // ECU replied, just refused the request
    return false;
  }
}

/**
 * Returns { car, responded } — car is the detected key or null if unsure.
 * Decides by unique markers in priority order so a car can never win merely
 * because another car's shared ECUs (cluster, charger) happen to answer.
 */
export async function detectCar(elm, onProgress = () => {}) {
  const seen = {};
  const hit = async name => {
    if (!(name in seen)) {
      onProgress(`probing ${name}`);
      seen[name] = await responds(elm, PROBES[name]);
    }
    return seen[name];
  };

  let car = null;
  if (await hit('LBC_Ph2')) {
    car = 'ZOE_Ph2';                                  // 29-bit battery ⇒ ZE50
  } else if ((await hit('MIU')) || (await hit('NAV'))) {
    car = 'Twingo_3_Ph2';                             // multimedia/nav ECUs (Zoe Ph1 has none) ⇒ Twingo III
  } else if (await hit('EVC')) {
    car = 'ZOE';                                      // Ph1 EVC at 7ec ⇒ Zoe Ph1 (Q/R)
  } else if ((await hit('TDB')) || (await hit('BCB')) || (await hit('LBC_Ph1'))) {
    car = 'Twizy';                                    // only the minimal set answered
  }
  return { car, responded: seen };
}
