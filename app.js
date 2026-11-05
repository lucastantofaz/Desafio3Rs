"use strict";
/* Interface de controle das salas. Sem login: o acesso é limitado pela rede/ambiente.
   Só createElement/textContent/createElementNS (nada de innerHTML).

   Contrato com o servidor (implementado em click/server.py):
     GET  /api/rooms                 -> { rooms: [ { id, name, devices: [ {
                                           id, name, online, state:{power,mode,temp_c,fan,swing},
                                           caps:{modes,fan_speeds,swing,temp_min,temp_max,temp_step},
                                           last_command: null | { status: "sending"|"sent"|"failed"|"unconfirmed", at: <ms> } } ] } ] }
     POST /api/devices/{id}/command  { state: { ...somente os campos alterados } }  -> 202
*/

const $ = (id) => document.getElementById(id);
const DEBOUNCE_MS = 350;
const POLL_MS = 3000;

const MODE = { cool: "Refrigerar", fan: "Ventilar", dry: "Secar", heat: "Aquecer", auto: "Automático" };
const FAN = { auto: "Auto", low: "Baixa", medium: "Média", high: "Alta" };

/* ------------------------------------------------------------------ util */
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k) e.append(k);
  return e;
}

const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
}

const icon = (d, extra = {}) => svg("svg", {
  viewBox: "0 0 24 24",
  class: "ico",
  "aria-hidden": "true",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.9",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  ...extra
}, ...d.split("|").map((p) => svg("path", { d: p })));

const ICONS = {
  cool: "M12 3v18|M4.6 7.5l14.8 9|M4.6 16.5l14.8-9",
  fan: "M3 8h10a3 3 0 1 0-3-3|M3 12h15a3 3 0 1 1-3 3|M3 16h7",
  dry: "M12 3.5s6 6 6 10.5a6 6 0 0 1-12 0C6 9.5 12 3.5 12 3.5z",
  heat: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z|M12 2.5v2|M12 19.5v2|M2.5 12h2|M19.5 12h2|M5.3 5.3l1.4 1.4|M17.3 17.3l1.4 1.4|M5.3 18.7l1.4-1.4|M17.3 6.7l1.4-1.4",
  auto: "M5 18l7-13 7 13|M8 13.5h8",
  power: "M12 3v8|M6.6 6.8a8 8 0 1 0 10.8 0",
  minus: "M6 12h12",
  plus: "M12 6v12|M6 12h12",
  check: "M20 6L9 17l-5-5",
};

/* ------------------------------------------------------------------ dados */
const Api = {
  mode: "real",
  async list() {
    if (this.mode === "demo") return Demo.list();
    const r = await fetch("/api/rooms", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("http " + r.status);
    return (await r.json()).rooms;
  },
  async send(id, patch) {
    if (this.mode === "demo") return Demo.send(id, patch);
    const r = await fetch(`/api/devices/${id}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: patch }),
    });
    if (!r.ok) {
      let msg = "";
      try { msg = (await r.json()).error.message; } catch { /* sem corpo */ }
      throw Object.assign(new Error(msg || "http " + r.status), {
        code: r.status === 503 ? "offline" : r.status === 429 ? "busy" : r.status === 422 ? "invalid" : "error"
      });
    }
  },
};

const S = {
  rooms: [],
  roomId: null,
  filter: "",
  statusFilter: "all",
  pending: new Map() /* deviceId -> {patch, timer} */
};

const view = (dev) => ({ ...dev.state, ...(S.pending.get(dev.id)?.patch || {}) });
const allDevices = () => S.rooms.flatMap((r) => r.devices);

/* ------------------------------------------------------------------- toast */
let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

/* ------------------------------------------------ resumo no cabeçalho */
function renderSummaryPills() {
  const box = $("summaryPills");
  if (!box) return;
  const devs = allDevices();
  const onCount = devs.filter((d) => d.online && view(d).power).length;
  const offCount = devs.filter((d) => !d.online).length;

  box.replaceChildren(
    el("span", { class: "sum-pill" },
      el("span", { text: "Salas:" }),
      el("span", { class: "sum-val", text: String(S.rooms.length) })
    ),
    el("span", { class: "sum-pill" },
      el("span", { text: "Ligados:" }),
      el("span", { class: "sum-val", text: `${onCount}/${devs.length}` })
    ),
    el("span", { class: "sum-pill" },
      el("span", { text: "Sem conexão:" }),
      el("span", { class: "sum-val", text: String(offCount) })
    )
  );
}

/* ------------------------------------------------------------ lista de salas */
function roomSummary(r) {
  const off = r.devices.filter((d) => !d.online).length;
  const activeDevs = r.devices.filter((d) => d.online && view(d).power);
  const on = activeDevs.length;
  const n = r.devices.length;
  const base = `${n} ${n === 1 ? "aparelho" : "aparelhos"}`;
  const avgTemp = on ? Math.round(activeDevs.reduce((s, d) => s + view(d).temp_c, 0) / on) : null;

  if (off === n) return { cls: "down", text: "Sem conexão", badge: null };
  if (off) return { cls: "on", text: `${base} · ${on} ligado${on === 1 ? "" : "s"} · ${off} sem conexão`, badge: avgTemp ? `${avgTemp}°C` : null };
  if (on) return { cls: "on", text: `${on === n ? "Ligado" : `${on} de ${n} ligados`}`, badge: avgTemp ? `${avgTemp}°C` : null };
  return { cls: "idle", text: "Desligado", badge: null };
}

function renderRoomList() {
  const q = S.filter.trim().toLowerCase();
  const list = $("roomList");

  const items = S.rooms.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false;
    if (S.statusFilter === "on") return r.devices.some((d) => d.online && view(d).power);
    if (S.statusFilter === "offline") return r.devices.some((d) => !d.online);
    return true;
  });

  list.replaceChildren(...items.map((r) => {
    const s = roomSummary(r);
    return el("li", {},
      el("a", {
        href: `#/sala/${r.id}`,
        class: `room ${r.id === S.roomId ? "current" : ""}`,
        "aria-current": r.id === S.roomId ? "page" : null,
      },
        el("span", { class: "room-left" },
          el("span", { class: `dot ${s.cls}`, "aria-hidden": "true" }),
          el("span", { class: "room-text" },
            el("span", { class: "room-name", text: r.name }),
            el("span", { class: "room-sub", text: s.text })
          )
        ),
        s.badge ? el("span", { class: "room-badge-temp", text: s.badge }) : ""
      )
    );
  }));

  if (!items.length) {
    list.append(el("li", { class: "empty-small", text: "Nenhuma sala encontrada." }));
  }
}

/* -------------------------------------- Ilustrações Vetoriais Planas (SVG) */
function roomHeaderIllustration(isActive, isOffline) {
  const strokeColor = "#0c3b25";
  const accentColor = isOffline ? "#cd2a2e" : isActive ? "#2f9e41" : "#96a79d";
  const bgFill = isOffline ? "#fceaea" : isActive ? "#e5f3e8" : "#e8eeea";

  return svg("svg", { viewBox: "0 0 56 56", class: "room-emblem-svg", "aria-hidden": "true" },
    svg("rect", { x: "2", y: "2", width: "52", height: "52", rx: "12", fill: bgFill, stroke: strokeColor, "stroke-width": "2" }),
    // Quadro/Lousa da Sala e Aparelho no Topo
    svg("rect", { x: "12", y: "10", width: "32", height: "9", rx: "2.5", fill: "#ffffff", stroke: strokeColor, "stroke-width": "2" }),
    svg("line", { x1: "16", y1: "15", x2: "40", y2: "15", stroke: accentColor, "stroke-width": "2", "stroke-linecap": "round" }),
    svg("rect", { x: "10", y: "25", width: "36", height: "19", rx: "2", fill: "#ffffff", stroke: strokeColor, "stroke-width": "2" }),
    svg("line", { x1: "16", y1: "32", x2: "30", y2: "32", stroke: accentColor, "stroke-width": "2.2", "stroke-linecap": "round" }),
    svg("line", { x1: "16", y1: "37", x2: "24", y2: "37", stroke: strokeColor, "stroke-width": "2", "stroke-linecap": "round" }),
    svg("circle", { cx: "38", cy: "35", r: "3.5", fill: accentColor })
  );
}

function acSplitIllustration(v, isOn, isOnline) {
  const modeColors = {
    cool: "#186cb8",
    heat: "#d45b12",
    dry: "#0d7a6f",
    fan: "#237a31",
    auto: "#0c3b25"
  };
  const waveColor = modeColors[v.mode] || "#2f9e41";
  const ledColor = !isOnline ? "#cd2a2e" : isOn ? "#2f9e41" : "#96a79d";

  const captionText = !isOnline
    ? "Emissor sem conexão"
    : isOn
      ? `Fluxo ativo · Vent. ${FAN[v.fan] || v.fan} · Aletas ${v.swing === "on" ? "oscilando" : "fixas"}`
      : "Aparelho em espera (aletas fechadas)";

  const waves = isOn ? [
    svg("path", { d: "M48 48 C44 55, 52 60, 48 66", stroke: waveColor, "stroke-width": "2.4", "stroke-linecap": "round", fill: "none" }),
    svg("path", { d: "M84 48 C80 55, 88 60, 84 66", stroke: waveColor, "stroke-width": "2.4", "stroke-linecap": "round", fill: "none" }),
    svg("path", { d: "M110 48 C106 55, 114 60, 110 66", stroke: waveColor, "stroke-width": "2.4", "stroke-linecap": "round", fill: "none" }),
    svg("path", { d: "M136 48 C132 55, 140 60, 136 66", stroke: waveColor, "stroke-width": "2.4", "stroke-linecap": "round", fill: "none" }),
    svg("path", { d: "M172 48 C168 55, 176 60, 172 66", stroke: waveColor, "stroke-width": "2.4", "stroke-linecap": "round", fill: "none" })
  ] : [];

  return el("div", { class: "ac-illustration-box", "aria-hidden": "true" },
    svg("svg", { viewBox: "0 0 220 68", class: "ac-split-svg" },
      // Corpo do Ar-Condicionado Split
      svg("rect", { x: "20", y: "6", width: "180", height: "38", rx: "7", fill: "#ffffff", stroke: "#0c3b25", "stroke-width": "2.2" }),
      // Linha de acabamento frontal
      svg("line", { x1: "28", y1: "16", x2: "160", y2: "16", stroke: "#d2ddd6", "stroke-width": "2", "stroke-linecap": "round" }),
      // Visor Digital no Split + LED
      svg("rect", { x: "168", y: "12", width: "22", height: "12", rx: "2.5", fill: "#0c3b25" }),
      svg("circle", { cx: "162", cy: "18", r: "2.8", fill: ledColor }),
      svg("text", {
        x: "179",
        y: "21",
        fill: "#ffffff",
        "font-family": "monospace",
        "font-size": "8.5",
        "font-weight": "700",
        "text-anchor": "middle"
      }, document.createTextNode(isOn ? `${v.temp_c}°` : "--")),
      // Aleta inferior (aberta quando ligado, fechada quando desligado)
      svg("rect", {
        x: "26",
        y: isOn ? "37" : "35",
        width: "168",
        height: isOn ? "6" : "4",
        rx: "2",
        fill: isOn ? waveColor : "#d2ddd6",
        stroke: "#0c3b25",
        "stroke-width": "1.6"
      }),
      ...waves
    ),
    el("span", { class: "ac-caption", text: captionText })
  );
}

/* --------------------------------------------------------------- dial SVG */
function polar(cx, cy, r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function dial(v, caps, on) {
  const START = 135, SPAN = 270, cx = 130, cy = 130, r = 98;
  const range = Math.max(1, caps.temp_max - caps.temp_min);
  const f = Math.min(1, Math.max(0, (v.temp_c - caps.temp_min) / range));
  const end = START + SPAN * f;

  const totalTicks = 14;
  const ticks = [];
  for (let i = 0; i <= totalTicks; i++) {
    const tf = i / totalTicks;
    const deg = START + SPAN * tf;
    const [x1, y1] = polar(cx, cy, r + 12, deg);
    const [x2, y2] = polar(cx, cy, r + 19, deg);
    const lit = on && tf <= f + 0.005;
    ticks.push(svg("line", {
      x1: x1.toFixed(2),
      y1: y1.toFixed(2),
      x2: x2.toFixed(2),
      y2: y2.toFixed(2),
      class: `tick ${lit ? "lit" : ""}`
    }));
  }

  const [minX, minY] = polar(cx, cy, r + 26, START);
  const [maxX, maxY] = polar(cx, cy, r + 26, START + SPAN);
  const [thumbX, thumbY] = polar(cx, cy, r, end);

  return svg("svg", { viewBox: "0 0 260 260", class: "dial-svg", "aria-hidden": "true" },
    svg("circle", { cx, cy, r: r - 14, class: "dial-face" }),
    ...ticks,
    svg("text", { x: minX.toFixed(1), y: (minY + 4).toFixed(1), class: "scale-txt" }, document.createTextNode(`${caps.temp_min}°`)),
    svg("text", { x: maxX.toFixed(1), y: (maxY + 4).toFixed(1), class: "scale-txt" }, document.createTextNode(`${caps.temp_max}°`)),
    svg("path", { d: arcPath(cx, cy, r, START, START + SPAN), class: "track" }),
    on && f > 0 ? svg("path", { d: arcPath(cx, cy, r, START, end), class: "value" }) : "",
    on ? svg("circle", { cx: thumbX.toFixed(2), cy: thumbY.toFixed(2), r: "7", class: "thumb" }) : ""
  );
}

function statusChip(dev) {
  const c = dev.last_command;
  const when = c ? new Date(c.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  if (!dev.online) return ["bad", "Sem conexão"];
  if (S.pending.has(dev.id)) return ["busy", "Ajustando…"];
  if (!c) return ["", "Aguardando comando"];
  switch (c.status) {
    case "sending": return ["busy", "Enviando…"];
    case "sent": return ["good", `Enviado às ${when}`];
    case "failed": return ["bad", "Não foi enviado"];
    default: return ["warn", `Sem confirmação (${when})`];
  }
}

function segmented(label, key, options, labels, value, enabled, onPick, withIcons) {
  const grp = el("div", { class: "seg", role: "radiogroup", "aria-label": label });
  for (const o of options) {
    const b = el("button", {
      type: "button",
      role: "radio",
      class: `seg-btn ${withIcons ? "with-ico" : ""} ${o === value ? "sel" : ""}`,
      "aria-checked": o === value ? "true" : "false",
      "data-key": `${key}-${o}`,
      disabled: !enabled,
      onclick: () => onPick(o),
    }, withIcons ? icon(ICONS[o] || ICONS.auto) : "", el("span", { text: labels[o] || o }));
    grp.append(b);
  }
  return el("div", { class: "group" }, el("h4", { text: label }), grp);
}

function panel(dev) {
  const caps = dev.caps, v = view(dev), on = dev.online;
  const canTemp = caps.temp_min < caps.temp_max;
  const step = caps.temp_step || 1;
  const bump = (d) => change(dev, { temp_c: Math.min(caps.temp_max, Math.max(caps.temp_min, view(dev).temp_c + d * step)) });
  const [chipCls, chipText] = statusChip(dev);
  const isOn = on && v.power;

  const dialBox = el("div", { class: `dial ${isOn ? "is-on" : ""} ${S.pending.has(dev.id) ? "is-pending" : ""}` },
    dial(v, caps, isOn),
    el("div", { class: "readout" },
      el("div", { class: "temp" },
        el("span", { class: "n", text: isOn || canTemp ? String(v.temp_c) : "—" }),
        el("span", { class: "u", text: "°C" })
      ),
      el("div", { class: "state", text: !on ? "Sem conexão" : isOn ? MODE[v.mode] || v.mode : "Desligado" })
    ),
    canTemp ? el("button", {
      type: "button",
      class: "round minus",
      "aria-label": "Diminuir temperatura",
      "data-key": "minus",
      disabled: !on || !v.power || v.temp_c <= caps.temp_min,
      onclick: () => bump(-1)
    }, icon(ICONS.minus)) : "",
    el("button", {
      type: "button",
      class: `power ${isOn ? "is-on" : ""}`,
      "aria-pressed": isOn ? "true" : "false",
      "aria-label": v.power ? "Desligar" : "Ligar",
      "data-key": "power",
      disabled: !on,
      onclick: () => change(dev, { power: !view(dev).power })
    }, icon(ICONS.power, { "stroke-width": "2.2" })),
    canTemp ? el("button", {
      type: "button",
      class: "round plus",
      "aria-label": "Aumentar temperatura",
      "data-key": "plus",
      disabled: !on || !v.power || v.temp_c >= caps.temp_max,
      onclick: () => bump(1)
    }, icon(ICONS.plus)) : ""
  );

  const ctl = on && v.power;
  const body = el("div", { class: "controls" },
    caps.modes.length > 1 ? segmented("Modo", "mode", caps.modes, MODE, v.mode, ctl, (m) => change(dev, { mode: m }), true) : "",
    caps.fan_speeds.length > 1 ? segmented("Ventilador", "fan", caps.fan_speeds, FAN, v.fan, ctl, (f) => change(dev, { fan: f }), false) : "",
    caps.swing.length > 1 ? el("div", { class: "group row" },
      el("h4", { text: "Oscilação das aletas" }),
      el("button", {
        type: "button",
        class: `switch ${v.swing === "on" ? "sel" : ""}`,
        role: "switch",
        "aria-checked": v.swing === "on" ? "true" : "false",
        "aria-label": "Oscilação das aletas",
        "data-key": "swing",
        disabled: !ctl,
        onclick: () => change(dev, { swing: view(dev).swing === "on" ? "off" : "on" })
      }, el("span", { class: "knob" }))
    ) : ""
  );

  return el("article", {
    class: `unit m-${v.mode} ${isOn ? "is-on" : ""} ${on ? "" : "offline"}`,
    "aria-label": dev.name
  },
    el("header", { class: "unit-head" },
      el("h3", { text: dev.name }),
      el("span", { class: `chip ${chipCls}`, text: chipText })
    ),
    acSplitIllustration(v, isOn, on),
    dialBox,
    !on ? el("p", {
      class: "hint bad",
      text: "O emissor desta sala não está respondendo. Os comandos ficam desativados até a conexão voltar."
    }) : "",
    body
  );
}

function batchRoomCommand(room, patch, msg) {
  const onlineDevs = room.devices.filter((d) => d.online);
  if (!onlineDevs.length) return;
  for (const d of onlineDevs) change(d, patch);
  if (msg) toast(msg);
}

function renderStage() {
  const stage = $("stage");
  const focusKey = document.activeElement?.dataset?.key;
  const focusUnit = document.activeElement?.closest?.(".unit");
  const unitIdx = focusUnit ? [...stage.querySelectorAll(".unit")].indexOf(focusUnit) : -1;
  const room = S.rooms.find((r) => r.id === S.roomId);

  if (!room) {
    stage.replaceChildren(
      el("div", { class: "empty" },
        roomHeaderIllustration(false, false),
        el("h2", { text: S.rooms.length ? "Escolha uma sala" : "Nenhuma sala cadastrada" }),
        el("p", { text: S.rooms.length ? "Selecione uma sala na lista ao lado para controlar o ar-condicionado." : "Cadastre salas e aparelhos para começar." })
      )
    );
    return;
  }

  const s = roomSummary(room);
  const hasOnline = room.devices.length > 1 && room.devices.some((d) => d.online);  // ações em lote só fazem sentido com 2+ aparelhos
  const anyOn = room.devices.some((d) => d.online && view(d).power);
  const allOffline = room.devices.every((d) => !d.online);

  stage.replaceChildren(
    el("div", { class: "stage-head" },
      el("div", { class: "stage-head-left" },
        roomHeaderIllustration(anyOn, allOffline),
        el("div", { class: "stage-title-group" },
          el("h1", { text: room.name }),
          el("div", { class: "stage-meta" },
            el("p", { class: `sum ${s.cls}`, text: s.text })
          )
        )
      ),
      hasOnline ? el("div", { class: "stage-actions" },
        el("button", {
          type: "button",
          class: "action-btn",
          onclick: () => batchRoomCommand(room, { power: true, mode: "cool", temp_c: 23, fan: "auto" }, `Padrão 23 °C aplicado em ${room.name}.`)
        }, icon(ICONS.check), el("span", { text: "Padronizar 23 °C" })),
        anyOn ? el("button", {
          type: "button",
          class: "action-btn danger-btn",
          onclick: () => batchRoomCommand(room, { power: false }, `Desligando aparelhos de ${room.name}…`)
        }, icon(ICONS.power), el("span", { text: "Desligar sala" })) : ""
      ) : ""
    ),
    el("div", { class: `units n${Math.min(room.devices.length, 3)}` }, ...room.devices.map(panel)),
    el("p", {
      class: "note-box",
      text: "O sinal infravermelho é de uma via: “Enviado” indica que o emissor da sala transmitiu o comando, não que o aparelho confirmou a execução. Se alguém usar o controle remoto físico na sala, o painel pode ficar desatualizado."
    })
  );

  if (focusKey && unitIdx >= 0) {
    const u = stage.querySelectorAll(".unit")[unitIdx];
    const t = u && u.querySelector(`[data-key="${focusKey}"]`);
    if (t && !t.disabled) t.focus({ preventScroll: true });
  }
}

function render() {
  document.querySelector(".shell").classList.toggle("single", S.rooms.length <= 1);
  document.querySelector(".summary-pills").hidden = S.rooms.length <= 1;
  renderSummaryPills();
  renderRoomList();
  renderStage();
}

/* ------------------------------------------------------------------ ações */
function change(dev, part) {
  const cur = S.pending.get(dev.id) || { patch: {}, timer: null };
  cur.patch = { ...cur.patch, ...part };
  clearTimeout(cur.timer);
  cur.timer = setTimeout(() => flush(dev.id), part.power !== undefined ? 0 : DEBOUNCE_MS);
  S.pending.set(dev.id, cur);
  render();
}

async function flush(id) {
  const cur = S.pending.get(id);
  if (!cur) return;
  S.pending.delete(id);
  const patch = cur.patch;
  const d = allDevices().find((x) => x.id === id);
  if (d) {
    Object.assign(d.state, patch);
    d.last_command = { status: "sending", at: Date.now() };
    render();
  }
  try {
    await Api.send(id, patch);
  } catch (e) {
    toast(
      e.code === "offline" ? "Emissor sem conexão: o comando não foi enviado."
      : e.code === "busy" ? "Muitos comandos em pouco tempo. Aguarde alguns segundos."
      : e.code === "invalid" ? "Esse ajuste não é aceito por este aparelho."
      : "Não foi possível enviar o comando. Tente novamente."
    );
  }
  if (!S.pending.has(id)) await refresh();
}

let serverDown = false;
function setServerDown(down) {
  if (down === serverDown && (down === false || $("stage").querySelector(".banner-down"))) return;
  serverDown = down;
  if (down) {
    const b = el("p", { class: "banner-down", role: "alert", text: "Sem conexão com o servidor. Os comandos não estão sendo enviados; tentando novamente…" });
    $("stage").prepend(b);
  } else render();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const rooms = await Api.list();
    S.rooms = rooms;
    if (S.roomId == null || !rooms.some((r) => r.id === S.roomId)) {
      const fromHash = /^#\/sala\/(\d+)$/.exec(location.hash);
      S.roomId = fromHash && rooms.some((r) => r.id === +fromHash[1]) ? +fromHash[1] : (rooms[0] ? rooms[0].id : null);
    }
    render();
    setServerDown(false);
  } catch {
    setServerDown(true);
  } finally {
    refreshing = false;
  }
}

/* ---------------------------------------------------------------- partida */
window.addEventListener("hashchange", () => {
  const m = /^#\/sala\/(\d+)$/.exec(location.hash);
  if (m) {
    S.roomId = +m[1];
    render();
    window.scrollTo({ top: 0 });
  }
});

$("search").addEventListener("input", (e) => {
  S.filter = e.target.value;
  renderRoomList();
});

document.querySelectorAll("[data-status-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    S.statusFilter = btn.dataset.statusFilter;
    document.querySelectorAll("[data-status-filter]").forEach((b) => b.classList.toggle("active", b === btn));
    renderRoomList();
  });
});

setInterval(() => {
  if (document.visibilityState === "visible" && !S.pending.size) refresh();
}, POLL_MS);

(async () => {
  const forceDemo = new URLSearchParams(location.search).has("demo") || location.protocol === "file:";
  // Demonstração só quando pedida (?demo) ou ao abrir o arquivo direto. Com servidor fora do ar
  // NÃO caímos em demonstração: isso faria parecer que o ar-condicionado está sendo controlado.
  Api.mode = forceDemo ? "demo" : "real";
  $("demoTag").hidden = Api.mode !== "demo";
  await refresh();
})();
