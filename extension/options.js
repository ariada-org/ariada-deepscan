const input = document.getElementById("api");
chrome.storage.sync.get({ api: "http://localhost:8080" }, ({ api }) => (input.value = api));
document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  chrome.storage.sync.set({ api: input.value.trim() }, () => (document.getElementById("msg").textContent = "Saved"));
});
