/* =============================================================================
   Pilka Studio — страница «Работы мастеров»
   -----------------------------------------------------------------------------
   Список приходит с /api/works: мастера и id их фотографий. Сами фото грузятся
   отдельными запросами (/api/works?img=ID) — лениво, по мере прокрутки, а в
   сетке сначала уменьшенные копии. Крупно фото открывается по нажатию.
   ========================================================================== */

(function () {
  'use strict';

  var state = { masters: [], filter: '', list: [], index: -1, lastFocus: null };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function imgUrl(id, thumb) {
    return '/api/works?img=' + encodeURIComponent(id) + (thumb ? '&thumb=1' : '');
  }

  function load() {
    fetch('/api/works', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || d.ok === false) throw new Error((d && d.error) || 'Не удалось загрузить работы');
        state.masters = d.masters || [];
        // Ссылка вида /works?master=ID сразу открывает работы нужного мастера.
        var want = new URLSearchParams(location.search).get('master') || '';
        if (want && state.masters.some(function (m) { return m.id === want; })) state.filter = want;
        renderFilter();
        render();
      })
      .catch(function (e) {
        var box = $('worksBox');
        box.setAttribute('aria-busy', 'false');
        box.innerHTML = '';
        box.appendChild(el('p', 'slots__empty', e.message || 'Не удалось загрузить работы. Обновите страницу.'));
      });
  }

  function renderFilter() {
    var box = $('worksFilter');
    box.innerHTML = '';
    // Фильтр нужен, только когда мастеров больше одного.
    if (state.masters.length < 2) { box.hidden = true; return; }
    box.hidden = false;

    function chip(id, label) {
      var b = el('button', 'works-chip', label);
      b.type = 'button';
      b.setAttribute('aria-pressed', state.filter === id ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.filter = id;
        Array.prototype.forEach.call(box.querySelectorAll('.works-chip'), function (x) {
          x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
        });
        var url = id ? '?master=' + encodeURIComponent(id) : location.pathname;
        if (history.replaceState) history.replaceState(null, '', url);
        render();
      });
      return b;
    }

    box.appendChild(chip('', 'Все мастера'));
    state.masters.forEach(function (m) { box.appendChild(chip(m.id, m.name)); });
  }

  function render() {
    var box = $('worksBox');
    box.setAttribute('aria-busy', 'false');
    box.innerHTML = '';
    state.list = [];

    var shown = state.filter
      ? state.masters.filter(function (m) { return m.id === state.filter; })
      : state.masters;

    if (!shown.length) {
      box.appendChild(el('p', 'slots__empty',
        'Скоро здесь появятся фотографии работ наших мастеров. А пока посмотреть примеры можно в нашем Instagram.'));
      return;
    }

    shown.forEach(function (m) {
      var section = el('section', 'works-master');
      var head = el('div', 'works-master__head');
      head.appendChild(el('h2', 'works-master__name', m.name));
      if (m.spec) head.appendChild(el('span', 'works-master__spec', m.spec));
      section.appendChild(head);

      var grid = el('div', 'works-grid');
      m.works.forEach(function (w) {
        var idx = state.list.length;
        state.list.push({ id: w.id, caption: w.caption, master: m.name });

        var btn = el('button', 'works-item');
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Открыть фото' + (w.caption ? ': ' + w.caption : '') + ' — ' + m.name);
        var img = document.createElement('img');
        img.src = imgUrl(w.id, true);
        img.alt = w.caption || ('Работа мастера ' + m.name);
        img.loading = 'lazy';
        img.decoding = 'async';
        img.width = 400;
        img.height = 400;
        btn.appendChild(img);
        if (w.caption) btn.appendChild(el('span', 'works-item__cap', w.caption));
        btn.addEventListener('click', function () { openLightbox(idx, btn); });
        grid.appendChild(btn);
      });
      section.appendChild(grid);
      box.appendChild(section);
    });
  }

  /* ---------------------------------------------------------------------------
     Просмотр крупно
     ------------------------------------------------------------------------ */

  function showAt(i) {
    var n = state.list.length;
    if (!n) return;
    state.index = (i + n) % n;
    var item = state.list[state.index];
    var img = $('lbImg');
    img.src = imgUrl(item.id, false);
    img.alt = item.caption || ('Работа мастера ' + item.master);
    $('lbCap').textContent = (item.caption ? item.caption + ' · ' : '') + item.master;
    $('lbPrev').hidden = n < 2;
    $('lbNext').hidden = n < 2;
  }

  function openLightbox(i, from) {
    state.lastFocus = from || null;
    showAt(i);
    $('lightbox').hidden = false;
    document.body.classList.add('no-scroll');
    $('lbClose').focus();
  }

  function closeLightbox() {
    $('lightbox').hidden = true;
    $('lbImg').removeAttribute('src');
    document.body.classList.remove('no-scroll');
    if (state.lastFocus) state.lastFocus.focus();
  }

  $('lbClose').addEventListener('click', closeLightbox);
  $('lbPrev').addEventListener('click', function () { showAt(state.index - 1); });
  $('lbNext').addEventListener('click', function () { showAt(state.index + 1); });
  // Нажатие на тёмный фон вокруг фото закрывает просмотр.
  $('lightbox').addEventListener('click', function (e) { if (e.target === this) closeLightbox(); });
  document.addEventListener('keydown', function (e) {
    if ($('lightbox').hidden) return;
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') showAt(state.index - 1);
    else if (e.key === 'ArrowRight') showAt(state.index + 1);
  });

  // Смахивание влево-вправо на телефоне листает фото.
  var touchX = null;
  $('lightbox').addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
  $('lightbox').addEventListener('touchend', function (e) {
    if (touchX === null) return;
    var dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(dx) > 50) showAt(state.index + (dx < 0 ? 1 : -1));
  });

  var header = $('siteHeader');
  window.addEventListener('scroll', function () {
    header.classList.toggle('is-stuck', window.scrollY > 8);
  }, { passive: true });

  load();
})();
