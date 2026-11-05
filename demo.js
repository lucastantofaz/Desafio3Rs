"use strict";
/* Dados e comportamento de demonstração: permite ver e testar a interface sem servidor.
   Contrato que o servidor real deve seguir está descrito em app.js (objeto Api). */

const Demo = (() => {
  const caps = (extra = {}) => ({
    modes: ["cool", "fan", "dry", "heat", "auto"],
    fan_speeds: ["auto", "low", "medium", "high"],
    swing: ["off", "on"],
    temp_min: 16,
    temp_max: 30,
    temp_step: 1,
    ...extra,
  });
  const dev = (id, name, online, state) => ({
    id,
    name,
    online,
    caps: caps(),
    state: { power: false, mode: "cool", temp_c: 23, fan: "auto", swing: "off", ...state },
    last_command: online ? { status: "sent", at: Date.now() - 120000 } : null,
  });
  const many = new URLSearchParams(location.search).get("demo") === "varias";
  const all = [
    { id: 1, name: "Sala 101", devices: [dev(11, "Ar-condicionado", true, { power: true, temp_c: 22, fan: "medium", swing: "on" })] },
    { id: 2, name: "Sala 102", devices: [dev(21, "Ar-condicionado", true)] },
    { id: 3, name: "Sala 103", devices: [dev(31, "Ar-condicionado", true, { power: true, mode: "cool", temp_c: 23, fan: "auto" })] },
    { id: 4, name: "Laboratório de informática 1", devices: [
      dev(41, "Ar-condicionado fundo", true, { power: true, temp_c: 21, fan: "high", swing: "on" }),
      dev(42, "Ar-condicionado frente", true, { power: true, temp_c: 21, fan: "high" })
    ] },
    { id: 5, name: "Auditório", devices: [dev(51, "Piso-teto 48.000 BTU", true, { power: true, mode: "cool", temp_c: 24 })] },
    { id: 6, name: "Biblioteca", devices: [dev(61, "Ar-condicionado", true)] },
    { id: 7, name: "Sala dos professores", devices: [dev(71, "Ar-condicionado", false)] },
  ];
  const rooms = many ? all : all.slice(0, 1);
  const find = (id) => rooms.flatMap((r) => r.devices).find((d) => d.id === id);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    async list() { await delay(100); return structuredClone(rooms); },
    async send(id, patch) {
      const d = find(id);
      if (!d || !d.online) throw Object.assign(new Error("offline"), { code: "offline" });
      Object.assign(d.state, patch);
      d.last_command = { status: "sending", at: Date.now() };
      setTimeout(() => { d.last_command = { status: "sent", at: Date.now() }; }, 700);
      await delay(120);
    },
  };
})();
