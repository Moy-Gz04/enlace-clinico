/* Dirección de la API (backend en Render). En local apunta al servidor de pruebas. */
window.EC_API = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:4600"
  : "https://enlace-clinico.onrender.com";
