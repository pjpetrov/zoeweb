/*
 * ZoeWeb — automatic car detection.
 *
 * There is no "what car am I?" command, so we probe a few signature ECUs per
 * platform (some that MUST answer, some that must NOT) and score each car.
 * Addresses come from the shipped CanZE _Ecus.csv files — no proprietary data.
 */
import { Elm327, ElmError } from '../device/elm327.js';

// toId → fromId pairs that uniquely characterise each platform
const SIGNATURES = {
  ZOE: {          // Zoe Ph1
    present: [['7e4', '7ec'], ['79b', '7bb'], ['75a', '77e']], // EVC, LBC, PEB
    absent: [['18dadbf1', '18daf1db']],                        // no 29-bit LBC
  },
  ZOE_Ph2: {      // ZE50
    present: [['18dadbf1', '18daf1db'], ['18dadef1', '18daf1de']], // 29-bit LBC, BCB
    absent: [['7e4', '7ec'], ['75a', '77e']],                     // no Ph1 EVC/PEB
  },
  Twingo_3_Ph2: {
    present: [['714', '734'], ['747', '767'], ['79b', '7bb']], // MIU, Nav, LBC(11-bit)
    absent: [['7e4', '7ec'], ['18dadbf1', '18daf1db']],        // no Ph1 EVC, no Ph2 LBC
  },
  Twizy: {
    present: [['743', '763'], ['792', '793']],                 // TDB, BCB
    absent: [['7e4', '7ec'], ['75a', '77e'], ['74d', '76d']],  // no EVC/PEB/USM
  },
};

const mkEcu = (toIdHex, fromIdHex) => ({
  toIdHex, fromIdHex, isExtended: fromIdHex.length > 3, sessionRequestId: '10c0',
});

/** True if an ECU answers at all (a UDS negative response still means present). */
async function responds(elm, toIdHex, fromIdHex) {
  try {
    await elm.requestIsoTp(mkEcu(toIdHex, fromIdHex), '10c0', { timeout: 700 });
    return true;
  } catch (e) {
    if (e instanceof ElmError && e.nrc) return true; // ECU replied, just refused
    return false;
  }
}

/**
 * Probe the bus and return { car, scores, tested } — car is the best match or
 * null if nothing responded. Only probes each unique address once.
 */
export async function detectCar(elm, onProgress = () => {}) {
  const cache = new Map(); // "to.from" → bool
  const probe = async (to, from) => {
    const key = to + '.' + from;
    if (!cache.has(key)) {
      onProgress(`Probing ${to}…`);
      cache.set(key, await responds(elm, to, from));
    }
    return cache.get(key);
  };

  const scores = {};
  let anyResponse = false;
  for (const [car, sig] of Object.entries(SIGNATURES)) {
    let score = 0;
    for (const [to, from] of sig.present) {
      if (await probe(to, from)) { score += 2; anyResponse = true; }
    }
    for (const [to, from] of sig.absent) {
      if (await probe(to, from)) score -= 2; else score += 1;
    }
    scores[car] = score;
  }

  if (!anyResponse) return { car: null, scores, tested: [...cache.keys()] };
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  // require a clear winner with at least one positive signature ECU
  const car = best[0][1] >= 2 && best[0][1] > best[1][1] ? best[0][0] : null;
  return { car, scores, tested: [...cache.keys()] };
}
