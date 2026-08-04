// ============================================================================
// SORA operational-volume calculator.
//
// Implements the LBA "Guidance for Dimensioning of Flight Geography, Contingency
// Volume and Ground Risk Buffer" (rev 1.7, 26.11.2024), which realises the
// dimensioning method under IR (EU) 2019/947 / SORA. These are PURE functions
// (no DOM, no map) so the maths can be unit-tested against the guideline's own
// worked examples.
//
// Units: distances/heights in metres, speeds in m/s, angles in DEGREES.
// g = 9.81 m/s².
// ============================================================================

export const G = 9.81;

// Editable assumptions (the guideline's default values; each may be overridden
// by the operator with a documented justification for the authority file).
export const DEFAULTS = {
  reactionTime: 1,        // t — manual initiation of contingency measures (s)
  SGPS: 3,                // GPS inaccuracy (m)
  SPos: 3,                // position-holding error (m)
  SK: 1,                  // map error (m)
  pitchAngle: 45,         // Θ — multirotor stop, ≤ 45° (deg)
  rollAngle: 30,          // Φ — fixed-wing 180° turn, ≤ 30° (deg)
  groundVisibility: 5000, // GV — capped at 5 km
};

const rad = (deg) => (deg * Math.PI) / 180;

// Horizontal contingency-maneuver distance S_CM.
function lateralCM(inp) {
  switch (inp.horizontalCM) {
    case 'turnFixedwing': // fixed-wing 180° turn radius
      return (inp.V0 ** 2) / (G * Math.tan(rad(inp.rollAngle)));
    case 'parachute':     // flight terminated on leaving FG
      return inp.V0 * inp.parachuteOpenTime;
    case 'stopMultirotor':
    default:              // multirotor deceleration to hover
      return 0.5 * (inp.V0 ** 2) / (G * Math.tan(rad(inp.pitchAngle)));
  }
}

// Vertical contingency-maneuver height H_CM.
function verticalCM(inp) {
  switch (inp.verticalCM) {
    case 'fixedwing':  return 0.3 * (inp.V0 ** 2) / G;
    case 'parachute':  return 0.7 * inp.V0 * inp.parachuteOpenTime;
    case 'multirotor':
    default:           return 0.5 * (inp.V0 ** 2) / G;
  }
}

// Ground-risk-buffer lateral extent S_GRB (method-dependent).
function grbLateral(inp, HCV) {
  const half = 0.5 * inp.CD;
  switch (inp.grbMethod) {
    case 'ballistic':        // rotorcraft / multirotor ONLY
      return inp.V0 * Math.sqrt((2 * HCV) / G) + half;
    case 'parachute':
      return inp.V0 * inp.parachuteOpenTime + inp.Vwind * (HCV / inp.descentRate);
    case 'fixedwingGlide':   // power off, glide ratio E
      return HCV * inp.glideRatio;
    case 'fixedwingNoGlide': // power off, no gliding possible → 1:1
    case 'oneToOne':
    default:
      return HCV + half;
  }
}

/**
 * Compute the full operational volume from a set of UAS + operational inputs.
 * Returns every intermediate term so the UI can show a transparent breakdown.
 * @param {object} input see DEFAULTS + { aircraftType, V0, CD, HFG, heightMethod,
 *   horizontalCM, verticalCM, grbMethod, parachuteOpenTime, descentRate, Vwind,
 *   glideRatio, ... }
 */
export function computeVolume(input) {
  const inp = { ...DEFAULTS, ...input };

  // --- Lateral contingency volume: S_CV = S_GPS + S_Pos + S_K + S_RZ + S_CM ---
  const SRZ = inp.V0 * inp.reactionTime;
  const SCM = lateralCM(inp);
  const SCV = inp.SGPS + inp.SPos + inp.SK + SRZ + SCM;

  // --- Vertical contingency volume: H_CV = H_FG + H_baro + H_RZ + H_CM ---
  const Hbaro = inp.heightMethod === 'gnss' ? 4 : 1;
  const HRZ = inp.V0 * 0.7 * inp.reactionTime;
  const HCM = verticalCM(inp);
  const HCV = inp.HFG + Hbaro + HRZ + HCM;

  // --- Ground risk buffer (lateral only; vertical N/A) ---
  const SGRB = grbLateral(inp, HCV);

  // --- Adjacent volume ---
  const SAV = 120 * inp.V0;      // 2-minute flight at V0
  const HAV = HCV + 150;         // ≥ 500 ft above the operational volume

  // --- VLOS / BVLOS ---
  const ALOS = inp.aircraftType === 'fixedwing'
    ? 490 * inp.CD + 30
    : 327 * inp.CD + 20;
  const GV = Math.min(inp.groundVisibility ?? 5000, 5000);
  const DLOS = 0.3 * GV;
  const vlosLimit = Math.min(ALOS, DLOS);

  return {
    // lateral CV
    SRZ, SCM, SCV,
    // vertical CV
    Hbaro, HRZ, HCM, HCV,
    // ground risk buffer
    SGRB,
    // adjacent volume
    SAV, HAV,
    // VLOS
    ALOS, DLOS, GV, vlosLimit,
    // echo the resolved inputs (incl. applied defaults)
    inputs: inp,
  };
}

// Convenience rounding for display (keeps raw values in computeVolume()).
export const r1 = (x) => Math.round(x * 10) / 10;
export const r2 = (x) => Math.round(x * 100) / 100;
