/* Sala de espera pública: turno en consulta y lista del día (número + iniciales). Se actualiza cada 5 s. */
(() => {
  const id = new URLSearchParams(location.search).get("m") || "";
  const raiz = document.getElementById("sala");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = n => String(n).padStart(2, "0");
  const h12 = h => { if (!h) return ""; const [H, M] = h.split(":").map(Number); return `${((H + 11) % 12) + 1}:${pad(M)} ${H >= 12 ? "PM" : "AM"}`; };
  const ETQ = { espera: "En espera", consulta: "En consulta", atendido: "Atendido", cancelado: "Cancelado" };
  let ultimo = "";

  function reloj() {
    const d = new Date();
    const h = document.getElementById("hora"), f = document.getElementById("fecha");
    if (h) h.textContent = h12(`${pad(d.getHours())}:${pad(d.getMinutes())}`);
    if (f) { const t = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }); f.textContent = t[0].toUpperCase() + t.slice(1); }
  }

  function pintar(dt) {
    const firma = JSON.stringify(dt); if (firma === ultimo) return; ultimo = firma;
    const m = dt.medico, t = dt.turnos || [];
    const enC = t.find(x => x.estado === "consulta");
    const sigue = t.find(x => x.estado === "espera");
    const ini = String(m.nombre || "").split(/\s+/).filter(w => w.length > 2 && !/^dr/i.test(w)).slice(0, 2).map(w => w[0]).join("");
    raiz.innerHTML = `
      <header><span class="marca"><img src="assets/logo-a-blanco.png" alt="">ASSISTANT</span><div class="reloj"><b id="hora"></b><small id="fecha"></small></div></header>
      <div class="medico"><span class="foto" ${m.foto ? `style="background-image:url('${esc(m.foto)}')"` : ""}>${m.foto ? "" : esc(ini)}</span><div><h1>${esc(m.nombre)}</h1><p>${esc([m.especialidad, m.consultorio].filter(Boolean).join(" · "))}</p></div></div>
      <div class="grid">
        <section class="actual ${enC ? "" : "vacio"}">
          ${enC
            ? `<span class="etq">Pasa a consulta</span><span class="num-grande">${esc(enC.turno)}</span><span class="ini">${esc(enC.iniciales)}</span><span class="pulso"><i></i>En consulta ahora</span>`
            : sigue
              ? `<span class="etq">Siguiente turno</span><span class="num-grande" style="color:var(--ink)">${esc(sigue.turno)}</span><span class="ini">${esc(sigue.iniciales)}</span><span class="pulso">Programado a las ${esc(h12(sigue.hora))}</span>`
              : `<span class="etq">Sala de espera</span><span class="num-grande">Sin turnos pendientes</span>`}
        </section>
        <section class="lista"><h2>Turnos de hoy <small>${t.filter(x => x.estado === "atendido").length} de ${t.filter(x => x.estado !== "cancelado").length} atendidos</small></h2>
          ${t.length ? t.map(x => `<div class="turno ${x.estado}"><b>${esc(x.turno)}</b><span class="ti">${esc(x.iniciales)}<span class="th">${esc(h12(x.hora))}</span></span><span class="chip">${ETQ[x.estado]}</span></div>`).join("") : `<div class="vacio-lista">Hoy no hay citas registradas.</div>`}
        </section>
      </div>
      <footer><span>Espera a que tu número aparezca en pantalla. Por privacidad solo mostramos iniciales.</span><span>Se actualiza sola</span></footer>`;
    reloj();
  }

  async function cargar() {
    try {
      const r = await fetch(`${window.EC_API}/api/sala/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (r.status === 404) return error("Sala no encontrada", "Revisa el enlace que te compartió tu consultorio.");
      if (!r.ok) throw new Error();
      pintar(await r.json());
    } catch (e) { if (!ultimo) error("Conectando…", "Estamos intentando comunicarnos con el servidor. La pantalla se actualizará sola."); }
  }
  function error(t, p) { ultimo = ""; raiz.innerHTML = `<div class="error"><img src="assets/logo-a-blanco.png" alt="" width="48"><h1>${esc(t)}</h1><p style="color:var(--ink-2)">${esc(p)}</p></div>`; }

  if (!id) return error("Falta el médico", "Abre la sala desde el enlace que te compartió tu consultorio.");
  cargar(); setInterval(cargar, 5000); setInterval(reloj, 15000);
})();
