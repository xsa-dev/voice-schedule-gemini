const start = document.querySelector('#start');
const end = document.querySelector('#end');
const messages = document.querySelector('#messages');
const state = document.querySelector('#state');
const connection = document.querySelector('#connection');
const errorNote = document.querySelector('#error');
let active;

function stage(session, value, label) {
  if (active !== session) return;
  session.listening = value === 'listening';
  state.dataset.stage = value;
  state.textContent = label;
}
function finish(session, error) {
  if (active !== session) return;
  stage(session, error ? 'error' : 'ended', error ? 'Ошибка' : 'Разговор завершён');
  active = undefined;
  clearTimeout(session.timeout);
  clearTimeout(session.drain);
  session.capture?.disconnect();
  session.source?.disconnect();
  session.mic?.getTracks().forEach(track => track.stop());
  for (const source of session.playing) source.stop();
  session.context?.close();
  session.socket?.close();
  connection.textContent = 'Нет соединения';
  errorNote.textContent = error || '';
  start.disabled = false;
  end.disabled = true;
}
function text(session, role, value) {
  let body = session.rows.get(role);
  if (!body) {
    const row = document.createElement('article');
    row.className = role === 'Вы' ? 'user-message' : 'assistant-message';
    const label = document.createElement('strong');
    label.textContent = role;
    body = document.createElement('p');
    row.append(label, body);
    messages.append(row);
    session.rows.set(role, body);
  }
  body.textContent += value;
  messages.scrollTop = messages.scrollHeight;
}
function play(session, data, rate) {
  const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  const pcm = new DataView(bytes.buffer);
  const buffer = session.context.createBuffer(1, bytes.length / 2, rate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) samples[index] = pcm.getInt16(index * 2, true) / 32768;
  const source = session.context.createBufferSource();
  source.buffer = buffer;
  source.connect(session.context.destination);
  const at = Math.max(session.context.currentTime, session.nextAudio);
  session.nextAudio = at + buffer.duration;
  session.playing.add(source);
  source.onended = () => session.playing.delete(source);
  source.start(at);
}
start.addEventListener('click', async () => {
  const session = { rows: new Map(), playing: new Set(), nextAudio: 0, listening: false, checked: false };
  active = session;
  start.disabled = true;
  end.disabled = false;
  messages.replaceChildren();
  errorNote.textContent = '';
  connection.textContent = 'Устанавливаем соединение';
  stage(session, 'connecting', 'Подключаемся');
  try {
    session.context = new AudioContext();
    await session.context.resume();
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    if (active !== session) { mic.getTracks().forEach(track => track.stop()); return; }
    session.mic = mic;
    mic.getAudioTracks()[0].onended = () => finish(session, 'Микрофон отключился.');
    await session.context.audioWorklet.addModule('/capture.mjs');
    if (active !== session) return;
    session.source = session.context.createMediaStreamSource(mic);
    session.capture = new AudioWorkletNode(session.context, 'capture');
    session.source.connect(session.capture);
    session.capture.connect(session.context.destination);
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`);
    session.socket = socket;
    session.capture.port.onmessage = ({ data }) => {
      if (active !== session || !session.listening || socket.readyState !== 1) return;
      const bytes = new Uint8Array(data);
      socket.send(JSON.stringify({ audio: btoa(String.fromCharCode(...bytes)) }));
    };
    session.timeout = setTimeout(() => finish(session, 'Истекло время подключения к Gemini.'), 20000);
    socket.onmessage = ({ data }) => {
      if (active !== session) return;
      try {
        const message = JSON.parse(data);
        if (message.error) { finish(session, message.error); return; }
        if (message.ready) {
          clearTimeout(session.timeout);
          connection.textContent = 'Соединение установлено';
          stage(session, 'listening', 'Слушает');
        }
        if (message.checking) stage(session, 'checking', 'Проверяет расписание');
        if (message.checked) {
          session.checked = true;
          if (message.checked.some(result => result.status === 'error')) {
            text(session, 'Проверка расписания', 'Проверка временно недоступна. Повторите вопрос после ответа.');
          }
          stage(session, 'answering', 'Готовит ответ');
        }
        const content = message.content;
        if (!content) return;
        if (content.inputTranscription?.text) {
          text(session, 'Вы', content.inputTranscription.text);
        }
        if (content.outputTranscription?.text) text(session, 'Помощник', content.outputTranscription.text);
        for (const part of content.modelTurn?.parts || []) {
          if (part.inlineData?.data) {
            stage(session, 'speaking', 'Озвучивает ответ');
            const rate = Number(part.inlineData.mimeType?.match(/rate=(\d+)/)?.[1] || 24000);
            play(session, part.inlineData.data, rate);
          }
        }
        if (content.turnComplete) {
          const delay = Math.max(0, session.nextAudio - session.context.currentTime) * 1000;
          clearTimeout(session.drain);
          session.drain = setTimeout(() => {
            if (active !== session) return;
            session.rows.clear();
            session.checked = false;
            stage(session, 'listening', 'Слушает');
          }, delay + 100);
        }
      } catch { finish(session, 'Не удалось обработать ответ Gemini. Начните новый разговор.'); }
    };
    socket.onerror = () => finish(session, 'Не удалось подключиться к серверу.');
    socket.onclose = () => finish(session, 'Соединение прервалось. Начните новый разговор.');
  } catch (error) {
    finish(session, error.name === 'NotAllowedError' ? 'Разрешите доступ к микрофону и попробуйте снова.' : 'Не удалось запустить микрофон и голосовую сессию.');
  }
});
end.addEventListener('click', () => { if (active) finish(active); });
window.addEventListener('pagehide', () => { if (active) finish(active); });
