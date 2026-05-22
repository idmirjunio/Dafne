const CHAVE_DOWNLOAD = "autoDownload";

function verificaEstado(callback) {
  chrome.storage.local.get([CHAVE_DOWNLOAD], (config) => { callback(config[CHAVE_DOWNLOAD] ?? true);});
  /* 
  TESTES SUGERIDOS:
  1. Verificar se os valores são booleanos (true/false) e se o valor padrão é true quando não há valor armazenado.
  2. Testar a função com diferentes valores armazenados (true, false) e verificar se o callback recebe o valor correto.
 */
  
}

function atualizaBadge(estado) {
  chrome.action.setBadgeText({ text: estado ? "ON" : "OFF" });
  chrome.action.setBadgeBackgroundColor({
    color: estado ? [76, 175, 80, 255] : [244, 67, 54, 255]
  });
  chrome.action.setTitle({
    title: estado ? "Dafne: download automático ativado" : "Dafne: download automático desativado"
  });
  /* 
   TESTES SUGERIDOS:
   1. Verificar se o texto do badge é "ON" quando estado é true e "OFF" quando estado é false.
   2. Verificar se a cor de fundo do badge é verde quando estado é true e vermelha quando estado é false.
   3. Verificar se o título do botão da extensão corresponde ao estado do auto download (ativado/desativado).
   4. Testar a função com ambos os estados (true/false) para garantir que as atualizações visuais estejam corretas. 
  */
}

function alteraEstado() {
    verificaEstado((estado) => {  
        const proximoEstado = !estado;
        chrome.storage.local.set({ [CHAVE_DOWNLOAD]: proximoEstado }, () => {atualizaBadge(proximoEstado) });
    });
}

chrome.action.onClicked.addListener(alteraEstado);

chrome.storage.onChanged.addListener((changes, typeStorage) => {
    if (typeStorage !== "local" || !changes[CHAVE_DOWNLOAD]) return;
    
  atualizaBadge(changes[CHAVE_DOWNLOAD].newValue ?? true);
});
/*
typeStorage: "local","managed","session" ou "sync"
changes: Objeto que descreve a alteração
*/

verificaEstado(atualizaBadge);
