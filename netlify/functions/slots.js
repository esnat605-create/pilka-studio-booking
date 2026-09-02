// =============================================================================
//  GET /api/slots?masterId=...&serviceIds=...&date=YYYY-MM-DD
// =============================================================================
//  Возвращает список свободных стартов времени у конкретного мастера на
//  конкретную дату под выбранные услуги. Услуг может быть несколько — тогда
//  окно ищется под их суммарную длительность: клиент делает их подряд за один
//  визит. Прежний параметр serviceId (одна услуга) тоже понимается — страница,
//  оставшаяся в кэше браузера после обновления, продолжает работать.
//
//  Занятость берётся из боевой таблицы appointments (только чтение). Отменённые
//  записи и неявки время не занимают — так же, как в админке. Ответ содержит
//  только строки вида "10:30": ни имён клиентов, ни телефонов, ни того, чем
//  именно занят мастер, наружу не уходит.
// =============================================================================

const {
  CONFIG,
  computeFreeSlots,
  daysBetween,
  fail,
  isValidDateStr,
  loadBusyIntervals,
  loadDaysOff,
  loadMasters,
  loadMasterServices,
  loadServices,
  loadSettings,
  parseServiceIds,
  resolveSelection,
  salonNow,
  withDb,
} = require('./lib/core.js');

exports.handler = withDb(async function (event, client) {
  const q = event.queryStringParameters || {};
  const masterId = String(q.masterId || '').trim();
  const serviceIds = parseServiceIds(q.serviceIds, q.serviceId);
  const date = String(q.date || '').trim();

  if (!masterId) fail('Не выбран мастер', 400, 'bad_request', 'masterId');
  if (!serviceIds.length) fail('Не выбрана услуга', 400, 'bad_request', 'serviceId');
  if (!isValidDateStr(date)) fail('Некорректная дата', 400, 'bad_request', 'date');

  const now = salonNow();
  const shift = daysBetween(now.date, date);
  if (shift < 0) fail('Эта дата уже прошла', 400, 'date_past', 'date');
  if (shift > CONFIG.horizonDays) {
    fail(`Запись открыта на ${CONFIG.horizonDays} дней вперёд`, 400, 'date_far', 'date');
  }

  const [settings, masters, services, masterServices] = await Promise.all([
    loadSettings(client),
    loadMasters(client),
    loadServices(client),
    loadMasterServices(client),
  ]);

  const master = masters.find((m) => m.id === masterId);
  if (!master) fail('Мастер не найден или сейчас не принимает', 404, 'master_not_found', 'masterId');

  // Длительность визита — сумма по выбранным услугам. Считаем её здесь, а не
  // берём из запроса: иначе можно было бы «сжать» визит и влезть в чужое окно.
  const selection = resolveSelection(serviceIds, services, masterServices, masterId);

  const [busy, daysOff] = await Promise.all([
    loadBusyIntervals(client, masterId, date),
    loadDaysOff(client, masterId),
  ]);
  const slots = computeFreeSlots({
    settings,
    master,
    durationMin: selection.duration,
    date,
    busy,
    daysOff,
  });

  return {
    date,
    masterId,
    serviceIds,
    duration: selection.duration,
    slots,
    // Отдельный признак, чтобы страница показала «мастер не работает в этот
    // день», а не безликое «свободного времени нет».
    dayOff: daysOff.indexOf(date) !== -1,
  };
});
