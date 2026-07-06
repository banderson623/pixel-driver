// Live-tunable car physics. `tuning` holds the current value of every knob;
// car.js reads it every frame, so dragging a slider changes the handling
// instantly. Values auto-save to localStorage on change (so you resume right
// where you left off between page reloads) and can be exported/imported as a
// JSON file to keep named setups around.

// [key, label, min, max, step] grouped into panel sections.
export const GROUPS = [
  { name: 'Steering', params: [
    ['STEER_MAX',        'Max steer angle',    0.20, 1.00, 0.01],
    ['STEER_RATE',       'Steer rate',         2,    25,   0.5 ],
    ['STEER_RATE_DRIFT', 'Steer rate (drift)', 0,    30,   0.5 ],
    ['STEER_FALLOFF',    'Steer falloff spd',  60,   400,  5   ],
  ]},
  { name: 'Grip & slide', params: [
    ['K_LAT',          'Grip stiffness',   5,    30,   0.5 ],
    ['GRIP_F',         'Front grip',       100,  450,  5   ],
    ['GRIP_R',         'Rear grip',        100,  450,  5   ],
    ['KINETIC',        'Slide grip',       0.10, 1.00, 0.02],
    ['THROTTLE_DRAIN', 'Throttle → slide', 0,    1,    0.02],
    ['HB_REAR',        'Handbrake grip',   0.02, 0.60, 0.02],
  ]},
  { name: 'Rotation', params: [
    ['OMEGA_DAMP', 'Yaw damping',   0.2, 3,   0.05],
    ['OMEGA_MAX',  'Max spin rate', 1,   6,   0.1 ],
    ['INERTIA',    'Rot. inertia',  20,  100, 1   ],
  ]},
  { name: 'Power', params: [
    ['VMAX',  'Top speed',    120,  400,  5   ],
    ['ACCEL', 'Acceleration', 80,   400,  5   ],
    ['BRAKE', 'Braking',      150,  600,  10  ],
    ['DRAG',  'Drag',         0.05, 1.00, 0.01],
  ]},
];

// Baseline handling — Brian's dialed-in setup (2026-07-06).
export const DEFAULTS = {
  STEER_MAX: 1, STEER_RATE: 25, STEER_RATE_DRIFT: 13, STEER_FALLOFF: 130,
  K_LAT: 16, GRIP_F: 250, GRIP_R: 295, KINETIC: 0.96, THROTTLE_DRAIN: 0.5, HB_REAR: 0.16,
  OMEGA_DAMP: 0.9, OMEGA_MAX: 3.2, INERTIA: 48,
  VMAX: 260, ACCEL: 195, BRAKE: 240, DRAG: 0.45,
};

// The single live object every physics frame reads from. Never reassign it —
// mutate its keys so existing imports keep pointing at the same object.
export const tuning = { ...DEFAULTS };

const KEY = 'pixeldriver.tuning';

// Copy known numeric keys off `obj` into `tuning`, clamped to each range.
export function fromJSON(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const g of GROUPS) {
    for (const [k, , min, max] of g.params) {
      const v = obj[k];
      if (typeof v === 'number' && isFinite(v)) {
        tuning[k] = Math.min(max, Math.max(min, v));
      }
    }
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) fromJSON(JSON.parse(raw));
  } catch (e) { /* corrupt or unavailable storage: fall back to defaults */ }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(tuning)); } catch (e) { /* ignore */ }
}

export function resetDefaults() {
  Object.assign(tuning, DEFAULTS);
  save();
}
