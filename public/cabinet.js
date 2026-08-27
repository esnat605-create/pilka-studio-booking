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

  var state = { nonce: '', timer: null, tries: 0 };

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

  function loadCabinet() {
    clearTimeout(state.timer);
    show('loading');

    api('me')
      .then(function (d) {
        if (!d.authorized) { show('login'); return; }
        renderCabinet(d);
        show('home');
      })
      .catch(function (e) {
        show('login');
        showError(e.message);
      });
  }

  function renderCabinet(d) {
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

    return card;
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
  loadCabinet();
})();
