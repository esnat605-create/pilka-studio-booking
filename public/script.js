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
    // За один визит клиент может выбрать несколько услуг подряд — особенно в
    // эпиляции, где зон несколько десятков. Порядок в массиве и есть порядок
    // оказания.
    serviceIds: [],
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
    ['fMaster', 'fName', 'fPhone'].forEach(function (id) {
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
        renderServicePicker();
        renderCalendar();
      })
      .catch(function (err) {
        $('servicesList').setAttribute('aria-busy', 'false');
        $('mastersList').setAttribute('aria-busy', 'false');
        $('loadErrorText').textContent =
          err.message || 'Не удалось загрузить список услуг. Проверьте связь и попробуйте снова.';
        $('loadError').hidden = false;
        $('fServiceList').innerHTML = '';
        $('fServiceList').appendChild(el('p', 'svc-pick__empty', 'Не удалось загрузить список услуг.'));
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

  // Цена для показа. У обычной услуги это одно число либо вилка «от — до»,
  // если салон заполнил верхнюю границу: точная сумма зависит от длины волос,
  // объёма зоны и материалов, и честнее показать диапазон, чем одно число,
  // которое на кассе окажется другим.
  function priceLabel(s) {
    var lo = Number(s.price) || 0;
    var hi = (s.priceMax === null || s.priceMax === undefined || s.priceMax === '')
      ? null : Number(s.priceMax);
    if (hi !== null && hi > lo) return formatPrice(lo) + ' – ' + formatPrice(hi);
    return formatPrice(lo);
  }

  // У группы вилка считается по её вариантам: заполнять её руками означало бы
  // держать в двух местах одно и то же и однажды разойтись с прайсом.
  function variantsPriceLabel(variants) {
    if (!variants.length) return '';
    var prices = variants.map(function (v) { return Number(v.price) || 0; });
    var lo = Math.min.apply(null, prices);
    var hi = Math.max.apply(null, prices);
    return lo === hi ? formatPrice(lo) : formatPrice(lo) + ' – ' + formatPrice(hi);
  }

  // Блок «Услуги»: свёрнутые по умолчанию группы. Раскрываются нажатием,
  // внутри — услуги с галочками, а под услугой с вариантами её варианты со
  // своими ценой и длительностью.
  //
  // Сделано на <button> + скрытая панель, а не на <details>: так проще
  // управлять состоянием с клавиатуры и корректно проставить aria-expanded.
  function renderServices(data) {
    var box = $('servicesList');
    box.innerHTML = '';
    box.setAttribute('aria-busy', 'false');
    box.classList.add('services--accordion');

    // Прежние строки только что выброшены вместе с содержимым блока.
    SERVICE_ROWS.length = 0;
    SERVICE_GROUPS.length = 0;

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

      // Подсказка внутри раскрытой категории, а не на каждой строке: строк у
      // салона больше сотни, и приписка у каждой превратила бы прайс в
      // частокол. Здесь она попадается на глаза ровно один раз — перед тем как
      // клиент начнёт читать список.
      var tip = el('li', 'service-group__tip',
        'Отметьте одну или несколько услуг — форма записи появится здесь же, под списком.');
      tip.style.order = -1;
      list.appendChild(tip);

      // Порядок строк задаём через CSS order, а не перестановкой узлов: список
      // — грид, и order двигает недоступные строки вниз, не трогая разметку.
      // Шаг в 1000 между позициями оставляет место вариантам услуги и панели
      // записи, которая встаёт сразу под своей строкой.
      var pos = 0;
      rows.forEach(function (row) {
        var s = row.service;
        pos += 1000;

        if (row.heading) {
          var head2 = el('li', 'service-head');
          head2.appendChild(el('span', 'service-head__name', s.name));
          var range = variantsPriceLabel(row.variants);
          if (range) head2.appendChild(el('span', 'service-head__from', range));
          list.appendChild(head2);

          var groupEntries = [];
          row.variants.forEach(function (v, vi) {
            var entry = serviceRow(v, true, pos + 10 + vi * 10);
            groupEntries.push(entry);
            list.appendChild(entry.li);
          });
          // Группа вариантов уходит вниз целиком: вариант «— Голени» без своего
          // заголовка «Лазерная эпиляция» ничего не значит.
          SERVICE_GROUPS.push({ head: head2, base: pos, entries: groupEntries });
          return;
        }
        list.appendChild(serviceRow(s, false, pos).li);
      });

      panel.appendChild(list);

      head.addEventListener('click', function () {
        var open = head.getAttribute('aria-expanded') === 'true';
        // Сворачивают категорию, в которой открыта запись, — форму сначала
        // возвращаем на место. Иначе она уехала бы вместе с панелью, а раздел
        // «Онлайн-запись» в этот момент скрыт, и форма исчезла бы совсем.
        if (open && inlineSlot && panel.contains(inlineSlot)) closeInlineBooking();
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
        item.classList.toggle('is-open', !open);
      });

      item.appendChild(head);
      item.appendChild(panel);
      box.appendChild(item);
    });

    $('servicesNote').textContent =
      'Нажмите на категорию, чтобы раскрыть список, и отметьте услуги галочками — ' +
      'мастер, дата, время и ваши данные появятся здесь же, под списком. Услуги, которые нельзя ' +
      'сделать за один визит с уже выбранными, становятся серыми и уходят вниз списка. ' +
      'Точную стоимость подтвердит мастер: она зависит от длины волос и выбранных материалов.';
    refreshServiceRows();
    $('servicesNote').hidden = false;
  }

  /* ---------------------------------------------------------------------------
     Строки прайса с галочками
     ---------------------------------------------------------------------------
     За один визит клиент часто берёт несколько процедур подряд, но подряд их
     сделает только мастер, который умеет всё выбранное: визит идёт у одного
     человека. Поэтому услуги, несовместимые с уже отмеченными, гасим — серые,
     галочка не ставится, строка уходит вниз списка. Так клиент не соберёт
     набор, который потом некому выполнить.
     ------------------------------------------------------------------------ */

  var SERVICE_ROWS = [];   // {id, li, cb, base} — все строки прайса
  var SERVICE_GROUPS = []; // {head, base, entries} — услуги с вариантами
  var OFF = 1000000;       // насколько недоступная строка уезжает вниз

  // Есть ли мастер, который сделает весь набор за один визит. Пустой список
  // услуг у мастера означает «администратор ещё не настраивал» — такой мастер
  // делает всё; ровно та же логика в подборе мастера и на сервере.
  function someMasterDoesAll(ids) {
    if (!state.catalog) return true;
    var map = state.catalog.masterServices || {};
    return state.catalog.masters.some(function (m) {
      var own = map[m.id];
      if (!own || !own.length) return true;
      return ids.every(function (id) { return own.indexOf(id) !== -1; });
    });
  }

  // Можно ли добавить услугу к уже выбранным.
  function serviceSelectable(id) {
    if (state.serviceIds.indexOf(id) !== -1) return true; // уже выбрана — снять можно всегда
    if (!state.serviceIds.length) return true;            // первая услуга ограничений не знает
    return someMasterDoesAll(state.serviceIds.concat([id]));
  }

  // Пересчёт состояния всех строк прайса. Вызывается из renderServicePicker —
  // это общая точка «выбор изменился», куда сходятся и прайс, и карточки
  // мастеров, и форма.
  function refreshServiceRows() {
    if (!SERVICE_ROWS.length) return;
    SERVICE_ROWS.forEach(function (row) {
      var chosen = state.serviceIds.indexOf(row.id) !== -1;
      var can = serviceSelectable(row.id);
      row.cb.checked = chosen;
      row.cb.disabled = !can;
      row.off = !can;
      row.li.classList.toggle('service-row--off', !can);
      row.li.classList.toggle('is-chosen', chosen);
      if (can) row.li.removeAttribute('aria-disabled');
      else row.li.setAttribute('aria-disabled', 'true');
      row.li.title = can ? '' :
        'Эту услугу нельзя сделать за один визит с уже отмеченными: нет мастера, который делает всё сразу';
      // Одиночная строка уезжает вниз сама по себе; вариант — только внутри
      // своей группы, чтобы не оторваться от заголовка.
      row.li.style.order = row.base + (row.off ? (row.inGroup ? 500 : OFF) : 0);
    });
    // Группа вариантов уходит вниз целиком, только если недоступны все её
    // варианты: иначе заголовок остался бы наверху без своих строк.
    SERVICE_GROUPS.forEach(function (g) {
      var allOff = g.entries.length > 0 && g.entries.every(function (e) { return e.off; });
      g.head.classList.toggle('service-head--off', allOff);
      g.head.style.order = g.base + (allOff ? OFF : 0);
      g.entries.forEach(function (e) {
        e.li.style.order = e.base + (allOff ? OFF : (e.off ? 500 : 0));
      });
    });
  }

  function serviceRow(s, isVariant, base) {
    var price = priceLabel(s);
    var desc = (s.description || '').trim();
    var li = el('li', 'service-row' + (isVariant ? ' service-row--variant' : '') + (desc ? ' service-row--rich' : ''));
    li.style.order = base;

    var body = el('div', 'service-row__body');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'service-row__box';
    cb.value = s.id;
    cb.setAttribute('aria-label', s.name);
    body.appendChild(cb);

    var entry = { id: s.id, li: li, cb: cb, base: base, inGroup: !!isVariant, off: false };
    SERVICE_ROWS.push(entry);

    function toggled() {
      if (cb.checked) {
        // Услуга добавляется к набору, и панель записи встаёт под этой строкой.
        openInlineBooking(s.id, li);
      } else {
        toggleService(s.id, false);
        // Снята последняя — записываться не на что, панель закрываем.
        if (!state.serviceIds.length) closeInlineBooking();
      }
    }
    cb.addEventListener('change', toggled);
    // Нажатие в любое место строки равносильно нажатию на галочку: попадать
    // пальцем в квадратик 20×20 на телефоне неудобно. Сам чекбокс и кнопка
    // «ещё» обрабатываются отдельно, иначе выбор сработал бы дважды.
    li.addEventListener('click', function (ev) {
      if (cb.disabled) return;
      if (ev.target === cb) return;
      if (ev.target.closest && ev.target.closest('.service-row__more')) return;
      cb.checked = !cb.checked;
      toggled();
    });

    // Без описания — прежний компактный вид в одну строку: дешёвым допам вроде
    // «Снятия» развёрнутая карточка ни к чему, она только растягивает список.
    if (!desc) {
      body.appendChild(el('span', 'service-row__name', s.name));
      var meta = el('span', 'service-row__meta');
      meta.appendChild(el('span', 'service-row__dur', formatDuration(s.duration)));
      if (price) meta.appendChild(el('span', 'service-row__price', price));
      body.appendChild(meta);
      li.appendChild(body);
      return entry;
    }

    var main = el('span', 'service-row__main');
    main.appendChild(el('span', 'service-row__name', s.name));

    // Кнопка «ещё» лежит РЯДОМ с текстом, а не внутри него: внутри усекаемого
    // абзаца она обрезалась бы вместе с текстом, и нажать её было бы нечем.
    var line = el('span', 'service-row__desc');
    line.appendChild(el('span', 'service-row__text', formatDuration(s.duration) + ' · ' + desc));
    var more = el('button', 'service-row__more', 'ещё');
    more.type = 'button';
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = more.getAttribute('aria-expanded') === 'true';
      more.setAttribute('aria-expanded', open ? 'false' : 'true');
      more.textContent = open ? 'ещё' : 'свернуть';
      line.classList.toggle('is-open', !open);
    });
    line.appendChild(more);
    main.appendChild(line);

    if (price) main.appendChild(el('span', 'service-row__price service-row__price--big', price));
    body.appendChild(main);
    li.appendChild(body);
    return entry;
  }

  // Чем занимается мастер — одной строкой.
  //
  // Перечислять услуги дословно нельзя: у мастера эпиляции их два десятка, и
  // карточка превратилась бы в простыню. Поэтому сворачиваем до направлений:
  // берём категорию услуги (а если её нет — название группы) и показываем
  // несколько самых частых.
  var MAX_DIRECTIONS = 4;
  function masterDirections(master, data) {
    var own = (data.masterServices || {})[master.id];
    if (!own || !own.length) return 'Все услуги салона';
    var byId = {};
    data.services.forEach(function (s) { byId[s.id] = s; });
    var counts = {};
    own.forEach(function (id) {
      var s = byId[id];
      if (!s) return;
      var name = (s.category || '').trim();
      if (!name && s.parentId && byId[s.parentId]) name = byId[s.parentId].name;
      if (!name) return;
      counts[name] = (counts[name] || 0) + 1;
    });
    var names = Object.keys(counts).sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a.localeCompare(b, 'ru');
    });
    if (!names.length) return '';
    var shown = names.slice(0, MAX_DIRECTIONS);
    var rest = names.length - shown.length;
    // Заголовки категорий в базе набраны по-разному («МАНИКЮР», «Маникюр») —
    // приводим к одному виду, иначе строка выглядит неряшливо.
    var text = shown.map(function (n) { return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase(); }).join(' · ');
    return rest > 0 ? text + ' и ещё ' + rest : text;
  }

  // Услуги конкретного мастера — те, что можно записать.
  //
  // Пустой список в справочнике означает «администратор ещё не настраивал» —
  // такой мастер делает всё, ровно как в подборе мастера под выбранные услуги.
  // Родительские позиции («Маникюр» с вариантами внутри) отсеиваем: записаться
  // на них нельзя, в форме их тоже нет.
  function masterServiceList(master, data) {
    var all = data.services || [];
    var bookable = all.filter(function (s) { return isBookable(s, all); });
    var own = (data.masterServices || {})[master.id];
    if (!own || !own.length) return bookable;
    return bookable.filter(function (s) { return own.indexOf(s.id) !== -1; });
  }

  // Галочки в раскрытых карточках мастеров и список услуг в форме — это один и
  // тот же выбор, показанный в двух местах. Разойтись им нельзя: клиент отметил
  // услугу у мастера, прокрутил к форме — и она обязана быть отмечена и там.
  // Поэтому каждая построенная панель оставляет здесь свою функцию обновления.
  var MASTER_PANEL_SYNCS = [];
  function syncMasterPanels() { MASTER_PANEL_SYNCS.forEach(function (fn) { fn(); }); }

  // Раскрывающийся список услуг мастера: галочками отмечают одну или несколько
  // услуг прямо здесь, а кнопка внизу уводит к выбору даты и времени с уже
  // подставленным мастером.
  function masterPanelContent(m, data) {
    var box = document.createDocumentFragment();
    var wrap = el('div', 'master-panel__inner');
    box.appendChild(wrap);

    var list = masterServiceList(m, data);
    if (!list.length) {
      wrap.appendChild(el('p', 'master-panel__empty',
        'Услуги этого мастера ещё не настроены — выберите услугу в форме записи ниже.'));
      return box;
    }

    wrap.appendChild(el('p', 'master-panel__hint', 'Отметьте услуги — можно несколько, цена и время сложатся.'));

    var boxes = [];
    var groups = groupServices(list);
    var listBox = el('div', 'master-svc');
    groups.forEach(function (group) {
      // Заголовок категории нужен, только когда категорий несколько: у мастера
      // с тремя услугами одного направления он был бы лишним шумом.
      if (groups.length > 1) listBox.appendChild(el('p', 'master-svc__group', group.title));
      group.items.forEach(function (s) {
        // <label> с галочкой внутри: нажатие в любое место строки переключает
        // её, и это работает само, без обработчиков.
        var row = el('label', 'master-svc__row');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = s.id;
        cb.checked = state.serviceIds.indexOf(s.id) !== -1;
        cb.addEventListener('change', function () { toggleService(s.id, cb.checked); });
        boxes.push(cb);
        row.appendChild(cb);
        row.appendChild(el('span', 'master-svc__name', serviceFullName(s)));
        var price = priceLabel(s);
        row.appendChild(el('span', 'master-svc__meta', formatDuration(s.duration) + (price ? ' · ' + price : '')));
        // Без остановки всплытия нажатие по строке дошло бы до шапки карточки и
        // свернуло панель ровно в тот момент, когда клиент ставит галочку.
        row.addEventListener('click', function (ev) { ev.stopPropagation(); });
        listBox.appendChild(row);
      });
    });
    wrap.appendChild(listBox);

    // Подвал лежит НЕ в прокручиваемой части: у мастера с большим списком итог
    // и кнопку пришлось бы искать в самом низу прокрутки.
    var foot = el('div', 'master-panel__foot');
    var total = el('p', 'master-panel__total');
    var err = el('p', 'master-panel__err');
    var pick = el('button', 'btn btn--primary btn--sm master-panel__pick', 'Выбрать время');
    pick.type = 'button';
    pick.addEventListener('click', function (ev) { ev.stopPropagation(); goToTimeWithMaster(m.id, err); });
    foot.appendChild(total);
    foot.appendChild(pick);
    foot.appendChild(err);
    box.appendChild(foot);

    function sync() {
      boxes.forEach(function (cb) { cb.checked = state.serviceIds.indexOf(cb.value) !== -1; });
      var t = selectionTotals();
      pick.disabled = t.count === 0;
      total.textContent = t.count
        ? 'Выбрано: ' + t.count + ' · ' + formatPrice(t.price) + ' · ' + formatDuration(t.duration)
        : 'Ничего не отмечено';
      // Выбор изменился — прежняя жалоба могла стать неверной.
      err.textContent = '';
    }
    MASTER_PANEL_SYNCS.push(sync);
    sync();

    return box;
  }

  function renderMasters(data) {
    var box = $('mastersList');
    box.innerHTML = '';
    box.setAttribute('aria-busy', 'false');
    // Старые панели вместе с карточками только что выброшены — их функции
    // обновления держали бы ссылки на элементы, которых больше нет.
    MASTER_PANEL_SYNCS.length = 0;

    if (!data.masters.length) {
      box.appendChild(el('p', 'slots__empty', 'Список мастеров пока не заполнен.'));
      return;
    }

    data.masters.forEach(function (m) {
      // Ячейка сетки — обёртка: внутри шапка-кнопка и скрытый список услуг.
      // Раскрытие меняет высоту только своей карточки, соседние не растягивает.
      var item = el('div', 'master');
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

      var info = el('div', 'master-card__info');
      info.appendChild(el('div', 'master-card__name', m.name));
      if (m.spec) info.appendChild(el('div', 'master-card__spec', m.spec));
      var does = masterDirections(m, data);
      if (does) info.appendChild(el('div', 'master-card__does', does));
      card.appendChild(info);

      var chevron = el('span', 'master-card__chevron');
      chevron.setAttribute('aria-hidden', 'true');
      card.appendChild(chevron);

      // Карточка мастера — кнопка: нажатие раскрывает список его услуг.
      var panel = el('div', 'master-panel');
      panel.id = 'masterPanel-' + m.id;
      panel.hidden = true;

      card.classList.add('master-card--pick');
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-expanded', 'false');
      card.setAttribute('aria-controls', panel.id);
      card.title = 'Показать услуги мастера';

      var built = false;
      function toggle() {
        var open = card.getAttribute('aria-expanded') === 'true';
        // Содержимое собираем при первом раскрытии: у мастера без настроенного
        // списка в панели весь прайс салона, и строить его всем мастерам сразу
        // при загрузке страницы незачем.
        if (!open && !built) {
          panel.appendChild(masterPanelContent(m, data));
          built = true;
        }
        card.setAttribute('aria-expanded', open ? 'false' : 'true');
        panel.hidden = open;
        item.classList.toggle('is-open', !open);
      }
      card.addEventListener('click', toggle);
      card.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });

      item.appendChild(card);
      item.appendChild(panel);
      box.appendChild(item);
    });
  }

  /* ---------------------------------------------------------------------------
     Выпадающие списки услуги и мастера
     ------------------------------------------------------------------------ */

  // Полное имя услуги для списков и итога: вариант без родителя непонятен —
  // «в один тон» само по себе ничего не значит.
  function serviceFullName(s) {
    if (!s) return '';
    var parent = s.parentId && state.catalog
      ? state.catalog.services.find(function (x) { return x.id === s.parentId; })
      : null;
    return parent ? parent.name + ' — ' + s.name : s.name;
  }

  function selectedServices() {
    if (!state.catalog) return [];
    return state.serviceIds
      .map(function (id) {
        return state.catalog.services.find(function (s) { return s.id === id; });
      })
      .filter(Boolean);
  }

  function selectionTotals() {
    var list = selectedServices();
    return {
      count: list.length,
      price: list.reduce(function (n, s) { return n + (Number(s.price) || 0); }, 0),
      duration: list.reduce(function (n, s) { return n + (Number(s.duration) || 0); }, 0)
    };
  }

  function serviceMatchesQuery(s, q) {
    if (!q) return true;
    return (serviceFullName(s) + ' ' + (s.category || '')).toLowerCase().indexOf(q) !== -1;
  }

  // Шаг 1: список услуг с галочками. Список длинный (у салона больше сотни
  // позиций), поэтому он прокручивается, сверху есть поиск, а всё отмеченное
  // закреплено вверху — иначе при поиске выбранная услуга уезжала бы из виду
  // и казалось, что выбор слетел.
  function renderServicePicker() {
    var box = $('fServiceList');
    if (!box) return;
    var data = state.catalog;
    box.innerHTML = '';

    if (!data) {
      box.appendChild(el('p', 'svc-pick__empty', 'Загружаем услуги…'));
      return;
    }

    var bookable = data.services.filter(function (s) { return isBookable(s, data.services); });
    if (!bookable.length) {
      box.appendChild(el('p', 'svc-pick__empty', 'Услуги ещё не добавлены.'));
      return;
    }

    var q = ($('fServiceSearch').value || '').trim().toLowerCase();
    var chosen = selectedServices();
    var chosenIds = state.serviceIds;
    var rest = bookable.filter(function (s) {
      return chosenIds.indexOf(s.id) === -1 && serviceMatchesQuery(s, q);
    });

    function row(s, checked) {
      var label = el('label', 'svc-pick__row');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.id;
      cb.checked = checked;
      cb.addEventListener('change', function () { toggleService(s.id, cb.checked); });
      label.appendChild(cb);
      label.appendChild(el('span', 'svc-pick__name', serviceFullName(s)));
      var meta = el('span', 'svc-pick__meta',
        formatDuration(s.duration) + (formatPrice(s.price) ? ' · ' + formatPrice(s.price) : ''));
      label.appendChild(meta);
      return label;
    }

    if (chosen.length) {
      box.appendChild(el('p', 'svc-pick__group', 'Выбрано'));
      chosen.forEach(function (s) { box.appendChild(row(s, true)); });
    }

    if (rest.length) {
      groupServices(rest).forEach(function (group) {
        box.appendChild(el('p', 'svc-pick__group', group.title));
        group.items.forEach(function (s) { box.appendChild(row(s, false)); });
      });
    } else if (!chosen.length) {
      box.appendChild(el('p', 'svc-pick__empty',
        q ? 'Ничего не нашлось — попробуйте другое слово.' : 'Услуги ещё не добавлены.'));
    }

    var totals = selectionTotals();
    var total = $('fServiceTotal');
    total.hidden = totals.count === 0;
    if (totals.count) {
      // Названия, а не только сумма: во встроенной форме список услуг свёрнут,
      // и без них клиент не видит, на что именно записывается.
      total.textContent = chosen.map(serviceFullName).join(' + ') + ' — ' +
        formatPrice(totals.price) + ' · ' + formatDuration(totals.duration);
    }

    // Тот же выбор показан галочками в раскрытых карточках мастеров и в самом
    // прайсе — расходиться этим трём местам нельзя.
    syncMasterPanels();
    refreshServiceRows();
    renderPickBar();
  }

  // Выходные выбранного мастера. Пустой список означает «работает всегда» —
  // это поведение по умолчанию, пока администратор не заполнил график.
  function daysOffForMaster(masterId) {
    if (!state.catalog || !state.catalog.daysOff) return [];
    return state.catalog.daysOff[masterId] || [];
  }

  function isMasterDayOff(masterId, dateStr) {
    return daysOffForMaster(masterId).indexOf(dateStr) !== -1;
  }

  // Мастер подходит, только если делает ВСЁ выбранное: визит идёт подряд у
  // одного мастера, и предложить того, кто половину не оказывает, значило бы
  // отправить клиента в заведомо неисполнимую запись.
  function mastersForSelection() {
    if (!state.catalog || !state.serviceIds.length) return [];
    var map = state.catalog.masterServices || {};
    return state.catalog.masters.filter(function (m) {
      var own = map[m.id];
      if (!own || !own.length) return true;   // список не настроен — делает всё
      return state.serviceIds.every(function (id) { return own.indexOf(id) !== -1; });
    });
  }

  function fillMasterSelect() {
    var sel = $('fMaster');
    sel.innerHTML = '';

    if (!state.serviceIds.length) {
      sel.appendChild(new Option('Сначала выберите услуги', ''));
      sel.disabled = true;
      return;
    }

    var list = mastersForSelection();
    if (!list.length) {
      sel.appendChild(new Option(
        state.serviceIds.length > 1
          ? 'Нет мастера, который делает всё выбранное — уберите часть услуг'
          : 'Нет свободных мастеров для этой услуги', ''));
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
    if (!state.serviceIds.length || !state.masterId || !state.date) {
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
      serviceIds: state.serviceIds.join(','),
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

  /* ---------------------------------------------------------------------------
     Запись прямо из списка услуг
     ---------------------------------------------------------------------------
     Форма не дублируется, а ПЕРЕЕЗЖАЕТ: тот же самый DOM-узел формы переносится
     под выбранную строку прайса и возвращается на место при закрытии. Вторая,
     отдельно написанная форма неизбежно разошлась бы с этой в проверках,
     расчёте свободного времени и отправке — а так расходиться нечему, узел
     один.
     ------------------------------------------------------------------------ */
  var inlineSlot = null; // <li>, в который переехала форма; null — форма дома

  function bookingBox() { return $('bookingBox'); }

  // Внутри строки прайса длинный список всех услуг салона ни к чему: клиент уже
  // выбрал услугу нажатием. Показываем итог, а список прячем за кнопкой.
  function setInlineFormMode(on) {
    var form = $('bookingForm');
    var toggle = $('fServiceToggle');
    if (!form) return;
    form.classList.toggle('form--inline', on);
    form.classList.remove('is-picking');
    if (toggle) {
      toggle.hidden = !on;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'Изменить услуги';
    }
  }

  /* ---------------------------------------------------------------------------
     Нижняя панель выбора
     ---------------------------------------------------------------------------
     Пока клиент отмечает услуги, форма записи стоит под списком категории и
     часто оказывается за краем экрана. Панель держит перед глазами итог и даёт
     перейти к записи одним нажатием — не отвлекая от выбора и не уводя из
     списка после первой же галочки. Показываем её, только когда форма
     действительно не видна: висеть поверх формы, к которой она же и ведёт,
     панели незачем.
     ------------------------------------------------------------------------ */
  var panelOffScreen = true;
  var panelWatcher = null;

  function watchInlinePanel() {
    if (panelWatcher) { panelWatcher.disconnect(); panelWatcher = null; }
    if (!inlineSlot) { panelOffScreen = true; renderPickBar(); return; }
    if (!window.IntersectionObserver) {
      // Без наблюдателя показываем панель всегда: лучше лишняя кнопка, чем
      // потерянная форма.
      panelOffScreen = true;
      renderPickBar();
      return;
    }
    panelWatcher = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { panelOffScreen = !e.isIntersecting; });
      renderPickBar();
    }, { threshold: 0.1 });
    panelWatcher.observe(inlineSlot);
  }

  function renderPickBar() {
    var bar = $('pickBar');
    if (!bar) return;
    var totals = selectionTotals();
    var show = !!inlineSlot && totals.count > 0 && panelOffScreen;
    bar.hidden = !show;
    document.body.classList.toggle('has-pickbar', show);
    if (!show) return;
    // «Выбрано 2 услуги» — с правильным окончанием: «1 услуга», «2 услуги»,
    // «5 услуг». Мелочь, но текст с ошибкой в согласовании читается как брак.
    var n = totals.count;
    var last = n % 10;
    var word = (n % 100 >= 11 && n % 100 <= 14) ? 'услуг' : last === 1 ? 'услуга' : (last >= 2 && last <= 4) ? 'услуги' : 'услуг';
    $('pickBarInfo').textContent = n + ' ' + word + ' · ' + formatPrice(totals.price) + ' · ' + formatDuration(totals.duration);
  }

  function closeInlineBooking(opts) {
    if (!inlineSlot) return;
    var home = $('bookingHome');
    if (home) home.appendChild(bookingBox());
    setInlineFormMode(false);
    var section = $('booking');
    if (section) section.hidden = false;
    var skip = document.querySelector('.skip-link');
    if (skip) skip.setAttribute('href', '#booking');
    if (inlineSlot.parentNode) inlineSlot.parentNode.removeChild(inlineSlot);
    inlineSlot = null;
    watchInlinePanel();
    // Возврат фокуса на строку, из которой открывали, — иначе после закрытия
    // с клавиатуры фокус уезжает в начало страницы.
    if (opts && opts.focusRow && opts.focusRow.focus) opts.focusRow.focus();
  }

  function openInlineBooking(serviceId, rowNode) {
    // После успешной записи на месте формы висит «Вы записаны». Если клиент
    // тут же выбирает следующую услугу, ему нужна чистая форма, а не прошлый
    // результат — иначе панель откроется с сообщением о прежней записи.
    if (!$('done').hidden) resetForm();

    // Услуга именно добавляется, а не заменяет набор: за один визит клиент
    // часто берёт несколько процедур подряд, и так это и задумано.
    if (state.serviceIds.indexOf(serviceId) === -1) toggleService(serviceId, true);
    else renderServicePicker();

    var list = rowNode && rowNode.parentNode;
    if (!list) { jumpToBooking(''); return; }

    // Панель уже открыта — просто переставляем её под новую строку, не
    // пересобирая: так не теряются введённые имя и телефон.
    var fresh = !inlineSlot;
    if (!inlineSlot) {
      inlineSlot = el('li', 'svc-book');
      inlineSlot.id = 'svcBookSlot';
      var head = el('div', 'svc-book__head');
      head.appendChild(el('span', 'svc-book__title', 'Запись'));
      var close = el('button', 'svc-book__close', '✕');
      close.type = 'button';
      close.setAttribute('aria-label', 'Закрыть запись');
      close.addEventListener('click', function () { closeInlineBooking({ focusRow: rowNode }); });
      head.appendChild(close);
      inlineSlot.appendChild(head);
      inlineSlot.appendChild(bookingBox());

      var section = $('booking');
      if (section) section.hidden = true;
      var skip = document.querySelector('.skip-link');
      if (skip) skip.setAttribute('href', '#svcBookSlot');
    }

    // Панель встаёт ПОД списком услуг категории, а не вплотную под нажатой
    // строкой: услуг выбирают несколько, и форма посреди списка заставляла бы
    // прокручивать её целиком, чтобы отметить вторую услугу. Порядок задаём
    // числом между доступными строками и погашенными — так форма оказывается
    // сразу после того, что ещё можно выбрать.
    list.appendChild(inlineSlot);
    inlineSlot.style.order = OFF / 2;

    // Переключаем вид формы только ПОСЛЕ вставки панели в страницу:
    // getElementById находит элементы лишь в документе, а до этой строки форма
    // лежит в ещё не вставленном узле и по id не находится вовсе.
    setInlineFormMode(true);

    // К форме НЕ прокручиваем — ни при первом выборе, ни при следующих.
    // В длинной категории первая же галочка уносила бы клиента в конец
    // списка, и чтобы отметить вторую услугу, приходилось листать обратно.
    // Теперь о том, что выбор сделан, сообщает нижняя панель, а перейти к
    // записи клиент решает сам.
    if (fresh) watchInlinePanel();
  }

  // Переход к форме записи с уже сделанным выбором. Нужен блокам «Услуги» и
  // «Мастера»: записаться можно прямо оттуда, не пролистывая страницу назад и
  // не выбирая всё заново.
  function jumpToBooking(focusId) {
    var target = document.getElementById('booking');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!focusId) return;
    // Фокус ставим после прокрутки: иначе браузер дёрнет страницу к элементу
    // сам и плавность потеряется.
    window.setTimeout(function () {
      var n = document.getElementById(focusId);
      if (n) n.focus({ preventScroll: true });
    }, 450);
  }

  // Кнопка «Выбрать время» в раскрытой карточке мастера: ставим мастера и
  // уводим сразу к календарю — услуги клиент уже отметил галочками выше.
  //
  // Сообщения о помехах пишем в саму карточку, а не в форму: клиент смотрит
  // сюда, и ошибка, выведенная за экран, для него равна молчанию.
  function goToTimeWithMaster(masterId, errNode) {
    function complain(text) { if (errNode) errNode.textContent = text; }
    if (!state.serviceIds.length) { complain('Отметьте хотя бы одну услугу.'); return; }
    // В наборе может остаться услуга, отмеченная у другого мастера. Визит идёт
    // подряд у одного человека, поэтому такой набор неисполним.
    if (!mastersForSelection().some(function (m) { return m.id === masterId; })) {
      complain('Отмечено что-то, чего этот мастер не делает. В списке выше только его услуги — лишние галочки снимите в форме записи.');
      return;
    }
    complain('');
    $('fMaster').value = masterId;
    setMaster(masterId);
    // Если форма сейчас живёт в списке услуг, раздел «Онлайн-запись» скрыт —
    // прокручивать к нему бессмысленно, сперва возвращаем форму на место.
    closeInlineBooking();
    // Ведём к шагу с датой, а не к началу формы: услуга и мастер уже выбраны,
    // и первое, что осталось сделать, — выбрать день.
    var step = document.getElementById('calendar');
    if (step) step.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else jumpToBooking('');
  }

  function toggleService(id, on) {
    var i = state.serviceIds.indexOf(id);
    if (on && i === -1) state.serviceIds.push(id);
    if (!on && i !== -1) state.serviceIds.splice(i, 1);

    // Время всегда сбрасываем: длительность визита изменилась, и прежний слот
    // мог перестать помещаться.
    state.time = '';
    setError('errService', '');
    renderServicePicker();
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
    var list = selectedServices();
    return list.length ? list[0] : null;
  }

  function currentMaster() {
    if (!state.catalog) return null;
    return state.catalog.masters.find(function (m) { return m.id === state.masterId; }) || null;
  }

  function updateSummary() {
    var box = $('summary');
    var chosen = selectedServices();
    var service = chosen.length ? chosen[0] : null;
    var master = currentMaster();

    // Показываем итог только когда выбрано всё до времени включительно —
    // иначе это просто набор прочерков, который ничего не сообщает.
    if (!service || !master || !state.date || !state.time) {
      box.hidden = true;
      return;
    }

    // Перечисляем все услуги визита и показываем общую длительность: клиент
    // должен понимать, что бронирует полтора часа, а не двадцать минут.
    var totals = selectionTotals();
    $('sumService').textContent =
      chosen.map(serviceFullName).join(' + ') + ' · ' + formatDuration(totals.duration);
    $('sumMaster').textContent = master.spec ? master.name + ' — ' + master.spec : master.name;
    $('sumWhen').textContent = formatDateHuman(state.date) + ', ' + state.time;

    var price = formatPrice(totals.price);
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

    mark(!state.serviceIds.length, 'errService', 'Выберите хотя бы одну услугу', '');
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
      serviceIds: state.serviceIds,
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
          serviceId: ['errService', ''],
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
    state.serviceIds = [];
    state.masterId = '';
    state.date = '';
    state.time = '';
    state.slots = [];
    state.startedAt = Date.now();

    $('bookingForm').reset();
    clearAllErrors();
    renderServicePicker();
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
    $('fServiceSearch').addEventListener('input', renderServicePicker);
    $('pickBarGo').addEventListener('click', function () {
      if (inlineSlot) inlineSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('fMaster').addEventListener('change', function () { setMaster(this.value); });
    // «Изменить услуги» во встроенной форме: раскрывает обычный список, чтобы
    // можно было добавить процедуру к визиту или снять лишнюю.
    $('fServiceToggle').addEventListener('click', function () {
      var form = $('bookingForm');
      var open = form.classList.toggle('is-picking');
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
      this.textContent = open ? 'Свернуть список' : 'Изменить услуги';
      if (open) $('fServiceSearch').focus();
    });

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
