// =============================================================================
//  Плановая функция: напоминания клиентам о завтрашней записи через WhatsApp
// =============================================================================
//  Раз в день (см. расписание в netlify.toml) находит все записи на завтра,
//  которые ещё не отмечены как «напоминание отправлено», и рассылает клиентам
//  тёплое сообщение через Whapi.Cloud — тот же рабочий номер WhatsApp, с
//  которого администраторы годами пишут клиентам вручную.
//
//  Почему через уже используемый номер, а не официальный WhatsApp Business
//  Platform: у номера многолетняя история, сохранённые контакты и клиенты
//  регулярно отвечают на сообщения — это именно то, что снижает риск
//  антиспам-блокировки WhatsApp при автоматической отправке. Whapi.Cloud лишь
//  даёт API поверх того же самого аккаунта (подключение через QR-код), без
//  привязки к Meta Business Platform и без платы за каждое сообщение.
//
//  Что использует и что не трогает:
//  — читает и обновляет ТОЛЬКО существующий столбец appointments.reminder_sent
//    ('Да' / 'Нет'), которым администраторы и так помечали ручные напоминания —
//    новых столбцов и миграций не потребовалось;
//  — не отправляет повторно тем, у кого reminder_sent уже 'Да' (в том числе
//    если администратор отметил запись как обзвоненную вручную);
//  — пропускает отменённые записи и неявки.
// =============================================================================

const { connect, CONFIG, normalizePhone } = require('./lib/core');

// Целевая длина паузы между сообщениями — те же 2-5 секунд, с которыми обычно
// печатает и отправляет человек. Это НЕ защита сама по себе, но снижает шанс
// того, что резкая пачка сообщений подряд будет выглядеть как рассылка ботом.
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

// Завтрашняя дата в часовом поясе салона — той же строкой 'YYYY-MM-DD',
// какой она хранится в appointments.date (см. salonNow() в lib/core.js).
function tomorrowDateStr() {
  const shifted = new Date(Date.now() + CONFIG.tzOffsetHours * 3600 * 1000 + 24 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

// 'HH:MM' → 'в 14:30' для человеческого текста сообщения.
function formatTimeRu(timeStr) {
  return `в ${timeStr}`;
}

function buildMessage({ clientName, timeStr, serviceName }) {
  const name = clientName ? clientName.split(' ')[0] : '';
  const greeting = name ? `Здравствуйте, ${name}!` : 'Здравствуйте!';
  const service = serviceName ? ` на «${serviceName}»` : '';
  return (
    `${greeting} Напоминаем: завтра ждём вас в ${CONFIG.salonName} ` +
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

exports.handler = async () => {
  const client = await connect();
  const results = { sent: 0, failed: 0, skipped: 0, errors: [] };

  try {
    const targetDate = tomorrowDateStr();

    const { rows } = await client.query(
      `
      SELECT a.id, a.time, a.phone, a.client_name,
             COALESCE(s.name, '') AS service_name
      FROM appointments a
      LEFT JOIN services s ON s.id = a.service_id
      WHERE a.date = $1
        AND a.reminder_sent = 'Нет'
        AND a.status NOT IN ('Отменён клиентом', 'Отменён салоном', 'Не пришёл')
      ORDER BY a.time
      `,
      [targetDate]
    );

    for (const appt of rows) {
      const normalized = normalizePhone(appt.phone);
      if (!normalized.ok) {
        results.skipped++;
        continue;
      }
      // Whapi ждёт номер только цифрами, без "+" (например 79011112233).
      const phoneDigits = normalized.phone.replace(/\D/g, '');

      const message = buildMessage({
        clientName: appt.client_name,
        timeStr: appt.time,
        serviceName: appt.service_name,
      });

      try {
        await sendWhapiMessage(phoneDigits, message);
        await client.query(
          `UPDATE appointments SET reminder_sent = 'Да' WHERE id = $1`,
          [appt.id]
        );
        results.sent++;
      } catch (err) {
        results.failed++;
        results.errors.push({ id: appt.id, error: String(err.message || err) });
      }

      // Пауза перед следующим сообщением — см. комментарий у MIN/MAX_DELAY_MS.
      await sleep(randomDelay());
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ date: targetDate, ...results }),
    };
  } finally {
    await client.end().catch(() => {});
  }
};
