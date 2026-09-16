// =============================================================================
//  Ручная проверка напоминаний — НЕ по расписанию, отдельный адрес.
// =============================================================================
//  Зачем этот файл существует отдельно от send-reminders.js: у Netlify
//  плановые функции (со schedule в netlify.toml) нельзя вызвать напрямую по
//  ссылке — только по расписанию или кнопкой «Run now» в интерфейсе Netlify,
//  и в обоих случаях функция получает вызов БЕЗ каких-либо параметров.
//  Значит, «Run now» на send-reminders.js — это всегда настоящая, боевая
//  рассылка ВСЕМ клиентам, у кого запись на завтра, а не безобидный тест.
//
//  Эта функция — обычная (в netlify.toml для неё нет schedule), поэтому у неё
//  есть свой обычный адрес, и в него можно передать номер телефона: тогда
//  сообщение уйдёт СТРОГО одной этой записи, а не всем подряд. Без указанного
//  номера функция ничего не отправляет — специально, чтобы её нельзя было
//  случайно вызвать «как есть» и разослать напоминания всем.
//
//  Доступ закрыт ключом (переменная окружения REMINDERS_TEST_KEY) — иначе
//  адрес функции виден в открытом репозитории на GitHub, и без такой защиты
//  теоретически кто угодно мог бы дёргать чужой WhatsApp-номер запросами.
//
//  Тестовая отправка НЕ трогает reminder_sent — вечером по расписанию эта же
//  запись (если она настоящая, а не тестовая и её не удалили) получит ещё и
//  обычное напоминание. Для теста создавайте отдельную тестовую запись на
//  свой личный номер и удаляйте её после проверки.
//
//  ВАЖНО: текст сообщения и адрес Whapi продублированы из send-reminders.js
//  (общий модуль здесь не заводили ради одного лишнего каталога и лишнего
//  коммита при деплое) — при изменении текста напоминания меняйте его в ОБОИХ
//  файлах.
// =============================================================================

const { connect, CONFIG, normalizePhone, loadSettings } = require('./lib/core');

function tomorrowDateStr() {
  const shifted = new Date(Date.now() + CONFIG.tzOffsetHours * 3600 * 1000 + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

function formatTimeRu(timeStr) {
  return `в ${timeStr}`;
}

function buildMessage({ clientName, timeStr, serviceName, salonName }) {
  const name = clientName ? clientName.split(' ')[0] : '';
  const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  const service = serviceName ? ` на «${serviceName}»` : '';
  return (
    `${greeting} Напоминаем: завтра ждём вас в ${salonName} ` +
    `${formatTimeRu(timeStr)}${service}. ` +
    `Адрес: Ардзинба 148. Если планы изменились — напишите нам сюда же, ` +
    `перенесём запись.`
  );
}

async function sendWhapiMessage(phoneDigits, body) {
  const token = process.env.WHAPI_TOKEN;
  if (!token) {
    throw new Error('Не задана переменная окружения WHAPI_TOKEN');
  }
  const res = await fetch('https://gate.whapi.cloud/messages/text', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: phoneDigits, body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Whapi ответил ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
}

function json(statusCode, obj) {
  return { statusCode, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};

  const expectedKey = process.env.REMINDERS_TEST_KEY;
  if (!expectedKey) {
    return json(500, { error: 'Не задана переменная окружения REMINDERS_TEST_KEY — тест отключён, пока её не добавите в Netlify.' });
  }
  if ((params.key || '') !== expectedKey) {
    return json(401, { error: 'Неверный или отсутствующий ключ (?key=...)' });
  }

  const phoneRaw = (params.phone || '').trim();
  if (!phoneRaw) {
    return json(400, { error: 'Укажите номер телефона в ?phone=... — без него тест ничего не отправит.' });
  }
  const normalized = normalizePhone(phoneRaw);
  if (!normalized.ok) {
    return json(400, { error: 'Не удалось распознать номер телефона: ' + normalized.reason });
  }

  const client = await connect();
  try {
    const settings = await loadSettings(client);
    const targetDate = tomorrowDateStr();
    // Строго ОДНА запись: на завтра и с этим номером телефона. Даже если у
    // клиента с этим номером несколько записей на завтра — берём первую по
    // времени, этого достаточно, чтобы проверить, что сообщение доходит.
    const { rows } = await client.query(
      `
      SELECT a.id, a.time, a.phone, a.client_name,
             COALESCE(s.name, '') AS service_name
      FROM appointments a
      LEFT JOIN services s ON s.id = a.service_id
      WHERE a.date = $1
        AND a.phone = $2
        AND a.status NOT IN ('Отменён клиентом', 'Отменён салоном', 'Не пришёл')
      ORDER BY a.time
      LIMIT 1
      `,
      [targetDate, normalized.phone]
    );

    if (!rows.length) {
      return json(404, {
        error: `На ${targetDate} не найдено активной записи с номером ${normalized.phone}. Создайте тестовую запись на завтра с этим номером и повторите запрос.`,
        date: targetDate,
      });
    }

    const appt = rows[0];
    const message = buildMessage({
      clientName: appt.client_name,
      timeStr: appt.time,
      serviceName: appt.service_name,
      salonName: settings.salonName,
    });

    // ?dryRun=1 — показать, что и кому будет отправлено, но ничего реально не
    // отправлять. Полезно проверить текст сообщения перед первой боевой
    // отправкой на свой телефон.
    if (params.dryRun === '1' || params.dryRun === 'true') {
      return json(200, { dryRun: true, date: targetDate, wouldSendTo: normalized.phone, message });
    }

    const phoneDigits = normalized.phone.replace(/\D/g, '');
    await sendWhapiMessage(phoneDigits, message);

    return json(200, { ok: true, date: targetDate, sentTo: normalized.phone, message });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  } finally {
    await client.end().catch(() => {});
  }
};
