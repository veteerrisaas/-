/** Sessões passam somente pelo IPC local; nunca são gravadas em logs. */
export function validateSessionSnapshot(snapshot, username) {
  const cookies = snapshot?.cookies;
  if (snapshot?.username !== username || !Array.isArray(cookies) || cookies.length > 200
    || cookies.some((cookie) => typeof cookie?.name !== 'string' || typeof cookie.value !== 'string'
      || !/(^|\.)instagram\.com$/i.test(String(cookie.domain || '').replace(/^\./, '')))
    || !cookies.some((cookie) => cookie.name === 'sessionid' && cookie.value)
    || !cookies.some((cookie) => cookie.name === 'ds_user_id' && cookie.value)) {
    throw new Error('Sessão recebida ausente, inválida ou pertencente a outra conta.');
  }
  return { username, cookies: cookies.map((cookie) => ({ ...cookie })) };
}

export function waitForSessionInitialization(ipc, username, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      ipc.off('message', onMessage);
      ipc.off('disconnect', onDisconnect);
      error ? reject(error) : resolve(value);
    };
    const onDisconnect = () => finish(new Error('Acompanhamento encerrado durante a transferência de sessão.'));
    const onMessage = (message) => {
      if (message === 'shutdown') { onDisconnect(); return; }
      if (message?.type !== 'session-init') return;
      try { finish(null, validateSessionSnapshot(message, username)); }
      catch (error) { finish(error); }
    };
    const timer = setTimeout(() => finish(new Error('Tempo esgotado aguardando a sessão da conta ativa.')), timeoutMs);
    ipc.on('message', onMessage);
    ipc.on('disconnect', onDisconnect);
  });
}

export function attachSessionExport(ipc, getSnapshot) {
  const onMessage = async (message) => {
    if (message?.type !== 'session-snapshot-request' || typeof message.requestId !== 'string') return;
    let response;
    try {
      const snapshot = await getSnapshot();
      response = { type: 'session-snapshot', requestId: message.requestId,
        ...validateSessionSnapshot(snapshot, snapshot.username) };
    } catch {
      response = { type: 'session-snapshot', requestId: message.requestId, error: 'Sessão ativa indisponível.' };
    }
    if (ipc.connected) {
      try { ipc.send(response, () => {}); } catch { /* Encerramento do acompanhamento. */ }
    }
  };
  ipc.on('message', onMessage);
  return () => ipc.off('message', onMessage);
}
