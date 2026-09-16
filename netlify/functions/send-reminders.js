// =============================================================================
//  Плановая функция: напоминания клиентам о записи через WhatsApp
// =============================================================================
//  Раньше запускалась раз в сутки и разом рассылала напоминания всем, у кого
//  запись «завтра». Проблема: пачка одинаковых сообщений, уходящих в одну и ту
//  же минуту всем клиентам подряд, для WhatsApp выглядит подозрительно похоже
//  на рассылку ботом — это повышает риск блокировки рабочего номера.
//
//  Теперь функция запускается каждые 15 минут (см. netlify.toml) и на каждом
//  запуске сама вычисляет, кому именно сейчас пора: напоминание уходит
//  примерно за 24 часа до времени ЛИЧНОГО визита каждого клиента, а не всем
//  сразу в одно и то же время суток. Так сообщения естественным образом
//  распределяются в течение дня, а не приходят одной пачкой.
//
//  Что использует и что не трогает:
//  — читает и обновляет ТОЛЬКО существующий столбец appointments.reminder_sent
//    ('Да' / 'Нет'), которым администраторы и так помечали ручные напоминания —
//    новых столбцов и миграций не потребовалось;
//  — не отправляет повторно тем, у кого reminder_sent уже 'Да' (в том числе
//    если администратор отметил запись как обзвоненную вручную, или если
//    запись создавалась меньше чем за 24 часа до визита — в этом случае флаг
//    сразу проставляется в 'Да' в момент создания записи, см. book.js);
//  — пропускает отменённые записи и неявки.
// =============================================================================

const { connect, apptStartMs, normalizePhone, loadSettings, sendWhapiMessage } = require('./lib/core');

// Целевая длина паузы между сообщениями — те же 2-5 секунд, с которыми обычно
// печатает и отправляет человек. Это НЕ защита сама по себе, но снижает шанс
// того, что резкая пачка сообщений подряд (если на одном запуске совпало
// несколько записей) будет выглядеть как рассылка ботом.
const MIN_DELAY_MS = 2000;
const MAX_DELAY_MS = 5000;

// Напоминание отправляем, когда до визита остаётся не больше суток. Верхняя
// граница окна поиска в базе — с запасом (чуть больше суток), чтобы точный
// отбор «пора или ещё нет» на 24 часа сделать уже в JS через apptStartMs, не
// полагаясь на то, что в date/time хранится именно локальное время салона без
// смещения (там ровно так и есть, но сравнивать удобнее числами, а не строками).
const REMINDER_WINDOW_MS = 24 * 3600 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay() {
  return MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

// 'YYYY-MM-DD' + N дней → 'YYYY-MM-DD'. Календарная арифметика в UTC —
// смены часовых поясов внутри суток салона не бывает (нет перехода на летнее
// время), так что для дат это безопасно.
function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 'HH:MM' → 'в 14:30' для человеческого текста сообщения.
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

exports.handler = async () => {
  const client = await connect();
  const results = { sent: 0, failed: 0, skipped: 0, errors: [] };

  try {
    const settings = await loadSettings(client);
    const now = Date.now();

    // Берём с запасом окно в датах — от сегодняшнего до послезавтрашнего дня
    // по местному времени салона: этого достаточно, чтобы не пропустить ни
    // одну запись, у которой 24-часовая отметка попадает на текущий запуск,
    // при этом выборка из базы остаётся маленькой. Точный отбор «отправлять
    // именно сейчас или ещё рано» — ниже, через apptStartMs.
    const nowShifted = new Date(now);
    const todayStr = nowShifted.toISOString().slice(0, 10);
    const fromDate = addDaysStr(todayStr, -1);
    const toDate = addDaysStr(todayStr, 2);

    const { rows } = await client.query(
      `
      SELECT a.id, a.date, a.time, a.phone, a.client_name,
             COALESCE(s.name, '') AS service_name
      FROM appointments a
      LEFT JOIN services s ON s.id = a.service_id
      WHERE a.date BETWEEN $1 AND $2
        AND a.reminder_sent = 'Нет'
        AND a.status NOT IN ('Отменён клиентом', 'Отменён салоном', 'Не пришёл')
      ORDER BY a.date, a.time
      `,
      [fromDate, toDate]
    );

    for (const appt of rows) {
      const startMs = apptStartMs(appt.date, appt.time);
      const msUntilStart = startMs - now;

      // Ещё рано (больше суток до визита) — отложим до следующего запуска.
      if (msUntilStart > REMINDER_WINDOW_MS) continue;
      // Визит уже наступил или прошёл, а напоминание почему-то не ушло
      // (например, функция не запускалась какое-то время) — отправлять
      // «завтра ждём вас» после факта смысла нет, пропускаем молча.
      if (msUntilStart <= 0) {
        results.skipped++;
        continue;
      }

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
        salonName: settings.salonName,
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
      body: JSON.stringify({ from: fromDate, to: toDate, ...results }),
    };
  } finally {
    await client.end().catch(() => {});
  }
};
