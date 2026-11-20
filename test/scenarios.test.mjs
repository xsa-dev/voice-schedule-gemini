import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../server.mjs';

function dateInMoscow(offset) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' })
    .format(new Date());
  const date = new Date(today + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

async function runApp(t, options) {
  const server = createApp(options).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return async query => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/schedule`, {
      method: 'POST',
      body: JSON.stringify(query),
    });
    return { httpStatus: response.status, result: await response.json() };
  };
}

test('завтра после 18:00: сервер возвращает оба статуса', async t => {
  const lookup = await runApp(t);
  const { result } = await lookup({ kind: 'check', date: dateInMoscow(1), match: 'after', time: '18:00' });
  assert.deepEqual(result.slots, [
    { time: '18:30', status: 'available' },
    { time: '19:00', status: 'busy' },
  ]);
});

test('послезавтра: нет данных', async t => {
  const lookup = await runApp(t);
  const { result } = await lookup({ kind: 'check', date: dateInMoscow(2), match: 'day' });
  assert.equal(result.status, 'no_data');
});

test('ошибка проверки и успешный повтор', async t => {
  const lookup = await runApp(t, { failFirstCheck: true });
  const query = { kind: 'check', date: dateInMoscow(1), match: 'day' };
  assert.equal((await lookup(query)).httpStatus, 503);
  assert.equal((await lookup(query)).result.status, 'ok');
});
