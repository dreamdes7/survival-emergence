// Small pure helpers shared by the UI and the renderer.

export function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return map[ch];
  });
}

export function escapeAttr(text: string) {
  return escapeHtml(text).replace(/`/g, "&#096;");
}

export function genderLabel(gender?: string | null): string {
  if (gender === "female") return "женщина";
  if (gender === "male") return "мужчина";
  return "";
}

// ── per-agent colour (stable hue from id) ─────────────────────────────────────
export function agentHue(id: string): number {
  const n = parseInt(id.replace(/[^0-9]/g, ""), 10);
  return ((Number.isFinite(n) ? n : 0) * 360) / 12 % 360;   // 12 distinct slots
}

export function hslToRgbInt(h: number, s: number, l: number): number {
  const sn = s / 100, ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => ln - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const r = Math.round(f(0) * 255), g = Math.round(f(8) * 255), b = Math.round(f(4) * 255);
  return (r << 16) | (g << 8) | b;
}

export function agentTint(id: string): number { return hslToRgbInt(agentHue(id), 62, 66); }
export function agentCss(id: string): string { return `hsl(${agentHue(id)} 80% 70%)`; }       // on dark
export function agentCssInk(id: string): string { return `hsl(${agentHue(id)} 70% 38%)`; }    // on light

export function agentIndex(id: string): number {
  const n = parseInt(id.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}
