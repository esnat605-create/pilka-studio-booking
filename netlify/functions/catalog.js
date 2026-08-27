// =============================================================================
//  GET /api/catalog
// =============================================================================
//  Отдаёт публичной странице всё, что нужно для первых двух шагов формы:
//  список услуг, список активных мастеров и связку «какой мастер какие услуги
//  оказывает». Плюс режим работы салона — чтобы страница могла показать часы.
//
//  Наружу уходит только то, что клиенту действительно нужно видеть. Телефоны и
//  проценты мастеров, карточки клиентов и чьи-либо записи здесь не отдаются
//  ни при каких условиях: сама выборка в lib/core.js их не запрашивает.
// =============================================================================

const {
  loadAllDaysOff,
  categoryOrderIndex,
  isBookable,
  loadMasters,
  loadMasterServices,
  loadServices,
  loadSettings,
  withDb,
} = require('./lib/core.js');

exports.handler = withDb(async function (event, client) {
  const [settings, masters, services, masterServices, daysOff] = await Promise.all([
    loadSettings(client),
    loadMasters(client),
    loadServices(client),
    loadMasterServices(client),
    loadAllDaysOff(client),
  ]);

  // Какие услуги вообще кто-то оказывает. Услуга, которую не делает ни один
  // активный мастер, на сайте бесполезна — записаться на неё не к кому.
  //
  // Считаем это только по услугам, на которые можно записаться: услуга с
  // вариантами сама по себе не бронируется, за неё «отвечают» её варианты.
  const bookable = services.filter((s) => isBookable(s, services));

  const offered = new Set();
  masters.forEach((m) => {
    const own = masterServices[m.id];
    if (!own || !own.length) {
      // Список для мастера не настроен — считаем, что он делает всё.
      bookable.forEach((s) => offered.add(s.id));
    } else {
      own.forEach((id) => offered.add(id));
    }
  });

  const visibleBookable = bookable.filter((s) => offered.has(s.id));

  // Заголовки нужны рядом с их вариантами: без родителя вариант «в один тон»
  // на странице выглядит как самостоятельная услуга без объяснений.
  const neededParents = new Set(
    visibleBookable.map((s) => s.parentId).filter(Boolean)
  );
  const headings = services.filter((s) => neededParents.has(s.id));

  const order = settings.categoryOrder;
  const visibleServices = visibleBookable.concat(headings).sort((a, b) => {
    const ca = categoryOrderIndex(order, a.category);
    const cb = categoryOrderIndex(order, b.category);
    if (ca !== cb) return ca - cb;
    if (a.category !== b.category) return a.category.localeCompare(b.category, 'ru');
    return a.name.localeCompare(b.name, 'ru');
  });

  return {
    salon: {
      name: settings.salonName,
      openTime: settings.openTime,
      closeTime: settings.closeTime,
      earlyOpenTime: settings.earlyOpenTime,
    },
    services: visibleServices,
    // Порядок категорий для блока «что мы делаем».
    categoryOrder: settings.categoryOrder,
    masters,
    // Отдаём только связки по видимым услугам — лишнего в браузер не выносим.
    masterServices,
    // Выходные мастеров на ближайшие даты: страница гасит эти дни в календаре
    // ещё до обращения к серверу, чтобы клиент не тыкал в заведомо пустые дни.
    daysOff,
  };
});
