// Custom-styled form controls.
//
// Native <select> popups paint outside CSS control and visibly glitch
// (misplaced arrow, clipped list) when any ancestor uses backdrop-filter —
// every floaty panel does. Native number spin buttons can't be restyled at
// all cross-browser. Both wrap the real <input>/<select> (kept for name/value
// so FormData and existing change/input listeners work unmodified) with our
// own DOM, so this must run once per fresh render of any HTML containing
// selects or number inputs.

function closeAllSelects(except?: HTMLElement): void {
  document.querySelectorAll<HTMLElement>(".cs.open").forEach((cs) => {
    if (cs !== except) cs.dispatchEvent(new CustomEvent("cs:close"));
  });
}

function makeCustomSelect(nativeSelect: HTMLSelectElement): void {
  nativeSelect.dataset.enhanced = "1";
  const wrap = document.createElement("div");
  wrap.className = "cs";
  nativeSelect.parentElement!.insertBefore(wrap, nativeSelect);
  wrap.appendChild(nativeSelect);
  nativeSelect.classList.add("cs-native");
  nativeSelect.tabIndex = -1;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  wrap.appendChild(trigger);

  const list = document.createElement("div");
  list.className = "cs-list";

  const syncTrigger = () => {
    trigger.textContent = nativeSelect.options[nativeSelect.selectedIndex]?.textContent ?? "";
  };

  const close = () => {
    wrap.classList.remove("open");
    list.remove();
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
    document.removeEventListener("mousedown", onOutside, true);
  };
  const onOutside = (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node) && !list.contains(e.target as Node)) close();
  };
  wrap.addEventListener("cs:close", close);

  const open = () => {
    closeAllSelects(wrap);
    list.innerHTML = "";
    [...nativeSelect.options].forEach((opt) => {
      const item = document.createElement("div");
      item.className = "cs-opt" + (opt.value === nativeSelect.value ? " sel" : "");
      item.textContent = opt.textContent ?? "";
      item.addEventListener("click", () => {
        nativeSelect.value = opt.value;
        nativeSelect.dispatchEvent(new Event("input", { bubbles: true }));
        nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
        syncTrigger();
        close();
        trigger.focus();
      });
      list.appendChild(item);
    });
    document.body.appendChild(list);
    const r = trigger.getBoundingClientRect();
    const listH = Math.min(list.scrollHeight, 260);
    const below = window.innerHeight - r.bottom;
    const openUp = below < listH + 8 && r.top > below;
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    if (openUp) { list.style.bottom = `${window.innerHeight - r.top + 4}px`; list.style.top = ""; }
    else { list.style.top = `${r.bottom + 4}px`; list.style.bottom = ""; }
    wrap.classList.add("open");
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("mousedown", onOutside, true);
  };

  trigger.addEventListener("click", () => (wrap.classList.contains("open") ? close() : open()));
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); open(); }
  });
  nativeSelect.addEventListener("change", syncTrigger);
  syncTrigger();
}

/** Wrap every not-yet-enhanced <select> under `root` with a custom listbox. */
export function enhanceSelects(root: ParentNode): void {
  root.querySelectorAll<HTMLSelectElement>("select:not([data-enhanced])").forEach(makeCustomSelect);
}

function makeStepper(input: HTMLInputElement): void {
  input.dataset.enhanced = "1";
  const wrap = document.createElement("div");
  wrap.className = "ns-wrap";
  input.parentElement!.insertBefore(wrap, input);
  wrap.appendChild(input);

  const step = Number(input.step) || 1;
  const decimals = (String(step).split(".")[1] ?? "").length;
  const nudge = (dir: number) => {
    const cur = Number(input.value) || 0;
    let next = cur + dir * step;
    if (input.min !== "") next = Math.max(Number(input.min), next);
    if (input.max !== "") next = Math.min(Number(input.max), next);
    input.value = next.toFixed(decimals);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const mkBtn = (dir: number, cls: string, label: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ns-btn ${cls}`;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => nudge(dir));
    return b;
  };
  const col = document.createElement("div");
  col.className = "ns-btns";
  col.appendChild(mkBtn(1, "ns-btn-inc", "Increase"));
  col.appendChild(mkBtn(-1, "ns-btn-dec", "Decrease"));
  wrap.appendChild(col);
}

/** Wrap every not-yet-enhanced number <input> under `root` with +/- steppers. */
export function enhanceNumberInputs(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('input[type="number"]:not([data-enhanced])').forEach(makeStepper);
}
