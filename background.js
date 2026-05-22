import './config.js';

const NOME_DO_HOST = "com.meu_plugin";

let verificadorDeDownloadsPendentes = null;
let porta = null;
let nextRequestId = 1;
const requestsPendentes = new Map();

/* ===============================
   Conexao com Native Host
================================ */

function getPorta() {
  if (porta) return porta;

  porta = chrome.runtime.connectNative(NOME_DO_HOST);

  porta.onMessage.addListener(onNativeMessage);

  porta.onDisconnect.addListener(() => {
    const falha = chrome.runtime.lastError?.message || "Native host desconectado";
    console.error("[Native] desconectado:", falha);

    for (const [requestId, request] of requestsPendentes.entries()) {
      const response = {
        ok: false,
        status: "error",
        error: falha,
        videoId: request.videoId,
        taskId: request.taskId
      };

      respondOnce(request, response);

      if (request.iniciados && request.pendentes) {
        notifyTab(request.tabId, {
          type: "DOWNLOAD_COMPLETE",
          videoId: request.videoId,
          taskId: request.taskId,
          status: "error",
          error: falha
        });
      }

      cleanupRequest(requestId);
    }

    porta = null;
  });

  iniciarVerificadorDeDownloadsPendentes();
  return porta;
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

  const request = requestsPendentes.get(requestId);

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

  if (status === "iniciados" && request.pendentes) {
    request.iniciados = true;
    clearRequestTimeout(request);
    return;
  }

  if (isFinalDownloadStatus(status)) {
    if (request.pendentes && (request.iniciados || hadAlreadyResponded)) {
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
  } catch (falha) {
    console.error("Erro ao responder ao content script:", falha);
  }
}

function clearRequestTimeout(request) {
  if (request.timeoutId) {
    clearTimeout(request.timeoutId);
    request.timeoutId = null;
  }
}

function cleanupRequest(requestId) {
  const request = requestsPendentes.get(requestId);
  if (request) clearRequestTimeout(request);
  requestsPendentes.delete(requestId);
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
   Verificação de downloads pendentes
================================ */

function iniciarVerificadorDeDownloadsPendentes() {
  if (verificadorDeDownloadsPendentes) return; /*proteção de encadeamento*/ /* TO DO: verificar proteção contra reentrância */

  verificadorDeDownloadsPendentes = setInterval(() => {
    
    const downloadsPendentes = Array.from(requestsPendentes.values()).filter((requestAtual) => requestAtual.pendentes && requestAtual.iniciados).length;

    if (downloadsPendentes === 0) return;

    console.log(`Downloads ativos: ${downloadsPendentes}`);
 
    enviar (
      {action: "PING"},
      (resposta) => {  
        if (!resposta || resposta.status !== "pong") {
          console.error("Native host nao respondeu ao ping");
        }
      },
      {
        pendentes: false,
        timeout: 5000
      }
    );
  }, 5000);
}

chrome.runtime.onStartup.addListener(() => {
  iniciarVerificadorDeDownloadsPendentes();
});

chrome.runtime.onInstalled.addListener(() => {
  iniciarVerificadorDeDownloadsPendentes();
});

/* ===============================
   Envio generico
================================ */

function enviar (payload, sendResponse, options = {}) {
  const requestId = nextRequestId++;
  const videoId = options.videoId || payload.payload?.videoId;
  const taskId = options.taskId || payload.taskId;
  const timeout = options.timeout ?? 30000;

  let nativeporta;

  try {
    nativeporta = getPorta();
  } catch (falha) {
    sendResponse({
      ok: false,
      status: "error",
      error: falha.message,
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
    pendentes: options.pendentes ?? false,
    responded: false,
    iniciados: false,
    timeoutId: null
  };

  request.timeoutId = setTimeout(() => {
    if (!requestsPendentes.has(requestId)) return;

    const response = {
      ok: false,
      status: "timeout",
      error: "Tempo esgotado aguardando resposta do Native Host",
      videoId,
      taskId
    };

    respondOnce(request, response);

    if (request.iniciados && request.pendentes) {
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

  requestsPendentes.set(requestId, request);

  try {
    nativeporta.postMessage(payload);
  } catch (falha) {
    cleanupRequest(requestId);
    sendResponse({
      ok: false,
      status: "error",
      error: falha.message,
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
    enviar(
      { action: "PING" },
      sendResponse,
      {
        pendentes: false,
        timeout: 5000
      }
    );
    return true;
  }

  if (message.action === "PROCESS_VIDEO") {
    enviar (
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
        pendentes: true,
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
