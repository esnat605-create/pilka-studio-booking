/* =============================================================================
   Pilka Studio — клиентская логика страницы записи
   -----------------------------------------------------------------------------
   Ванильный ES6 без фреймворков и сборщика: файл подключается как есть и
   работает во всех современных браузерах.

   Логика устроена вокруг одного объекта состояния `state`. Любое изменение
   выбора проходит через функции set*(), которые сбрасывают зависимые шаги
   (сменил услугу → мастер мог перестать подходить → время точно устарело) и
   перерисовывают то, что нужно. Так исключены рассинхроны вида «в форме
   выбрано время, которого для этого мастера уже нет».

   Важное про проверки: всё, что здесь валидируется, ещё раз проверяется на
   сервере. Клиентская валидация нужна только чтобы человек быстрее увидел
   ошибку, а не чтобы защитить данные.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------------
     Состояние и константы
     ------------------------------------------------------------------------ */

  var state = {
    catalog: null,        // ответ /api/catalog
    serviceId: '',
    masterId: '',
    date: '',             // 'YYYY-MM-DD'
    time: '',             // 'HH:MM'
    slots: [],
    dayOff: false,        // выбранная дата — выходной у мастера
    slotsToken: 0,        // защита от «обгона» медленных ответов
    viewMonth: null,      // {year, month} — какой месяц показан в календаре
    startedAt: Date.now() // для отсечки слишком быстрой отправки (боты)
  };

  var MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда',
    'четверг', 'пятница', 'суббота'];

  // На сколько дней вперёд открыта запись. Должно совпадать с
  // BOOKING_HORIZON_DAYS на сервере; расхождение не опасно — сервер всё равно
  // отклонит слишком далёкую дату, просто клиент покажет её как доступную.
  var HORIZON_DAYS = 60;

  /* ---------------------------------------------------------------------------
     Мелкие помощники
     ------------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // Дата в строку 'YYYY-MM-DD'. Работаем с локальными компонентами даты, а не с
  // toISOString(): последний переводит в UTC и на вечерних часах отдаёт
  // вчерашний день.
  function ymd(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseYmd(s) {
    var p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function todayLocal() {
    var n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function formatPrice(v) {
    var n = Number(v) || 0;
    if (!n) return '';
    return n.toLocaleString('ru-RU') + ' ₽';
  }

  function formatDuration(min) {
    var m = Number(min) || 0;
    if (m < 60) return m + ' мин';
    var h = Math.floor(m / 60);
    var rest = m % 60;
    return rest ? h + ' ч ' + rest + ' мин' : h + ' ч';
  }

  // «пятница, 21 августа»
  function formatDateHuman(dateStr) {
    var d = parseYmd(dateStr);
    return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
  }

  function timeToMin(t) {
    var p = String(t).split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  /* ---------------------------------------------------------------------------
     Сообщения об ошибках у полей
     ------------------------------------------------------------------------ */

  function setError(errorId, message, controlId) {
    var box = $(errorId);
    if (box) box.textContent = message || '';
    if (controlId) {
      var ctrl = $(controlId);
      if (ctrl) {
        if (message) ctrl.setAttribute('aria-invalid', 'true');
        else ctrl.removeAttribute('aria-invalid');
      }
    }
  }

  function clearAllErrors() {
    ['errService', 'errMaster', 'errDate', 'errTime', 'errName', 'errPhone', 'errConsent']
      .forEach(function (id) { var n = $(id); if (n) n.textContent = ''; });
    ['fService', 'fMaster', 'fName', 'fPhone'].forEach(function (id) {
      var n = $(id); if (n) n.removeAttribute('aria-invalid');
    });
    var fe = $('formError');
    fe.hidden = true;
    fe.textContent = '';
  }

  /* ---------------------------------------------------------------------------
     Обращения к API
     ------------------------------------------------------------------------ */

  function apiGet(path, params) {
    var qs = params
      ? '?' + Object.keys(params).map(function (k) {
          return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
        }).join('&')
      : '';
    return fetch(path + qs, { headers: { Accept: 'application/json' } }).then(readJson);
  }

  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(readJson);
  }

  // Сервер всегда отвечает JSON — но если что-то пошло не так на уровне
  // хостинга, придёт HTML страницы ошибки. Обрабатываем и такой случай, чтобы
  // клиент увидел человеческий текст, а не «Unexpected token <».
  function readJson(res) {
    return res.text().then(function (text) {
      var data = null;
      try { data = JSON.parse(text); } catch (e) { /* не JSON */ }
      if (!data) {
        var err = new Error('Сервис временно недоступен. Попробуйте ещё раз через минуту.');
        err.code = 'bad_response';
        throw err;
      }
      if (!res.ok || data.ok === false) {
        var apiErr = new Error(data.error || 'Не удалось выполнить запрос');
        apiErr.code = data.code || 'error';
        apiErr.field = data.field || '';
        throw apiErr;
      }
      return data;
    });
  }

  /* ---------------------------------------------------------------------------
     Загрузка справочников
     ------------------------------------------------------------------------ */

  function loadCatalog() {
    $('loadError').hidden = true;

    return apiGet('/api/catalog')
      .then(function (data) {
        state.catalog = data;
        renderHours(data.salon);
        renderServices(data);
        renderMasters(data);
        fillServiceSelect(data);
        renderCalendar();
      })
      .catch(function (err) {
        $('servicesList').setAttribute('aria-busy', 'false');
        $('mastersList').setAttribute('aria-busy', 'false');
        $('loadErrorText').textContent =
          err.message || 'Не удалось загрузить список услуг. Проверьте связь и попробуйте снова.';
        $('loadError').hidden = false;
        $('fService').innerHTML = '<option value="">Не удалось загрузить</option>';
      });
  }

  function renderHours(salon) {
    if (!salon) return;
    var text = 'Работаем ежедневно с ' + salon.openTime + ' до ' + salon.closeTime;
    $('heroHours').textContent = text;
    $('contactHours').textContent = 'ежедневно, ' + salon.openTime + '–' + salon.closeTime;
  }

  /* ---------------------------------------------------------------------------
     Отрисовка списка услуг
     ------------------------------------------------------------------------ */

  // Услуга, на которую можно записаться. Услуга-заголовок (у неё есть варианты)
  // сама не бронируется — выбирать нужно конкретный вариант.
  function isBookable(service, all) {
    if (service.parentId) return true;
    return !all.some(function (x) { return x.parentId === service.id; });
  }

  function childrenOf(all, parentId) {
    return all.filter(function (x) { return x.parentId === parentId; });
  }

  // Категории в порядке, заданном администратором. Всё, чего нет в списке,
  // уходит в конец по алфавиту — новая категория не потеряется.
  function groupServices(services) {
    var order = (state.catalog && state.catalog.categoryOrder) || [];
    var groups = [];
    var index = {};

    services.forEach(function (s) {
      var key = s.category || 'Другие услуги';
      if (!index[key]) {
        index[key] = { title: key, items: [] };
        groups.push(index[key]);
      }
      index[key].items.push(s);
    });

    groups.sort(function (a, b) {
      var ia = order.indexOf(a.title);
      var ib = order.indexOf(b.title);
      if (ia === -1) ia = order.length;
      if (ib === -1) ib = order.length;
      if (ia !== ib) return ia - ib;
      return a.title.localeCompare(b.title, 'ru');
    });

    return groups;
  }

  // Внутри категории: сначала самостоятельные услуги и заголовки, под каждым
  // заголовком — его варианты.
  function arrangeWithVariants(items, all) {
    var rows = [];
    items.forEach(function (s) {
      if (s.parentId) return;                    // варианты добавим под родителем
      var kids = childrenOf(all, s.id);
      rows.push({ service: s, heading: kids.length > 0, variants: kids });
    });
    // Вариант, чей заголовок не попал в эту же категорию, тоже нужно показать.
    items.forEach(function (s) {
      if (!s.parentId) return;
      var hasParentHere = rows.some(function (r) { return r.service.id === s.parentId; });
      if (!hasParentHere) rows.push({ service: s, heading: false, variants: [] });
    });
    return rows;
  }

  function priceFrom(variants) {
    if (!variants.length) return 0;
    return Math.min.apply(null, variants.map(function (v) { return Number(v.price) || 0; }));
  }

  // Блок «Услуги»: свёрнутые по умолчанию группы. Раскрываются нажатием,
  // внутри — услуги, а под услугой с вариантами её варианты со своими ценой и
  // длительностью.
  //
  // Сделано на <button> + скрытая панель, а не на <details>: так проще
  // управлять состоянием с клавиатуры и корректно проставить aria-expanded.
  function renderServices(data) {
    var box = $('servicesList');
    box.innerHTML = '';
    box.setAttribute('aria-busy', 'false');
    box.classList.add('services--accordion');

    if (!data.services.length) {
      box.appendChild(el('p', 'slots__empty', 'Список услуг пока не заполнен.'));
      return;
    }

    groupServices(data.services).forEach(function (group, gi) {
      var rows = arrangeWithVariants(group.items, data.services);

      // Сколько на самом деле позиций внутри — заголовок сам по себе не в счёт.
      var count = rows.reduce(function (n, r) {
        return n + (r.heading ? r.variants.length : 1);
      }, 0);

      var item = el('div', 'acc');
      var panelId = 'accPanel' + gi;

      var head = el('button', 'acc__head');
      head.type = 'button';
      head.setAttribute('aria-expanded', 'false');
      head.setAttribute('aria-controls', panelId);

      var title = el('span', 'acc__title', group.title);
      var meta = el('span', 'acc__count', String(count));
      var chevron = document.createElement('span');
      chevron.className = 'acc__chevron';
      chevron.setAttribute('aria-hidden', 'true');

      head.appendChild(title);
      head.appendChild(meta);
      head.appendChild(chevron);

      var panel = el('div', 'acc__panel');
      panel.id = panelId;
      panel.hidden = true;

      var list = el('ul', 'service-group__list');
      rows.forEach(function (row) {
        var s = row.service;

        if (row.heading) {
          var head2 = el('li', 'service-head');
          head2.appendChild(el('span', 'service-head__name', s.name));
          var from = priceFrom(row.variants);
          if (from) head2.appendChild(el('span', 'service-head__from', 'от ' + formatPrice(from)));
          list.appendChild(head2);

          row.variants.forEach(function (v) {
            list.appendChild(serviceRow(v, true));
          });
          return;
        }
        list.appendChild(serviceRow(s, false));
      });

      panel.appendChild(list);

      head.addEventListener('click', function () {
        var open = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
        item.classList.toggle('is-open', !open);
      });

      item.appendChild(head);
      item.appendChild(panel);
      box.appendChild(item);
    });

    $('servicesNote').textContent =
      'Нажмите на категорию, чтобы раскрыть список. Точную стоимость подтвердит мастер — она зависит от длины волос и выбранных материалов.';
    $('servicesNote').hidden = false;
  }

  function serviceRow(s, isVariant) {
    var li = el('li', 'service-row' + (isVariant ? ' service-row--variant' : ''));
    li.appendChild(el('span', 'service-row__name', s.name));

    var meta = el('span', 'service-row__meta');
    var price = formatPrice(s.price);
    meta.appendChild(el('span', 'service-row__dur', formatDuration(s.duration)));
    if (price) meta.appendChild(el('span', 'service-row__price', price));
    li.appendChild(meta);
    return li;
  }

  function renderMasters(data) {
    var box = $('mastersList');
    box.innerHTML = '';
    box.setAttribute('aria-busy', 'false');

    if (!data.masters.length) {
      box.appendChild(el('p', 'slots__empty', 'Список мастеров пока не заполнен.'));
      return;
    }

    data.masters.forEach(function (m) {
      var card = el('div', 'master-card');

      // Фото, если администратор его указал; иначе — первая буква имени.
      // Так список выглядит одинаково аккуратно и до появления фотографий,
      // и когда их загрузят только части мастеров.
      if (m.photoUrl) {
        var img = document.createElement('img');
        img.className = 'master-card__photo';
        img.src = m.photoUrl;
        img.alt = m.name;
        img.loading = 'lazy';
        img.width = 56;
        img.height = 56;
        // Если ссылка битая, молча возвращаемся к букве — пустой квадрат
        // с крестиком выглядел бы хуже, чем аккуратная заглушка.
        img.addEventListener('error', function () {
          var fallback = el('div', 'master-card__initial', (m.name || '?').trim().charAt(0).toUpperCase());
          if (img.parentNode) img.parentNode.replaceChild(fallback, img);
        });
        card.appendChild(img);
      } else {
        card.appendChild(el('div', 'master-card__initial', (m.name || '?').trim().charAt(0).toUpperCase()));
      }

      var info = el('div');
      info.appendChild(el('div', 'master-card__name', m.name));
      if (m.spec) info.appendChild(el('div', 'master-card__spec', m.spec));
      card.appendChild(info);

      box.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------------------
     Выпадающие списки услуги и мастера
     ------------------------------------------------------------------------ */

  function fillServiceSelect(data) {
    var sel = $('fService');
    sel.innerHTML = '';
    sel.appendChild(new Option('Выберите услугу', ''));

    var bookable = data.services.filter(function (s) { return isBookable(s, data.services); });

    if (!bookable.length) {
      sel.appendChild(new Option('Услуги ещё не добавлены', '', false, false));
      sel.disabled = true;
      return;
    }

    var byId = {};
    data.services.forEach(function (s) { byId[s.id] = s; });

    groupServices(bookable).forEach(function (group) {
      var og = document.createElement('optgroup');
      og.label = group.title;
      group.items.forEach(function (s) {
        // Вариант показываем вместе с родителем: «Окрашивание волос — в один тон»,
        // иначе три строки «в один тон / сложное / корни» невозможно различить.
        var parent = s.parentId ? byId[s.parentId] : null;
        var label = parent ? parent.name + ' — ' + s.name : s.name;
        var price = formatPrice(s.price);
        if (price) label += ' · ' + price;
        og.appendChild(new Option(label, s.id));
      });
      sel.appendChild(og);
    });
  }

  // Мастер делает услугу, если она есть в его списке. Пустой список означает
  // «администратор ещё не настраивал» — такой мастер делает всё. Ровно та же
  // логика работает в админке и на сервере.
  // Выходные выбранного мастера. Пустой список означает «работает всегда» —
  // это поведение по умолчанию, пока администратор не заполнил график.
  function daysOffForMaster(masterId) {
    if (!state.catalog || !state.catalog.daysOff) return [];
    return state.catalog.daysOff[masterId] || [];
  }

  function isMasterDayOff(masterId, dateStr) {
    return daysOffForMaster(masterId).indexOf(dateStr) !== -1;
  }

  function mastersForService(serviceId) {
    if (!state.catalog) return [];
    var map = state.catalog.masterServices || {};
    return state.catalog.masters.filter(function (m) {
      var own = map[m.id];
      if (!own || !own.length) return true;
      return own.indexOf(serviceId) !== -1;
    });
  }

  function fillMasterSelect() {
    var sel = $('fMaster');
    sel.innerHTML = '';

    if (!state.serviceId) {
      sel.appendChild(new Option('Сначала выберите услугу', ''));
      sel.disabled = true;
      return;
    }

    var list = mastersForService(state.serviceId);
    if (!list.length) {
      sel.appendChild(new Option('Нет свободных мастеров для этой услуги', ''));
      sel.disabled = true;
      return;
    }

    sel.disabled = false;
    sel.appendChild(new Option('Выберите мастера', ''));
    list.forEach(function (m) {
      sel.appendChild(new Option(m.spec ? m.name + ' — ' + m.spec : m.name, m.id));
    });

    // Если ранее выбранный мастер по-прежнему в списке — сохраняем выбор.
    if (state.masterId && list.some(function (m) { return m.id === state.masterId; })) {
      sel.value = state.masterId;
    } else {
      state.masterId = '';
    }
  }

  /* ---------------------------------------------------------------------------
     Календарь
     ------------------------------------------------------------------------ */

  function renderCalendar() {
    var today = todayLocal();
    var maxDate = new Date(today.getTime());
    maxDate.setDate(maxDate.getDate() + HORIZON_DAYS);

    if (!state.viewMonth) {
      state.viewMonth = { year: today.getFullYear(), month: today.getMonth() };
    }

    var year = state.viewMonth.year;
    var month = state.viewMonth.month;

    $('calMonth').textContent = MONTHS[month] + ' ' + year;

    // Кнопки перелистывания гасим на границах доступного диапазона —
    // неактивная кнопка честнее, чем кнопка, которая ничего не делает.
    var firstOfView = new Date(year, month, 1);
    var lastOfView = new Date(year, month + 1, 0);
    $('calPrev').disabled = firstOfView <= new Date(today.getFullYear(), today.getMonth(), 1);
    $('calNext').disabled = lastOfView >= new Date(maxDate.getFullYear(), maxDate.getMonth() + 1, 0);

    var grid = $('calGrid');
    grid.innerHTML = '';

    // В русском календаре неделя начинается с понедельника, а getDay() считает
    // от воскресенья — сдвигаем.
    var firstDow = (firstOfView.getDay() + 6) % 7;
    for (var i = 0; i < firstDow; i++) {
      var blank = el('span', 'cal-day is-empty');
      blank.setAttribute('aria-hidden', 'true');
      grid.appendChild(blank);
    }

    var daysInMonth = lastOfView.getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      (function (dayNum) {
        var date = new Date(year, month, dayNum);
        var key = ymd(date);
        var btn = el('button', 'cal-day', String(dayNum));
        btn.type = 'button';

        // День недоступен, если он вне горизонта записи или мастер в этот день
        // не работает. Второе знаем заранее из каталога, поэтому клиент не
        // тыкает в заведомо пустые дни и не ждёт ответа сервера впустую.
        var dayOff = state.masterId && isMasterDayOff(state.masterId, key);
        var disabled = date < today || date > maxDate || dayOff;
        btn.disabled = disabled;

        if (key === ymd(today)) btn.classList.add('is-today');
        if (key === state.date) btn.classList.add('is-selected');
        if (dayOff) btn.classList.add('is-dayoff');

        btn.setAttribute('aria-label', dayNum + ' ' + MONTHS_GEN[month] + ' ' + year +
          (dayOff ? ' — мастер не работает' : ''));
        if (dayOff) btn.title = 'В этот день мастер не работает';
        if (key === state.date) btn.setAttribute('aria-current', 'date');

        if (!disabled) {
          btn.addEventListener('click', function () { setDate(key); });
        }
        grid.appendChild(btn);
      })(day);
    }
  }

  function shiftMonth(delta) {
    var m = state.viewMonth.month + delta;
    var y = state.viewMonth.year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0; y += 1; }
    state.viewMonth = { year: y, month: m };
    renderCalendar();
  }

  /* ---------------------------------------------------------------------------
     Свободное время
     ------------------------------------------------------------------------ */

  function renderSlotsMessage(className, text) {
    var box = $('slotsBox');
    box.innerHTML = '';
    box.appendChild(el('p', className, text));
  }

  function loadSlots() {
    if (!state.serviceId || !state.masterId || !state.date) {
      state.slots = [];
      renderSlotsMessage('slots__placeholder',
        'Выберите услугу, мастера и дату — покажем свободное время.');
      return Promise.resolve();
    }

    // Каждому запросу присваиваем номер: если пользователь быстро переключает
    // даты, ответ на устаревший запрос не должен затирать актуальную сетку.
    var token = ++state.slotsToken;
    renderSlotsMessage('slots__placeholder', 'Смотрим свободное время…');

    return apiGet('/api/slots', {
      masterId: state.masterId,
      serviceId: state.serviceId,
      date: state.date
    })
      .then(function (data) {
        if (token !== state.slotsToken) return;
        state.slots = data.slots || [];
        state.dayOff = !!data.dayOff;
        renderSlots();
      })
      .catch(function (err) {
        if (token !== state.slotsToken) return;
        state.slots = [];
        renderSlotsMessage('slots__empty',
          err.message || 'Не удалось загрузить свободное время. Попробуйте ещё раз.');
      });
  }

  function renderSlots() {
    var box = $('slotsBox');
    box.innerHTML = '';

    if (!state.slots.length) {
      box.appendChild(el('p', 'slots__empty', state.dayOff
        ? 'В этот день мастер не работает. Выберите другую дату или другого мастера.'
        : 'На этот день свободного времени нет. Выберите другую дату или другого мастера.'));
      updateSummary();
      return;
    }

    var grid = el('div', 'slots__grid');

    // Стилисты и визажисты принимают раньше открытия салона — такие часы
    // выносим под отдельную подпись, иначе «05:00» в списке выглядит ошибкой.
    var openMin = state.catalog && state.catalog.salon
      ? timeToMin(state.catalog.salon.openTime) : 0;
    var early = state.slots.filter(function (t) { return timeToMin(t) < openMin; });
    var normal = state.slots.filter(function (t) { return timeToMin(t) >= openMin; });

    if (early.length) {
      grid.appendChild(el('div', 'slots__label', 'Раннее время, по договорённости'));
      early.forEach(function (t) { grid.appendChild(slotButton(t)); });
      if (normal.length) {
        grid.appendChild(el('div', 'slots__label', 'Основное время'));
      }
    }
    normal.forEach(function (t) { grid.appendChild(slotButton(t)); });

    box.appendChild(grid);
    updateSummary();
  }

  function slotButton(time) {
    var btn = el('button', 'slot-btn', time);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', state.time === time ? 'true' : 'false');
    btn.addEventListener('click', function () { setTime(time); });
    return btn;
  }

  /* ---------------------------------------------------------------------------
     Изменение выбора. Каждая функция сбрасывает то, что от неё зависит.
     ------------------------------------------------------------------------ */

  function setService(id) {
    state.serviceId = id;
    state.time = '';
    setError('errService', '', 'fService');
    fillMasterSelect();
    loadSlots();
    updateSummary();
  }

  function setMaster(id) {
    state.masterId = id;
    state.time = '';
    setError('errMaster', '', 'fMaster');
    // У нового мастера свои выходные: ранее выбранная дата могла оказаться
    // нерабочей — тогда честнее сбросить её, чем молча показывать пустую сетку.
    if (state.date && isMasterDayOff(id, state.date)) {
      state.date = '';
      setError('errDate', 'В этот день мастер не работает — выберите другую дату');
    }
    renderCalendar();
    loadSlots();
    updateSummary();
  }

  function setDate(dateStr) {
    state.date = dateStr;
    state.time = '';
    setError('errDate', '');
    renderCalendar();
    loadSlots();
    updateSummary();
  }

  function setTime(time) {
    state.time = time;
    setError('errTime', '');
    // Перерисовываем только состояние кнопок — сетку целиком трогать незачем.
    Array.prototype.forEach.call(document.querySelectorAll('.slot-btn'), function (btn) {
      btn.setAttribute('aria-pressed', btn.textContent === time ? 'true' : 'false');
    });
    updateSummary();
  }

  /* ---------------------------------------------------------------------------
     Итоговая карточка выбора
     ------------------------------------------------------------------------ */

  function currentService() {
    if (!state.catalog) return null;
    return state.catalog.services.find(function (s) { return s.id === state.serviceId; }) || null;
  }

  function currentMaster() {
    if (!state.catalog) return null;
    return state.catalog.masters.find(function (m) { return m.id === state.masterId; }) || null;
  }

  function updateSummary() {
    var box = $('summary');
    var service = currentService();
    var master = currentMaster();

    // Показываем итог только когда выбрано всё до времени включительно —
    // иначе это просто набор прочерков, который ничего не сообщает.
    if (!service || !master || !state.date || !state.time) {
      box.hidden = true;
      return;
    }

    // Для варианта показываем и родителя: «Окрашивание волос — в один тон»,
    // иначе в итоге стоит просто «в один тон» и непонятно, чего именно.
    var parent = service.parentId && state.catalog
      ? state.catalog.services.find(function (x) { return x.id === service.parentId; })
      : null;
    var serviceLabel = parent ? parent.name + ' — ' + service.name : service.name;
    $('sumService').textContent = serviceLabel + ' · ' + formatDuration(service.duration);
    $('sumMaster').textContent = master.spec ? master.name + ' — ' + master.spec : master.name;
    $('sumWhen').textContent = formatDateHuman(state.date) + ', ' + state.time;

    var price = formatPrice(service.price);
    $('sumPriceRow').hidden = !price;
    if (price) $('sumPrice').textContent = price;

    box.hidden = false;
  }

  /* ---------------------------------------------------------------------------
     Проверка формы
     ------------------------------------------------------------------------ */

  function validatePhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (!digits) return 'Укажите номер телефона';
    if (digits.length < 10) return 'Номер слишком короткий — введите его полностью';
    if (digits.length > 15) return 'Проверьте номер — в нём слишком много цифр';
    return '';
  }

  function validateName(value) {
    var name = String(value || '').trim();
    if (name.length < 2) return 'Укажите имя — как к вам обращаться';
    if (!/[a-zA-Zа-яА-ЯёЁ]/.test(name)) return 'Имя должно содержать буквы';
    return '';
  }

  // Возвращает id первого поля с ошибкой либо пустую строку.
  function validateForm() {
    var firstBad = '';

    function mark(condition, errorId, message, focusId) {
      if (condition) {
        setError(errorId, message, focusId);
        if (!firstBad) firstBad = focusId || errorId;
      } else {
        setError(errorId, '', focusId);
      }
    }

    mark(!state.serviceId, 'errService', 'Выберите услугу', 'fService');
    mark(!state.masterId, 'errMaster', 'Выберите мастера', 'fMaster');
    mark(!state.date, 'errDate', 'Выберите дату', '');
    mark(!state.time, 'errTime', 'Выберите время', '');

    var nameErr = validateName($('fName').value);
    mark(!!nameErr, 'errName', nameErr, 'fName');

    var phoneErr = validatePhone($('fPhone').value);
    mark(!!phoneErr, 'errPhone', phoneErr, 'fPhone');

    mark(!$('fConsent').checked, 'errConsent',
      'Без согласия на обработку данных мы не сможем принять заявку', 'fConsent');

    return firstBad;
  }

  /* ---------------------------------------------------------------------------
     Отправка
     ------------------------------------------------------------------------ */

  function setBusy(isBusy) {
    var btn = $('submitBtn');
    btn.disabled = isBusy;
    btn.classList.toggle('is-busy', isBusy);
    btn.querySelector('.btn__label').textContent = isBusy ? 'Отправляем…' : 'Записаться';
  }

  function showFormError(message) {
    var box = $('formError');
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function submitForm(event) {
    event.preventDefault();
    clearAllErrors();

    var firstBad = validateForm();
    if (firstBad) {
      // Ведём человека к первой проблеме, а не оставляем гадать, что не так.
      var node = $(firstBad);
      if (node && typeof node.focus === 'function') {
        node.focus({ preventScroll: true });
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        var section = firstBad === 'errDate' ? $('calendar') : $('slotsBox');
        if (section) section.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }

    setBusy(true);

    apiPost('/api/book', {
      serviceId: state.serviceId,
      masterId: state.masterId,
      date: state.date,
      time: state.time,
      name: $('fName').value.trim(),
      phone: $('fPhone').value.trim(),
      comment: $('fComment').value.trim(),
      consent: $('fConsent').checked,
      website: $('website').value,
      elapsedSeconds: Math.round((Date.now() - state.startedAt) / 1000)
    })
      .then(function (data) {
        showDone(data.booking);
      })
      .catch(function (err) {
        setBusy(false);

        // Кто-то занял это время, пока клиент заполнял форму, — обновляем сетку
        // и явно объясняем, что произошло. Это единственный сценарий, где
        // «ошибка» является нормальным ходом событий.
        if (err.code === 'slot_taken' || err.code === 'slot_unavailable') {
          state.time = '';
          setError('errTime', err.message);
          loadSlots();
          updateSummary();
          showFormError(err.message);
          return;
        }

        // Ошибку конкретного поля показываем прямо под ним.
        var fieldMap = {
          name: ['errName', 'fName'],
          phone: ['errPhone', 'fPhone'],
          consent: ['errConsent', 'fConsent'],
          masterId: ['errMaster', 'fMaster'],
          serviceId: ['errService', 'fService'],
          date: ['errDate', ''],
          time: ['errTime', '']
        };
        var target = fieldMap[err.field];
        if (target) {
          setError(target[0], err.message, target[1]);
          var node = target[1] ? $(target[1]) : null;
          if (node) {
            node.focus({ preventScroll: true });
            node.scrollIntoView({ block: 'center', behavior: 'smooth' });
          }
          return;
        }

        showFormError(err.message || 'Не удалось отправить заявку. Попробуйте ещё раз.');
      });
  }

  function showDone(booking) {
    setBusy(false);
    $('bookingForm').hidden = true;

    var parts = [
      booking.serviceName,
      'мастер ' + booking.masterName,
      formatDateHuman(booking.date) + ' в ' + booking.time
    ];
    $('doneText').textContent = parts.join(' · ');

    var done = $('done');
    done.hidden = false;
    // Переводим фокус на экран успеха — иначе пользователь скринридера не
    // узнает, что форма исчезла и появился результат.
    done.focus();
    done.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function resetForm() {
    state.serviceId = '';
    state.masterId = '';
    state.date = '';
    state.time = '';
    state.slots = [];
    state.startedAt = Date.now();

    $('bookingForm').reset();
    clearAllErrors();
    fillMasterSelect();
    renderCalendar();
    loadSlots();
    updateSummary();

    $('done').hidden = true;
    $('bookingForm').hidden = false;
    $('bookingForm').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  /* ---------------------------------------------------------------------------
     Подписки на события
     ------------------------------------------------------------------------ */

  function bindEvents() {
    $('fService').addEventListener('change', function () { setService(this.value); });
    $('fMaster').addEventListener('change', function () { setMaster(this.value); });

    $('calPrev').addEventListener('click', function () { shiftMonth(-1); });
    $('calNext').addEventListener('click', function () { shiftMonth(1); });

    // Проверяем поля по уходу фокуса, а не на каждом нажатии клавиши: ругаться
    // на «+7 9», пока человек ещё печатает, — плохая манера.
    $('fName').addEventListener('blur', function () {
      setError('errName', validateName(this.value), 'fName');
    });
    $('fPhone').addEventListener('blur', function () {
      setError('errPhone', validatePhone(this.value), 'fPhone');
    });
    $('fConsent').addEventListener('change', function () {
      if (this.checked) setError('errConsent', '');
    });

    $('bookingForm').addEventListener('submit', submitForm);
    $('againBtn').addEventListener('click', resetForm);
    $('retryLoad').addEventListener('click', loadCatalog);

    // Тонкая линия под шапкой появляется только когда страница прокручена.
    var header = $('siteHeader');
    var onScroll = function () {
      header.classList.toggle('is-stuck', window.scrollY > 8);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------------------------------------------------------------------------
     Старт
     ------------------------------------------------------------------------ */

  bindEvents();
  renderCalendar();
  loadCatalog();
})();
