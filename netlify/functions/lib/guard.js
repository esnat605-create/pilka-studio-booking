// =============================================================================
// Защита формы записи от злоупотреблений: чёрный список номеров и лимит по IP
// =============================================================================
// Два независимых барьера, которые book.js проходит ДО создания записи:
//
// 1. Чёрный список телефонов (таблица phone_blacklist). Номер сравнивается по
//    последним 10 цифрам — так «+7 940 123-45-67», «8 940 1234567» и
//    «9401234567» это один и тот же человек, и сменить формат записи номера,
//    чтобы обойти блокировку, не получится. Заблокированному человеку сайт
//    отвечает нейтрально («не удалось отправить заявку, позвоните нам») и не
//    объясняет, что дело в чёрном списке.
//
// 2. Лимит заявок с одного IP за час (по умолчанию 5). IP в открытом виде нигде
//    не хранится — используется тот же необратимый отпечаток ip_hash, что уже
//    пишется в журнал web_bookings, поэтому для лимита не нужны новые данные.
//    Порог меняется переменной окружения MAX_BOOKINGS_PER_IP_PER_HOUR; значение
//    0 отключает лимит.
//
// Файл лежит в lib/, поэтому Netlify не считает его отдельной функцией.
// =============================================================================

const { fail, phoneKey } = require('./core.js');

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_BOOKINGS_PER_IP_PER_HOUR = envInt('MAX_BOOKINGS_PER_IP_PER_HOUR', 5);

// Код ошибки Postgres «таблицы не существует». Пока администратор не выполнил
// SQL-миграцию, таблицы phone_blacklist нет — сайт в этом случае должен
// продолжать принимать заявки, а не падать.
const UNDEFINED_TABLE = '42P01';

// Бросает ошибку, если номер в чёрном списке. Вызывается до транзакции: счётчик
// попыток фиксируется сразу и не откатывается вместе с отказом.
async function assertNotBlacklisted(client, phone) {
  const key = phoneKey(phone);
  if (!key) return;

  let res;
  try {
    res = await client.query('SELECT id FROM phone_blacklist WHERE phone_key = $1', [key]);
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) return;
    throw err;
  }
  if (!res.rows.length) return;

  // Сколько раз заблокированный номер пытался записаться — полезно видеть в
  // списке, чтобы понимать, что человек не отстал. Ошибка здесь не критична.
  try {
    await client.query(
      'UPDATE phone_blacklist SET attempts = attempts + 1, last_attempt_at = now() WHERE id = $1',
      [res.rows[0].id]
    );
  } catch (_) {
    /* счётчик — удобство, а не условие блокировки */
  }
  console.warn('[pilka-studio-booking] Заявка отклонена: номер в чёрном списке, запись', res.rows[0].id);

  fail('Не удалось отправить заявку. Пожалуйста, позвоните нам.', 403, 'rejected');
}

// Бросает ошибку, если с этого IP за последний час уже создано максимальное
// число заявок. Считаются заявки, попавшие в журнал web_bookings, — то есть
// реально созданные; отклонённые попытки лимит не расходуют.
//
// Вызывать нужно внутри транзакции. Блокировка по отпечатку IP сериализует
// одновременные заявки с одного адреса: иначе шесть запросов, отправленных
// одновременно, одновременно же увидели бы «заявок пока 0» и прошли все.
async function assertIpWithinLimit(client, ipHash) {
  if (!ipHash || MAX_BOOKINGS_PER_IP_PER_HOUR <= 0) return;

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pilka:ip:${ipHash}`]);
  const res = await client.query(
    `SELECT count(*)::int AS n
       FROM web_bookings
      WHERE ip_hash = $1
        AND created_at > now() - interval '1 hour'`,
    [ipHash]
  );
  if ((res.rows[0] || {}).n >= MAX_BOOKINGS_PER_IP_PER_HOUR) {
    fail(
      'С вашего устройства за последний час отправлено слишком много заявок. ' +
        'Попробуйте позже или позвоните нам — мы поможем.',
      429,
      'rate_limited'
    );
  }
}

module.exports = {
  MAX_BOOKINGS_PER_IP_PER_HOUR,
  UNDEFINED_TABLE,
  assertIpWithinLimit,
  assertNotBlacklisted,
};
