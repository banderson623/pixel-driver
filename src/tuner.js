// On-screen tuning panel: a slider for every knob in tuning.js. Dragging a
// slider writes straight into the live `tuning` object (car.js picks it up on
// the next frame) and debounce-saves to localStorage. Export/Import lets you
// stash a setup as a JSON file and reload it later.

import { GROUPS, DEFAULTS, tuning, load, save, resetDefaults, fromJSON } from './tuning.js';

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 300);
}

function fmt(v, step) {
  const decimals = step < 1 ? (step < 0.1 ? 2 : 2) : 0;
  return v.toFixed(decimals);
}

export function initTuner() {
  load();

  const rows = {}; // key -> { input, val }

  const panel = document.createElement('div');
  panel.id = 'tuner';

  const header = document.createElement('div');
  header.className = 'tuner-header';
  const title = document.createElement('span');
  title.textContent = 'HANDLING';
  const collapse = document.createElement('button');
  collapse.className = 'tuner-collapse';
  collapse.textContent = '–';
  header.appendChild(title);
  header.appendChild(collapse);
  panel.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tuner-body';
  panel.appendChild(body);

  for (const group of GROUPS) {
    const gh = document.createElement('div');
    gh.className = 'tuner-group';
    gh.textContent = group.name;
    body.appendChild(gh);

    for (const [key, label, min, max, step] of group.params) {
      const row = document.createElement('label');
      row.className = 'tuner-row';

      const name = document.createElement('span');
      name.className = 'tuner-name';
      name.textContent = label;

      const val = document.createElement('span');
      val.className = 'tuner-val';
      val.textContent = fmt(tuning[key], step);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = min; input.max = max; input.step = step;
      input.value = tuning[key];

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        tuning[key] = v;
        val.textContent = fmt(v, step);
        scheduleSave();
      });
      // Release focus after adjusting so arrow keys drive the car again
      // instead of nudging the slider.
      const release = () => input.blur();
      input.addEventListener('change', release);
      input.addEventListener('pointerup', release);

      const top = document.createElement('div');
      top.className = 'tuner-toprow';
      top.appendChild(name);
      top.appendChild(val);
      row.appendChild(top);
      row.appendChild(input);
      body.appendChild(row);

      rows[key] = { input, val, step };
    }
  }

  const refresh = () => {
    for (const key in rows) {
      rows[key].input.value = tuning[key];
      rows[key].val.textContent = fmt(tuning[key], rows[key].step);
    }
  };

  // action buttons
  const actions = document.createElement('div');
  actions.className = 'tuner-actions';

  const reset = document.createElement('button');
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => { resetDefaults(); refresh(); });

  const exportBtn = document.createElement('button');
  exportBtn.textContent = 'Save file';
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(tuning, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pixel-driver-tuning.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const importBtn = document.createElement('button');
  importBtn.textContent = 'Load file';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.style.display = 'none';
  importBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { fromJSON(JSON.parse(reader.result)); save(); refresh(); }
      catch (e) { /* bad file: ignore */ }
    };
    reader.readAsText(file);
    fileInput.value = '';
  });

  actions.appendChild(reset);
  actions.appendChild(exportBtn);
  actions.appendChild(importBtn);
  actions.appendChild(fileInput);
  body.appendChild(actions);

  collapse.addEventListener('click', () => {
    const hidden = panel.classList.toggle('collapsed');
    collapse.textContent = hidden ? '+' : '–';
  });

  // Hidden by default now that the setup is dialed in. Press ` (backtick) to
  // toggle it back for more tweaking — doesn't clash with the drive keys.
  panel.style.display = 'none';
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') {
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    }
  });

  document.body.appendChild(panel);
}
