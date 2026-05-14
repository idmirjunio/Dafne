document.addEventListener("DOMContentLoaded", async () => {
  const toggleBtn = document.getElementById("toggleBtn");
  // Função para atualizar o estado visual do toggle
  function updateUI(enabled) {
    toggleBtn.textContent = enabled ? "Auto Download: ATIVADO" : "Auto Download: DESATIVADO";
    toggleBtn.style.backgroundColor = enabled ? "#4CAF50" : "#f44336";
    toggleBtn.style.color = "white";
  }
   // Carregar estado inicial do toggle
  chrome.storage.local.get(["autoDownload"], (cfg) => {
    updateUI(cfg.autoDownload ?? true);
  });
// Handler para o clique do botão de toggle
  toggleBtn.addEventListener("click", () => {
    chrome.storage.local.get(["autoDownload"], (cfg) => {
      const newState = !(cfg.autoDownload ?? true);
      chrome.storage.local.set({ autoDownload: newState }, () => updateUI(newState));
    });
  });
});
