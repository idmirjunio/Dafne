console.log("Content script carregado");

let currentDownload = null;
let downloadQueue = [];
let downloadWatchdog = null;
let lastUrl = location.href;
let nextTaskId = 1;

const DOWNLOAD_WATCHDOG_MS = 60 * 60 * 1000;

function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("v");
}

function getAutoDownloadEnabled(callback) {
  chrome.storage.local.get(["autoDownload"], (cfg) => {
    callback(cfg.autoDownload ?? true);
  });
}

function notifyNewVideo() {
  const videoId = getVideoId();
  if (!videoId) return; 

  getAutoDownloadEnabled((enabled) => {
    if (!enabled) {
      console.log("Auto download desativado. Ignorando video:", videoId);
      return;
    }

    queueOrStartDownload(videoId);
  });
}

function queueOrStartDownload(videoId) {
  console.log("Video detectado:", videoId);

  if (currentDownload?.videoId === videoId) {
    console.log("Ja esta baixando este video:", videoId);
    return;
  }

  if (downloadQueue.includes(videoId)) {
    console.log("Video ja esta na fila:", videoId);
    return;
  }

  if (currentDownload) {
    console.log("Ja ha um download em andamento. Adicionando a fila:", videoId);
    downloadQueue.push(videoId);
    return;
  }

  startDownload(videoId);
}

function startDownload(videoId) {
  const task = {
    videoId,
    taskId: `${Date.now()}-${nextTaskId++}`
  };

  currentDownload = task;
  startDownloadWatchdog(task);

  chrome.runtime.sendMessage(
    { action: "PROCESS_VIDEO", videoId, taskId: task.taskId },
    (response) => {
      if (chrome.runtime.lastError) {
        failCurrentDownload(task, chrome.runtime.lastError.message);
        return;
      }

      console.log("Resposta do background:", response);

      if (!response) {
        failCurrentDownload(task, "Background nao respondeu");
        return;
      }

      if (response.status === "started") {
        showNotification(`Iniciando download: ${videoId}`);
        return;
      }

      if (response.status === "completed" || response.status === "skipped") {
        handleDownloadComplete({
          type: "DOWNLOAD_COMPLETE",
          videoId,
          taskId: task.taskId,
          status: response.status,
          download_folder: response.download_folder,
          file: response.file,
          message: response.message
        });
        return;
      }

      if (response.status === "already_processing") {
        showNotification(`Este video ja esta sendo baixado: ${videoId}`);
        clearCurrentDownload(task);
        processNextInQueue();
        return;
      }

      if (response.status === "timeout" || response.status === "error" || response.error) {
        failCurrentDownload(task, response.error || "Erro desconhecido");
      }
    }
  );
}

function startDownloadWatchdog(task) {
  clearDownloadWatchdog();

  downloadWatchdog = setTimeout(() => {
    if (!isCurrentDownload(task.videoId, task.taskId)) return;

    console.warn("Download ficou tempo demais sem conclusao. Liberando fila:", task.videoId);
    showNotification(`Tempo esgotado: ${task.videoId}`);
    clearCurrentDownload(task);
    processNextInQueue();
  }, DOWNLOAD_WATCHDOG_MS);
}

function clearDownloadWatchdog() {
  if (!downloadWatchdog) return;
  clearTimeout(downloadWatchdog);
  downloadWatchdog = null;
}

function isCurrentDownload(videoId, taskId) {
  if (!currentDownload) return false;
  if (taskId && currentDownload.taskId) return currentDownload.taskId === taskId;
  return currentDownload.videoId === videoId;
}

function clearCurrentDownload(task) {
  if (!task || isCurrentDownload(task.videoId, task.taskId)) {
    currentDownload = null;
    clearDownloadWatchdog();
  }
}

function failCurrentDownload(task, error) {
  const videoId = task?.videoId || currentDownload?.videoId || "desconhecido";
  showNotification(`Erro: ${error}`);
  console.error("Erro no download:", videoId, error);
  clearCurrentDownload(task);
  processNextInQueue();
}

function processNextInQueue() {
  if (currentDownload || downloadQueue.length === 0) return;

  const nextVideoId = downloadQueue.shift();
  console.log("Processando proximo da fila:", nextVideoId);
  startDownload(nextVideoId);
}

function handleDownloadComplete(request) {
  const videoId = request.videoId;
  const taskId = request.taskId;
  console.log("Download concluido:", videoId, request.status);

  if (!videoId || isCurrentDownload(videoId, taskId)) {
    clearCurrentDownload({ videoId, taskId });

    if (request.status === "completed") {
      showNotification(`Download concluido: ${videoId}`);
    } else if (request.status === "skipped") {
      showNotification(`Ja existia: ${videoId}`);
    } else {
      showNotification(`Erro no download: ${request.error || "erro desconhecido"}`);
    }

    processNextInQueue();
    return;
  }

  const queuedIndex = downloadQueue.indexOf(videoId);
  if (queuedIndex !== -1) {
    downloadQueue.splice(queuedIndex, 1);
  }

  console.warn("Conclusao recebida para video que nao era o atual:", request);

  if (!currentDownload) {
    processNextInQueue();
  }
}

chrome.runtime.onMessage.addListener((request) => {
  if (request.type === "DOWNLOAD_COMPLETE") {
    handleDownloadComplete(request);
    return;
  }

  if (request.type === "GLOBAL_ERROR") {
    failCurrentDownload(currentDownload, request.error || "Erro global do Native Host");
    return;
  }

  if (request.type === "MOSTRAR_ALERTA") {
    console.log("Sucesso! O Python terminou de processar o video.");
    console.log("Resposta detalhada do Python:", request.resultado);
  }
});

function showNotification(message) {
  const notification = document.createElement("div");
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    background: #4CAF50;
    color: white;
    padding: 15px;
    border-radius: 5px;
    z-index: 10000;
    font-family: Arial, sans-serif;
    box-shadow: 0 2px 10px rgba(0,0,0,0.2);
  `;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 3000);
}

window.addEventListener("yt-navigate-finish", notifyNewVideo);
window.addEventListener("popstate", notifyNewVideo);

setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    notifyNewVideo();
  }
}, 1000);

setTimeout(notifyNewVideo, 2000);
