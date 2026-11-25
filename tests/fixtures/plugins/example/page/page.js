document.getElementById("where").textContent = "Served from " + location.origin;
const visits = Number(localStorage.getItem("visits") || "0") + 1;
localStorage.setItem("visits", String(visits));
document.getElementById("storage").textContent = "Opened " + visits + (visits === 1 ? " time" : " times") + "; cookies here: " + (document.cookie || "none");
const showContext = () => {
  const context = window.ardia.context;
  const shown = context ? "Beside: " + context.title + " (" + context.url + ")" : "Opened on its own";
  document.getElementById("context").textContent = shown;
  window.ardia.send({ shown });
};
window.ardia.addEventListener("context", showContext);
window.ardia.addEventListener("message", (event) => {
  document.getElementById("reply").textContent = "Helper says: " + event.data.reply;
});
showContext();
document.title = "Example ready";
const path = new URLSearchParams(location.search).get("ardiaPath");
if (path) document.querySelector("h1").textContent = "Example page at " + path;
