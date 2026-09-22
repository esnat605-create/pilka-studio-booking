/* =============================================================================
   Pilka Studio — личный кабинет клиента
   -----------------------------------------------------------------------------
   Вход устроен так: страница просит у сервера одноразовый код, показывает
   ссылку на бота, а затем опрашивает сервер — подтвердил ли клиент номер.
   Сам телефон на странице никогда не вводится: его сообщает Telegram, поэтому
   открыть чужой кабинет, зная чужой номер, невозможно.
   ========================================================================== */

(function () {
  'use strict';

  var state = { nonce: '', timer: null, tries: 0, today: '', horizonDays: 60 };

  // Опрос: раз в 2 секунды, не дольше 5 минут — дальше код всё равно протухнет.
  var POLL_MS = 2000;
  var MAX_TRIES = 150;

  var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  var WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда',
    'четверг', 'пятница', 'суббота'];

  // Статусы, при которых посещение не состоялось.
  var CANCELLED = ['Отменён клиентом', 'Отменён салоном', 'Не пришёл'];

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function parseYmd(s) {
    var p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function formatDate(s) {
    var d = parseYmd(s);
    return d.getDate() + ' ' + MONTHS_GEN[d.getMonth()] + ' ' + d.getFullYear();
  }

  function formatDateLong(s) {
    var d = parseYmd(s);
    return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_GEN[d.getMonth()];
  }

  function formatPrice(v) {
    var n = Number(v) || 0;
    return n ? n.toLocaleString('ru-RU') + ' ₽' : '';
  }

  // Склонение: 1 посещение, 2 посещения, 5 посещений.
  function plural(n, one, few, many) {
    n = Math.abs(Number(n) || 0);
    var d10 = n % 10, d100 = n % 100;
    var w = (d100 >= 11 && d100 <= 14) ? many
      : d10 === 1 ? one
      : (d10 >= 2 && d10 <= 4) ? few
      : many;
    return n + ' ' + w;
  }

  function api(action, extra) {
    return fetch('/api/cabinet', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, extra || {})),
    }).then(function (res) {
      return res.text().then(function (t) {
        var d = null;
        try { d = JSON.parse(t); } catch (e) { /* не JSON */ }
        if (!d) throw new Error('Сервис временно недоступен. Попробуйте позже.');
        if (!res.ok || d.ok === false) {
          var err = new Error(d.error || 'Не удалось выполнить запрос');
          err.code = d.code || '';
          throw err;
        }
        return d;
      });
    });
  }

  function showError(msg) {
    var box = $('cabError');
    box.textContent = msg;
    box.hidden = false;
  }

  function show(which) {
    $('cabLoading').hidden = which !== 'loading';
    $('cabLogin').hidden = which !== 'login';
    $('cabHome').hidden = which !== 'home';
  }

  /* ---------------------------------------------------------------------------
     Вход
     ------------------------------------------------------------------------ */

  function startLogin() {
    var btn = $('cabStartBtn');
    btn.disabled = true;
    btn.classList.add('is-busy');
    $('cabError').hidden = true;

    api('start')
      .then(function (d) {
        state.nonce = d.nonce;
        state.tries = 0;
        $('cabTgLink').href = d.link;
        $('cabStep1').hidden = true;
        $('cabStep2').hidden = false;

        // Открываем бота сразу: на телефоне это переключение в приложение,
        // и лишний тап здесь только мешает.
        window.open(d.link, '_blank', 'noopener');
        poll();
      })
      .catch(function (e) {
        showError(e.message);
      })
      .finally(function () {
        btn.disabled = false;
        btn.classList.remove('is-busy');
      });
  }

  function poll() {
    clearTimeout(state.timer);
    if (state.tries++ > MAX_TRIES) {
      $('cabWaiting').textContent = 'Время ожидания истекло. Нажмите «Начать заново».';
      return;
    }

    api('poll', { nonce: state.nonce })
      .then(function (d) {
        if (d.state === 'ready') { loadCabinet(); return; }
        if (d.state === 'expired') {
          $('cabWaiting').textContent = 'Ссылка устарела. Нажмите «Начать заново».';
          return;
        }
        state.timer = setTimeout(poll, POLL_MS);
      })
      .catch(function () {
        // Сетевая заминка — не повод прекращать ожидание.
        state.timer = setTimeout(poll, POLL_MS * 2);
      });
  }

  function restart() {
    clearTimeout(state.timer);
    state.nonce = '';
    $('cabStep2').hidden = true;
    $('cabStep1').hidden = false;
    $('cabWaiting').innerHTML =
      '<span class="spinner spinner--inline" aria-hidden="true"></span> Ждём подтверждения…';
    $('cabError').hidden = true;
  }

  /* ---------------------------------------------------------------------------
     Кабинет
     ------------------------------------------------------------------------ */

  function loadCabinet(notice) {
    clearTimeout(state.timer);
    show('loading');

    api('me')
      .then(function (d) {
        if (!d.authorized) { show('login'); return; }
        renderCabinet(d);
        show('home');
        var box = $('cabNotice');
        box.hidden = !notice;
        box.textContent = notice || '';
        if (notice) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      })
      .catch(function (e) {
        show('login');
        showError(e.message);
      });
  }

  function renderCabinet(d) {
    state.today = d.today || '';
    state.horizonDays = Number(d.horizonDays) || 60;
    var firstName = String(d.client.name || '').trim().split(' ')[0] || 'Здравствуйте';
    $('cabHello').textContent = 'Здравствуйте, ' + firstName;

    // ---- сводка ----------------------------------------------------------
    var stats = $('cabStats');
    stats.innerHTML = '';
    var tiles = [
      { v: String(d.stats.visits), l: plural(d.stats.visits, 'посещение', 'посещения', 'посещений').split(' ')[1] },
      { v: formatPrice(d.stats.spent) || '—', l: 'на услуги' },
    ];
    if (d.stats.since) tiles.push({ v: formatDate(d.stats.since), l: 'первый визит' });

    tiles.forEach(function (t) {
      var tile = el('div', 'cab-stat');
      tile.appendChild(el('div', 'cab-stat__value', t.v));
      tile.appendChild(el('div', 'cab-stat__label', t.l));
      stats.appendChild(tile);
    });

    // ---- предстоящие -----------------------------------------------------
    var up = $('cabUpcoming');
    up.innerHTML = '';
    if (!d.upcoming.length) {
      up.appendChild(el('p', 'slots__empty', 'Предстоящих записей нет.'));
    } else {
      d.upcoming.forEach(function (v) { up.appendChild(visitCard(v, true)); });
    }

    // ---- история ---------------------------------------------------------
    var past = $('cabPast');
    past.innerHTML = '';
    if (!d.past.length) {
      past.appendChild(el('p', 'slots__empty', 'Здесь появится история ваших посещений.'));
      return;
    }

    // Группируем по годам — так длинный список читается заметно легче.
    var byYear = {};
    var years = [];
    d.past.forEach(function (v) {
      var y = v.date.slice(0, 4);
      if (!byYear[y]) { byYear[y] = []; years.push(y); }
      byYear[y].push(v);
    });

    years.forEach(function (y) {
      past.appendChild(el('div', 'cab-year', y));
      byYear[y].forEach(function (v) { past.appendChild(visitCard(v, false)); });
    });
  }

  function visitCard(v, upcoming) {
    var cancelled = CANCELLED.indexOf(v.status) !== -1;
    var card = el('div', 'cab-visit' + (cancelled ? ' cab-visit--off' : ''));

    var when = el('div', 'cab-visit__when');
    when.appendChild(el('span', 'cab-visit__date',
      upcoming ? formatDateLong(v.date) : formatDate(v.date)));
    when.appendChild(el('span', 'cab-visit__time', v.time));
    card.appendChild(when);

    var body = el('div', 'cab-visit__body');
    body.appendChild(el('div', 'cab-visit__service', v.serviceName || 'Услуга'));
    if (v.masterName) body.appendChild(el('div', 'cab-visit__master', 'мастер ' + v.masterName));
    card.appendChild(body);

    var side = el('div', 'cab-visit__side');
    var price = formatPrice(v.price);
    if (price && !cancelled) side.appendChild(el('span', 'cab-visit__price', price));
    if (cancelled || upcoming) side.appendChild(el('span', 'cab-visit__status', v.status));
    card.appendChild(side);

    if (upcoming && !cancelled && v.status !== 'Оказана услуга') {
      if (v.canChange) addChangeControls(card, v);
      else {
        card.appendChild(el('p', 'cab-visit__note',
          'Изменить запись онлайн уже нельзя (не позже чем за 2 часа до визита). Напишите нам в WhatsApp — поможем.'));
      }
    }

    return card;
  }

  /* ---------------------------------------------------------------------------
     Перенос и отмена своей записи
     ---------------------------------------------------------------------------
     Меняются только дата и время — мастер и услуги остаются прежними. Сервер
     ещё раз проверяет всё сам: что запись именно этого клиента, что до визита
     больше 2 часов и что новое время действительно свободно.
     ------------------------------------------------------------------------ */

  function addDays(ymd, n) {
    var p = String(ymd).split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
    return d.toISOString().slice(0, 10);
  }

  function addChangeControls(card, v) {
    var actions = el('div', 'cab-visit__actions');
    var moveBtn = el('button', 'btn btn--ghost btn--sm', 'Перенести');
    var cancelBtn = el('button', 'btn btn--ghost btn--sm cab-btn--danger', 'Отменить');
    moveBtn.type = 'button';
    cancelBtn.type = 'button';
    actions.appendChild(moveBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);

    var panel = el('div', 'cab-change');
    panel.hidden = true;
    card.appendChild(panel);

    function open(builder) {
      var wasOpen = !panel.hidden && panel.dataset.kind === builder.kind;
      panel.innerHTML = '';
      panel.hidden = wasOpen;
      if (wasOpen) return;
      panel.dataset.kind = builder.kind;
      builder(panel, v);
    }
    buildMove.kind = 'move';
    buildCancel.kind = 'cancel';
    moveBtn.addEventListener('click', function () { open(buildMove); });
    cancelBtn.addEventListener('click', function () { open(buildCancel); });
  }

  function buildCancel(panel, v) {
    panel.appendChild(el('p', 'cab-change__q',
      'Отменить запись на ' + formatDateLong(v.date) + ', ' + v.time + '?'));
    var err = el('p', 'field-error');
    var row = el('div', 'cab-change__row');
    var yes = el('button', 'btn btn--primary btn--sm', 'Да, отменить');
    var no = el('button', 'btn btn--ghost btn--sm', 'Нет');
    yes.type = 'button';
    no.type = 'button';
    row.appendChild(yes);
    row.appendChild(no);
    panel.appendChild(row);
    panel.appendChild(err);

    no.addEventListener('click', function () { panel.hidden = true; });
    yes.addEventListener('click', function () {
      yes.disabled = true;
      no.disabled = true;
      err.textContent = '';
      api('cancel', { id: v.id })
        .then(function () { loadCabinet('Запись отменена. Будем рады видеть вас в другой раз!'); })
        .catch(function (e) {
          err.textContent = e.message;
          yes.disabled = false;
          no.disabled = false;
        });
    });
  }

  function buildMove(panel, v) {
    var chosen = { date: '', time: '' };

    var field = el('div', 'field');
    var label = el('label', 'field__label', 'Новая дата');
    var inputId = 'cabMoveDate-' + v.id;
    label.setAttribute('for', inputId);
    var input = document.createElement('input');
    input.type = 'date';
    input.id = inputId;
    input.className = 'control';
    if (state.today) {
      input.min = state.today;
      input.max = addDays(state.today, state.horizonDays);
    }
    field.appendChild(label);
    field.appendChild(input);
    panel.appendChild(field);

    var slotsBox = el('div', 'slots');
    slotsBox.appendChild(el('p', 'slots__placeholder', 'Выберите дату — покажем свободное время у вашего мастера.'));
    panel.appendChild(slotsBox);

    var err = el('p', 'field-error');
    var row = el('div', 'cab-change__row');
    var go = el('button', 'btn btn--primary btn--sm', 'Перенести');
    var close = el('button', 'btn btn--ghost btn--sm', 'Закрыть');
    go.type = 'button';
    close.type = 'button';
    go.disabled = true;
    row.appendChild(go);
    row.appendChild(close);
    panel.appendChild(row);
    panel.appendChild(err);
    panel.appendChild(el('p', 'field-hint',
      'Мастер и услуги останутся прежними. После переноса администратор подтвердит новое время.'));

    var token = 0;
    function loadSlots() {
      chosen.date = input.value;
      chosen.time = '';
      go.disabled = true;
      go.textContent = 'Перенести';
      err.textContent = '';
      if (!chosen.date) return;
      var my = ++token;
      slotsBox.innerHTML = '';
      slotsBox.appendChild(el('p', 'slots__placeholder', 'Смотрим свободное время…'));
      api('slots', { id: v.id, date: chosen.date })
        .then(function (d) {
          if (my !== token) return;
          slotsBox.innerHTML = '';
          if (!d.slots.length) {
            slotsBox.appendChild(el('p', 'slots__empty', d.dayOff
              ? 'В этот день мастер не работает. Выберите другую дату.'
              : 'На этот день свободного времени нет. Выберите другую дату.'));
            return;
          }
          var grid = el('div', 'slots__grid');
          d.slots.forEach(function (t) {
            var b = el('button', 'slot-btn', t);
            b.type = 'button';
            b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', function () {
              chosen.time = t;
              Array.prototype.forEach.call(grid.querySelectorAll('.slot-btn'), function (x) {
                x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
              });
              go.disabled = false;
              go.textContent = 'Перенести на ' + formatDateLong(chosen.date) + ', ' + t;
            });
            grid.appendChild(b);
          });
          slotsBox.appendChild(grid);
        })
        .catch(function (e) {
          if (my !== token) return;
          slotsBox.innerHTML = '';
          slotsBox.appendChild(el('p', 'slots__empty', e.message));
        });
    }
    input.addEventListener('change', loadSlots);
    close.addEventListener('click', function () { panel.hidden = true; });

    go.addEventListener('click', function () {
      if (!chosen.date || !chosen.time) return;
      go.disabled = true;
      close.disabled = true;
      err.textContent = '';
      api('reschedule', { id: v.id, date: chosen.date, time: chosen.time })
        .then(function () {
          loadCabinet('Запись перенесена на ' + formatDateLong(chosen.date) + ', ' + chosen.time +
            '. Администратор подтвердит новое время.');
        })
        .catch(function (e) {
          err.textContent = e.message;
          close.disabled = false;
          // Время могли занять — обновляем список, чтобы не выбирать заново вслепую.
          if (e.code === 'slot_taken') loadSlots();
          else go.disabled = false;
        });
    });
  }

  /* ---------------------------------------------------------------------------
     Запуск
     ------------------------------------------------------------------------ */

  $('cabStartBtn').addEventListener('click', startLogin);
  $('cabRestartBtn').addEventListener('click', restart);
  $('cabLogoutBtn').addEventListener('click', function () {
    api('logout').then(function () { location.reload(); });
  });

  var header = $('siteHeader');
  window.addEventListener('scroll', function () {
    header.classList.toggle('is-stuck', window.scrollY > 8);
  }, { passive: true });

  // Если сессия уже есть — сразу показываем кабинет, минуя вход.
  loadCabinet('');
})();
