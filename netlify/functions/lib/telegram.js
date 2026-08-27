// =============================================================================
//  Работа с Telegram: общий код для бота и кабинета.
// =============================================================================
//  Токен бота живёт только в переменной окружения TELEGRAM_BOT_TOKEN на сервере
//  Netlify. В браузер он не попадает никогда и ни при каких условиях — страница
//  знает лишь имя бота, чтобы построить ссылку вида t.me/имя?start=КОД.
// =============================================================================

const crypto = require('crypto');

const API = 'https://api.telegram.org/bot';

function botToken() {
  return process.env.TELEGRAM_BOT_TOKEN || '';
}

function botUsername() {
  return (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '');
}

function webhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || '';
}

function isConfigured() {
  return !!botToken() && !!botUsername();
}

// Вызов метода Telegram Bot API. Ошибки не бросаем наружу: если Telegram
// временно недоступен, кабинет должен вежливо сказать об этом, а не падать.
async function callTelegram(method, payload) {
  const token = botToken();
  if (!token) return { ok: false, description: 'Бот не настроен' };

  try {
    const res = await fetch(API + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return await res.json();
  } catch (err) {
    console.error('[telegram] ' + method + ' не удался:', err && err.message);
    return { ok: false, description: String(err && err.message) };
  }
}

function sendMessage(chatId, text, extra) {
  return callTelegram(
    'sendMessage',
    Object.assign({ chat_id: chatId, text, parse_mode: 'HTML' }, extra || {})
  );
}

// Клавиатура с единственной кнопкой «поделиться номером». Именно она даёт
// подтверждённый номер: Telegram передаёт его сам, клиент не набирает цифры
// руками, а значит и подставить чужой номер не может.
const SHARE_PHONE_KEYBOARD = {
  keyboard: [[{ text: '📱 Поделиться номером', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true,
};

function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  botUsername,
  callTelegram,
  isConfigured,
  newNonce,
  newSessionToken,
  sendMessage,
  SHARE_PHONE_KEYBOARD,
  webhookSecret,
};
