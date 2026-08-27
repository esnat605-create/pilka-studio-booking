// =============================================================================
//  GET /api/slots?masterId=...&serviceId=...&date=YYYY-MM-DD
// =============================================================================
//  Возвращает список свободных стартов времени у конкретного мастера на
//  конкретную дату под конкретную услугу.
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
  isBookable,
  isValidDateStr,
  loadBusyIntervals,
  loadDaysOff,
  loadMasters,
  loadMasterServices,
  loadServices,
  loadSettings,
  masterDoesService,
  salonNow,
  withDb,
} = require('./lib/core.js');

exports.handler = withDb(async function (event, client) {
  const q = event.queryStringParameters || {};
  const masterId = String(q.masterId || '').trim();
  const serviceId = String(q.serviceId || '').trim();
  const date = String(q.date || '').trim();

  if (!masterId) fail('Не выбран мастер', 400, 'bad_request', 'masterId');
  if (!serviceId) fail('Не выбрана услуга', 400, 'bad_request', 'serviceId');
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

  const service = services.find((s) => s.id === serviceId);
  if (!service) fail('Услуга не найдена', 404, 'service_not_found', 'serviceId');

  // Услуга-заголовок (у неё есть варианты) сама не бронируется: цена и
  // длительность записи должны быть однозначны.
  if (!isBookable(service, services)) {
    fail('Выберите конкретный вариант этой услуги', 400, 'service_is_group', 'serviceId');
  }

  if (!masterDoesService(masterServices, masterId, serviceId)) {
    fail('Этот мастер не оказывает выбранную услугу', 400, 'service_not_offered', 'serviceId');
  }

  const [busy, daysOff] = await Promise.all([
    loadBusyIntervals(client, masterId, date),
    loadDaysOff(client, masterId),
  ]);
  const slots = computeFreeSlots({
    settings,
    master,
    durationMin: service.duration,
    date,
    busy,
    daysOff,
  });

  return {
    date,
    masterId,
    serviceId,
    duration: service.duration,
    slots,
    // Отдельный признак, чтобы страница показала «мастер не работает в этот
    // день», а не безликое «свободного времени нет».
    dayOff: daysOff.indexOf(date) !== -1,
  };
});
