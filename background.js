const NATIVE_HOST_NAME = "com.meu_plugin";

let heartbeatInterval = null;
let port = null;
let nextRequestId = 1;
const pendingRequests = new Map();

/* ===============================
   Conexao com Native Host
================================ */

function getNativePort() {
  if (port) return port;

  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);

  port.onMessage.addListener(onNativeMessage);

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "Native host desconectado";
    console.error("[Native] desconectado:", err);

    for (const [requestId, request] of pendingRequests.entries()) {
      const response = {
        ok: false,
        status: "error",
        error: err,
        videoId: request.videoId,
        taskId: request.taskId
      };

      respondOnce(request, response);

      if (request.started && request.expectFinal) {
        notifyTab(request.tabId, {
          type: "DOWNLOAD_COMPLETE",
          videoId: request.videoId,
          taskId: request.taskId,
          status: "error",
          error: err
        });
      }

      cleanupRequest(requestId);
    }

    port = null;
  });

  startHeartbeat();
  return port;
}

/* ===============================
   Recebe resposta do Native
================================ */

function getMessageStatus(message) {
  return message.status ?? (message.ok === false ? "error" : "unknown");
}

function isFinalDownloadStatus(status) {
  return status === "completed" || status === "error" || status === "skipped";
}

function onNativeMessage(message) {
  console.log("[Native -> JS]", message);

  const requestId = message.requestId;
  const status = getMessageStatus(message);

  if (!requestId) {
    console.warn("Mensagem global do Native Host:", message);

    if (message.error) {
      notifyContentScript({
        type: "GLOBAL_ERROR",
        error: message.error
      });
    }
    return;
  }

  const request = pendingRequests.get(requestId);

  if (!request) {
    console.warn(`Resposta sem request pendente para requestId ${requestId}:`, message);

    if (isFinalDownloadStatus(status)) {
      notifyContentScript({
        type: "DOWNLOAD_COMPLETE",
        videoId: message.videoId,
        taskId: message.taskId,
        status,
        error: message.error,
        pid: message.pid,
        download_folder: message.download_folder
      });
    }
    return;
  }

  const hadAlreadyResponded = request.responded;
  const response = {
    ...message,
    status,
    videoId: message.videoId || request.videoId,
    taskId: message.taskId || request.taskId
  };

  respondOnce(request, response);

  if (status === "started" && request.expectFinal) {
    request.started = true;
    clearRequestTimeout(request);
    return;
  }

  if (isFinalDownloadStatus(status)) {
    if (request.expectFinal && (request.started || hadAlreadyResponded)) {
      notifyTab(request.tabId, {
        type: "DOWNLOAD_COMPLETE",
        videoId: response.videoId,
        taskId: response.taskId,
        status,
        error: response.error,
        pid: response.pid,
        download_folder: response.download_folder
      });
    }

    cleanupRequest(requestId);
    return;
  }

  cleanupRequest(requestId);
}

function respondOnce(request, response) {
  if (request.responded) return;

  request.responded = true;

  try {
    request.sendResponse(response);
  } catch (err) {
    console.error("Erro ao responder ao content script:", err);
  }
}

function clearRequestTimeout(request) {
  if (request.timeoutId) {
    clearTimeout(request.timeoutId);
    request.timeoutId = null;
  }
}

function cleanupRequest(requestId) {
  const request = pendingRequests.get(requestId);
  if (request) clearRequestTimeout(request);
  pendingRequests.delete(requestId);
}

function notifyTab(tabId, message) {
  if (!tabId) {
    notifyContentScript(message);
    return;
  }

  chrome.tabs.sendMessage(tabId, message, () => {
    if (chrome.runtime.lastError) {
      console.warn("Nao foi possivel notificar a aba:", chrome.runtime.lastError.message);
    }
  });
}

function notifyContentScript(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    chrome.tabs.sendMessage(tabs[0].id, message, () => {
      if (chrome.runtime.lastError) {
        console.warn("Nao foi possivel notificar a aba ativa:", chrome.runtime.lastError.message);
      }
    });
  });
}

/* ===============================
   Heartbeat
================================ */

function startHeartbeat() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    const activeDownloads = Array.from(pendingRequests.values())
      .filter((request) => request.expectFinal && request.started)
      .length;

    if (activeDownloads === 0) return;

    console.log(`Downloads ativos: ${activeDownloads}`);

    sendToNative(
      { action: "PING" },
      (response) => {
        if (!response || response.status !== "pong") {
          console.error("Native host nao respondeu ao ping");
        }
      },
      {
        expectFinal: false,
        timeout: 5000
      }
    );
  }, 5000);
}

chrome.runtime.onStartup.addListener(() => {
  startHeartbeat();
});

chrome.runtime.onInstalled.addListener(() => {
  startHeartbeat();
});

/* ===============================
   Envio generico
================================ */

function sendToNative(payload, sendResponse, options = {}) {
  const requestId = nextRequestId++;
  const videoId = options.videoId || payload.payload?.videoId;
  const taskId = options.taskId || payload.taskId;
  const timeout = options.timeout ?? 30000;

  let nativePort;

  try {
    nativePort = getNativePort();
  } catch (err) {
    sendResponse({
      ok: false,
      status: "error",
      error: err.message,
      videoId,
      taskId
    });
    return;
  }

  payload.requestId = requestId;
  if (taskId) payload.taskId = taskId;

  const request = {
    sendResponse,
    tabId: options.tabId,
    videoId,
    taskId,
    expectFinal: options.expectFinal ?? false,
    responded: false,
    started: false,
    timeoutId: null
  };

  request.timeoutId = setTimeout(() => {
    if (!pendingRequests.has(requestId)) return;

    const response = {
      ok: false,
      status: "timeout",
      error: "Tempo esgotado aguardando resposta do Native Host",
      videoId,
      taskId
    };

    respondOnce(request, response);

    if (request.started && request.expectFinal) {
      notifyTab(request.tabId, {
        type: "DOWNLOAD_COMPLETE",
        videoId,
        taskId,
        status: "error",
        error: response.error
      });
    }

    cleanupRequest(requestId);
  }, timeout);

  pendingRequests.set(requestId, request);

  try {
    nativePort.postMessage(payload);
  } catch (err) {
    cleanupRequest(requestId);
    sendResponse({
      ok: false,
      status: "error",
      error: err.message,
      videoId,
      taskId
    });
  }
}

/* ===============================
   Listener principal
================================ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    sendResponse({
      ok: false,
      status: "error",
      error: "Mensagem invalida"
    });
    return;
  }

  if (message.action === "PING") {
    sendToNative(
      { action: "PING" },
      sendResponse,
      {
        expectFinal: false,
        timeout: 5000
      }
    );
    return true;
  }

  if (message.action === "PROCESS_VIDEO") {
    sendToNative(
      {
        action: "PROCESS_VIDEO",
        payload: {
          videoId: message.videoId
        }
      },
      sendResponse,
      {
        tabId: sender.tab?.id,
        videoId: message.videoId,
        taskId: message.taskId,
        expectFinal: true,
        timeout: 120000
      }
    );
    return true;
  }

  sendResponse({
    ok: false,
    status: "error",
    error: "Acao desconhecida"
  });
});
