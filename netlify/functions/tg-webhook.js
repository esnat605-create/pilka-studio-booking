// =============================================================================
//  POST /api/tg-webhook — сюда Telegram присылает сообщения боту
// =============================================================================
//  Бот делает ровно две вещи:
//    1. На /start КОД запоминает код и просит поделиться номером.
//    2. Получив контакт, связывает номер с кодом — после этого сайт пускает
//       клиента в кабинет.
//
//  Проверка подлинности запроса: Telegram присылает заголовок
//  X-Telegram-Bot-Api-Secret-Token со значением, которое мы задали при
//  подключении вебхука. Без совпадения запрос отбрасывается — иначе кто угодно,
//  зная адрес, мог бы подделать «подтверждение» чужого номера.
// =============================================================================

const { connect, corsHeaders, normalizePhone, clean } = require('./lib/core.js');
const {
  isConfigured,
  sendMessage,
  webhookSecret,
  SHARE_PHONE_KEYBOARD,
} = require('./lib/telegram.js');

// Код входа живёт недолго: ссылка, оставленная в чате, не должна пускать в
// кабинет через неделю.
const NONCE_TTL_MINUTES = 15;

const GREETING =
  'Здравствуйте! Это бот Pilka Studio.\n\n' +
  'Нажмите кнопку ниже, чтобы подтвердить свой номер телефона — ' +
  'после этого откроется личный кабинет с историей ваших посещений.';

function ok() {
  // Telegram важен только код 200: любой другой он считает сбоем и повторяет
  // доставку. Поэтому отвечаем успехом даже там, где ничего не сделали.
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: '{"ok":true}' };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }
  if (event.httpMethod !== 'POST') return ok();

  const secret = webhookSecret();
  const got =
    (event.headers && (event.headers['x-telegram-bot-api-secret-token'] ||
      event.headers['X-Telegram-Bot-Api-Secret-Token'])) || '';
  if (!secret || got !== secret) {
    console.warn('[tg-webhook] отброшен запрос с неверным секретом');
    return ok();
  }
  if (!isConfigured()) return ok();

  let update = null;
  try {
    update = JSON.parse(event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body);
  } catch (e) {
    return ok();
  }

  const msg = update && update.message;
  if (!msg || !msg.chat) return ok();

  const chatId = msg.chat.id;
  const from = msg.from || {};
  const tgId = String(from.id || chatId);
  const tgName = clean([from.first_name, from.last_name].filter(Boolean).join(' '), 200);

  let client = null;
  try {
    client = await connect();

    // ---- /start [код] ----------------------------------------------------
    if (typeof msg.text === 'string' && msg.text.indexOf('/start') === 0) {
      const nonce = clean(msg.text.slice(6), 64).trim();

      if (nonce) {
        // Код мог протухнуть, пока клиент искал бота, — тогда просто просим
        // начать заново, вместо загадочного молчания.
        const res = await client.query(
          `SELECT status, created_at FROM client_auth WHERE nonce = $1`,
          [nonce]
        );
        if (!res.rows.length) {
          await sendMessage(chatId, 'Ссылка устарела. Откройте личный кабинет на сайте и нажмите «Войти» ещё раз.');
          return ok();
        }
        await client.query(
          `UPDATE client_auth SET telegram_id = $1, tg_name = $2 WHERE nonce = $3 AND status = 'pending'`,
          [tgId, tgName, nonce]
        );
      }

      await sendMessage(chatId, GREETING, { reply_markup: SHARE_PHONE_KEYBOARD });
      return ok();
    }

    // ---- клиент поделился контактом --------------------------------------
    if (msg.contact) {
      // Чужой контакт из адресной книги принимать нельзя: подтверждением
      // владения номером считается только собственный контакт отправителя.
      if (String(msg.contact.user_id || '') !== tgId) {
        await sendMessage(chatId, 'Подтвердить можно только свой номер. Нажмите кнопку «Поделиться номером» ещё раз.',
          { reply_markup: SHARE_PHONE_KEYBOARD });
        return ok();
      }

      const norm = normalizePhone(msg.contact.phone_number || '');
      if (!norm.ok) {
        await sendMessage(chatId, 'Не удалось разобрать номер. Позвоните нам, пожалуйста, — поможем вручную.');
        return ok();
      }

      // Подтверждаем самый свежий незакрытый код этого пользователя.
      const upd = await client.query(
        `UPDATE client_auth
            SET phone = $1, status = 'confirmed', confirmed_at = now(), telegram_id = $2, tg_name = $3
          WHERE nonce = (
            SELECT nonce FROM client_auth
             WHERE telegram_id = $2 AND status = 'pending'
               AND created_at > now() - ($4 || ' minutes')::interval
             ORDER BY created_at DESC LIMIT 1)
          RETURNING nonce`,
        [norm.phone, tgId, tgName, String(NONCE_TTL_MINUTES)]
      );

      if (!upd.rows.length) {
        await sendMessage(chatId, 'Номер получен, но заявка на вход не найдена или устарела. Откройте кабинет на сайте и нажмите «Войти».');
        return ok();
      }

      // Запоминаем Telegram в карточке клиента — пригодится для напоминаний.
      await client.query(
        `UPDATE clients SET telegram_id = $1
          WHERE regexp_replace(phone, '\\D', '', 'g') LIKE $2`,
        [tgId, '%' + String(norm.phone).replace(/\D/g, '').slice(-10)]
      );

      await sendMessage(chatId,
        'Номер подтверждён ✅\n\nВернитесь на сайт — кабинет уже открыт.',
        { reply_markup: { remove_keyboard: true } });
      return ok();
    }

    // ---- всё остальное ----------------------------------------------------
    await sendMessage(chatId, GREETING, { reply_markup: SHARE_PHONE_KEYBOARD });
    return ok();
  } catch (err) {
    console.error('[tg-webhook] ошибка:', err);
    return ok();
  } finally {
    if (client) {
      try { await client.end(); } catch (_) { /* уже закрыто */ }
    }
  }
};
