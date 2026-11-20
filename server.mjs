import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI } from '@google/genai';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const timeZone = 'Europe/Moscow';
const schedule = [
  { time: '18:30', status: 'available' },
  { time: '19:00', status: 'busy' },
];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function calendarDates() {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = `${date.year}-${date.month}-${date.day}`;
  const nextDay = new Date(`${today}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const tomorrow = nextDay.toISOString().slice(0, 10);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return { today, tomorrow, dayAfterTomorrow: nextDay.toISOString().slice(0, 10) };
}

function checkAvailability(query, dates) {
  if (query?.kind === 'check' && !query.match) query = { ...query, match: 'day' };
  if (query?.kind === 'clarify' || query?.kind === 'other') {
    return { status: query.kind };
  }
  if (query?.kind !== 'check' ||
      typeof query.date !== 'string' || !datePattern.test(query.date) ||
      !['day', 'after', 'exact'].includes(query.match) ||
      (query.match !== 'day' &&
        (typeof query.time !== 'string' || !timePattern.test(query.time)))) {
    return { status: 'invalid_query' };
  }

  const { date, match, time } = query;
  if (date !== dates.tomorrow) return { status: 'no_data', date, slots: [] };
  const slots = schedule.filter(slot => {
    if (match === 'after') return slot.time > time;
    if (match === 'exact') return slot.time === time;
    return true;
  });
  return { status: slots.length ? 'ok' : 'no_matching_slots', date, slots };
}

function sessionConfig(dates) {
  return {
    instructions: `Ты голосовой помощник по учебному расписанию. Отвечай по-русски, кратко.
Часовой пояс: Москва. Сегодня ${dates.today}, завтра ${dates.tomorrow}, послезавтра ${dates.dayAfterTomorrow}.
Если пользователь спрашивает про день без времени, вызывай check_availability с kind=check, date=нужная дата и match=day. «Что свободно послезавтра?» — это полный запрос, уточнение не требуется.
Проверяй доступность через check_availability. Интерпретируй «завтра после шести» как match=after, time=18:00.
Для запроса на запись проверь время, если дата ясна, и поясни, что можешь лишь проверить доступность.
Используй в ответе только сведения из результата текущей проверки. available означает свободно, busy — занято.
no_data — на дату нет данных. no_matching_slots — в учебном расписании нет сведений о подходящем времени.
error — проверка временно недоступна, предложи повторить. clarify или invalid_query — уточни дату или время.
other — кратко предложи спросить о расписании. Никогда не говори, что запись оформлена.`,
    tools: [{
      type: 'function',
      name: 'check_availability',
      description: 'Проверить учебное расписание. Для неясного запроса используй clarify, для реплики вне темы — other.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['check', 'clarify', 'other'] },
          date: { type: 'string', description: 'Дата YYYY-MM-DD, обязательна при kind=check.' },
          match: { type: 'string', enum: ['day', 'after', 'exact'] },
          time: { type: 'string', description: 'Время HH:MM для after и exact.' },
        },
        required: ['kind'],
      },
    }],
  };
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/capture.mjs', ['capture.mjs', 'text/javascript; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

async function readBody(request) {
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function allowedRequest(request) {
  const host = request.headers.host || '';
  const publicOrigin = process.env.RENDER_EXTERNAL_URL || process.env.APP_ORIGIN;
  const local = /^(localhost|127\.0\.0\.1)(?::\d+)?$/.test(host);
  const origin = publicOrigin ? new URL(publicOrigin).origin : `http://${host}`;
  const validHost = local || (publicOrigin && new URL(publicOrigin).host === host);
  return validHost && (!request.headers.origin || request.headers.origin === origin);
}

export function createApp({ failFirstCheck = false } = {}) {
  let failNextCheck = failFirstCheck;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const url = new URL(request.url, 'http://localhost');
    if (!allowedRequest(request)) {
      return json(response, 403, { message: 'Используйте локальный адрес приложения.' });
    }
    try {
      const staticFile = staticFiles.get(url.pathname);
      if (request.method === 'GET' && staticFile) {
        const [name, contentType] = staticFile;
        const content = await readFile(new URL(`./public/${name}`, import.meta.url));
        response.writeHead(200, { 'Content-Type': contentType });
        response.end(content);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/schedule') {
        let query;
        try {
          const body = await readBody(request);
          if (body === null) return json(response, 413, { status: 'error' });
          query = JSON.parse(body);
        } catch {
          return json(response, 400, { status: 'invalid_query' });
        }
        const result = checkAvailability(query, calendarDates());
        if (failNextCheck && ['ok', 'no_matching_slots', 'no_data'].includes(result.status)) {
          failNextCheck = false;
          return json(response, 503, { status: 'error' });
        }
        return json(response, 200, result);
      }

      json(response, 404, { message: 'Страница не найдена.' });
    } catch (error) {
      console.error('Server error:', error.name);
      json(response, 502, { message: 'Сервис временно недоступен. Попробуйте ещё раз.' });
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/live' || !request.headers.origin || !allowedRequest(request)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      let live;
      let closed = false;
      let ready = false;
      let queue = Promise.resolve();
      const send = data => {
        if (client.readyState === 1) client.send(JSON.stringify(data));
      };
      client.on('close', () => { closed = true; live?.close(); });
      client.on('error', () => { closed = true; live?.close(); });
      client.on('message', raw => {
        if (!ready || closed) return;
        try {
          const message = JSON.parse(raw.toString());
          if (typeof message.audio === 'string') {
            live.sendRealtimeInput({ audio: { data: message.audio, mimeType: 'audio/pcm;rate=16000' } });
          }
        } catch { send({ error: 'Не удалось передать аудио.' }); }
      });
      if (!process.env.GEMINI_API_KEY) {
        send({ error: 'Добавьте GEMINI_API_KEY в .env и перезапустите сервер.' });
        client.close();
        return;
      }
      const oldConfig = sessionConfig(calendarDates());
      const declaration = oldConfig.tools[0];
      delete declaration.parameters.additionalProperties;
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { apiVersion: 'v1beta' } });
      ai.live.connect({
        model: process.env.GEMINI_LIVE_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: ['AUDIO'],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: oldConfig.instructions,
          tools: [{ functionDeclarations: [{
            name: declaration.name, description: declaration.description,
            parameters: declaration.parameters,
          }] }],
        },
        callbacks: {
          onmessage: message => {
            queue = queue.then(async () => {
              if (closed) return;
              if (message.setupComplete) send({ ready: true });
              if (message.serverContent) send({ content: message.serverContent });
              if (message.toolCall) {
                send({ checking: true });
                const functionResponses = message.toolCall.functionCalls.map(call => {
                  let result = checkAvailability(call.args, calendarDates());
                  if (failNextCheck && ['ok', 'no_data', 'no_matching_slots'].includes(result.status)) {
                    failNextCheck = false;
                    result = { status: 'error' };
                  }
                  return { id: call.id, name: call.name, response: { result } };
                });
                send({ checked: functionResponses.map(item => item.response.result) });
                live.sendToolResponse({ functionResponses });
              }
            }).catch(() => send({ error: 'Ошибка проверки расписания. Начните разговор снова.' }));
          },
          onerror: () => send({ error: 'Ошибка соединения Gemini. Проверьте ключ и доступность сервиса.' }),
          onclose: event => {
            if (!closed) {
              const reason = String(event.reason || event.code).split(process.env.GEMINI_API_KEY).join('[hidden]').slice(0, 500);
              console.error('Gemini session closed:', reason);
              const capped = event.reason?.includes('monthly spending cap');
              send({ error: capped
                ? 'Gemini отклонил сессию: у проекта исчерпан месячный лимит. Проверьте бесплатную квоту проекта в AI Studio.'
                : `Gemini закрыл соединение: ${reason}` });
            }
            client.close();
          },
        },
      }).then(session => {
        live = session;
        ready = true;
        if (closed) live.close();
        else send({ ready: true });
      }).catch(() => {
        send({ error: 'Gemini не открыл сессию. Проверьте ключ, регион и бесплатную квоту.' });
        client.close();
      });
    });
  });
  return server;

}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp({ failFirstCheck: process.env.DEMO_FAIL_FIRST_CHECK === '1' })
    .listen(port, process.env.RENDER ? '0.0.0.0' : '127.0.0.1', () => console.log(`http://localhost:${port}`));
}
