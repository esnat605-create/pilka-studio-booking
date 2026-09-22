// =============================================================================
//  GET /api/works            — список мастеров с их работами (без самих картинок)
//  GET /api/works?img=ID     — сама фотография (полный размер)
//  GET /api/works?img=ID&thumb=1 — уменьшенная копия для сетки
// =============================================================================
//  Фотографии работ загружает администратор в карточке мастера (админка) —
//  они хранятся в таблице master_works прямо в базе, уже сжатыми до разумного
//  размера. Эта функция только отдаёт их публичной странице «Работы мастеров».
//
//  Каждая фотография получает постоянный id и больше никогда не меняется
//  (удалили — просто пропадает), поэтому браузеру разрешено кэшировать её
//  надолго: повторные заходы на страницу не трогают базу ради картинок.
//
//  Если SQL-миграция ещё не выполнена и таблицы master_works нет, список
//  просто пустой — страница покажет «скоро здесь появятся работы», а не ошибку.
// =============================================================================

const { clean, corsHeaders, loadMasters, withDb } = require('./lib/core.js');

const UNDEFINED_TABLE = '42P01';

function imageResponse(event, row) {
  return {
    statusCode: 200,
    headers: Object.assign(
      {
        'Content-Type': row.mime || 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
      corsHeaders(event)
    ),
    body: Buffer.from(row.data).toString('base64'),
    isBase64Encoded: true,
  };
}

function notFound(event) {
  return {
    statusCode: 404,
    headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, corsHeaders(event)),
    body: 'Not found',
  };
}

exports.handler = withDb(async function (event, client) {
  const q = event.queryStringParameters || {};

  // ---- одна фотография ------------------------------------------------------
  const imgId = clean(q.img, 32);
  if (imgId) {
    const useThumb = q.thumb === '1';
    try {
      // Уменьшенной копии может не быть (старая загрузка) — тогда отдаём оригинал.
      const res = await client.query(
        useThumb
          ? `SELECT coalesce(thumb, data) AS data,
                    CASE WHEN thumb IS NULL THEN mime ELSE 'image/jpeg' END AS mime
               FROM master_works WHERE id = $1`
          : 'SELECT data, mime FROM master_works WHERE id = $1',
        [imgId]
      );
      if (!res.rows.length) return notFound(event);
      return imageResponse(event, res.rows[0]);
    } catch (err) {
      if (err && err.code === UNDEFINED_TABLE) return notFound(event);
      throw err;
    }
  }

  // ---- список -----------------------------------------------------------------
  // Показываем только активных мастеров (как и на главной) и только тех, у
  // кого есть хотя бы одна работа. Порядок мастеров — тот же, что на главной.
  const masters = await loadMasters(client);
  let rows = [];
  try {
    const res = await client.query(
      `SELECT id, master_id AS "masterId", coalesce(caption, '') AS caption,
              coalesce(width, 0) AS width, coalesce(height, 0) AS height
         FROM master_works
        ORDER BY sort_order, created_at DESC`
    );
    rows = res.rows;
  } catch (err) {
    if (!(err && err.code === UNDEFINED_TABLE)) throw err;
  }

  const byMaster = {};
  rows.forEach((r) => {
    (byMaster[r.masterId] = byMaster[r.masterId] || []).push({
      id: r.id,
      caption: r.caption,
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
    });
  });

  return {
    masters: masters
      .filter((m) => (byMaster[m.id] || []).length)
      .map((m) => ({
        id: m.id,
        name: m.name,
        spec: m.spec,
        photoUrl: m.photoUrl,
        works: byMaster[m.id],
      })),
  };
});
