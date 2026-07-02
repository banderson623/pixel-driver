// Tiny 3x5 bitmap font, rendered as filled rects so it stays crisp at any
// integer scale in the low-res buffer.

const SRC = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
  '3': '111001011001111', '4': '101101111001001', '5': '111100111001111',
  '6': '111100111101111', '7': '111001001010010', '8': '111101111101111',
  '9': '111101111001111',
  'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011',
  'D': '110101101101110', 'E': '111100110100111', 'F': '111100110100100',
  'G': '111100101101111', 'H': '101101111101101', 'I': '111010010010111',
  'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
  'M': '101111111101101', 'N': '111101101101101', 'O': '111101101101111',
  'P': '111101111100100', 'Q': '111101101111001', 'R': '111101110101101',
  'S': '011100010001110', 'T': '111010010010010', 'U': '101101101101111',
  'V': '101101101010010', 'W': '101101111111101', 'X': '101101010101101',
  'Y': '101101010010010', 'Z': '111001010100111',
  ' ': '000000000000000', '.': '000000000000010', ':': '000010000010000',
  '!': '010010010000010', '-': '000000111000000', '%': '101001010100101',
  '/': '001001010100100', '>': '100010001010100', '?': '111001010000010',
  ',': '000000000010100', '+': '000010111010000', '_': '000000000000111',
};

const GLYPHS = {};
for (const ch in SRC) {
  const bits = [];
  for (let i = 0; i < 15; i++) bits.push(SRC[ch].charCodeAt(i) === 49);
  GLYPHS[ch] = bits;
}

export function drawText(ctx, text, x, y, scale = 1, color = '#ffffff') {
  ctx.fillStyle = color;
  text = String(text).toUpperCase();
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    const g = GLYPHS[text[i]] || GLYPHS['?'];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (g[r * 3 + c]) ctx.fillRect(cx + c * scale, y + r * scale, scale, scale);
      }
    }
    cx += 4 * scale;
  }
  return cx;
}

export function textWidth(text, scale = 1) {
  return String(text).length * 4 * scale - scale;
}

export function drawTextCentered(ctx, text, cx, y, scale = 1, color = '#ffffff') {
  drawText(ctx, text, Math.round(cx - textWidth(text, scale) / 2), y, scale, color);
}
