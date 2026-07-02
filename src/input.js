export class Input {
  constructor() {
    this.keys = new Set();
    this.justPressed = new Set();
    this.typed = [];
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      if (!e.repeat) {
        this.justPressed.add(e.code);
        this.typed.push(e.key);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  down(...codes) {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  pressed(...codes) {
    for (const c of codes) if (this.justPressed.has(c)) return true;
    return false;
  }

  readTyped() {
    const t = this.typed;
    this.typed = [];
    return t;
  }

  endFrame() {
    this.justPressed.clear();
    this.typed.length = 0;
  }
}
