/**
 * Чайна полиця — міст між вебзастосунком (GitHub Pages) і Notion.
 *
 * Налаштування (Project Settings → Script Properties):
 *   NOTION_TOKEN — секрет внутрішньої інтеграції Notion (notion.so/profile/integrations)
 *   APP_KEY      — будь-який довгий пароль; той самий вводиться у застосунку на iPad
 *
 * Розгортання: Deploy → New deployment → Web app;
 *   Execute as: Me;  Who has access: Anyone.
 * Скопіюй URL, що закінчується на /exec, — його вводять у застосунку.
 *
 * Запити: POST, тіло — JSON (Content-Type text/plain, щоб браузер не робив preflight):
 *   {key, op: "load"}
 *   {key, op: "createLog", log: {teaId, title, action, date, time, verdict, note, steeps, clientKey}}
 *   {key, op: "updateTea", teaId, props: {"Оцінка": "★★★"|null, "Статус": "...", "Дата дегустації": "2026-11-12", "Враження": "..."}}
 *   {key, op: "createTea", tea: {"Назва": "...", "Категорія": "...", ... "Коли пити": ["вдень"]}}
 */

var NOTION_VERSION = '2026-03-11';
var DS = {
  teas: 'aad539f2-4b6a-4863-a054-3686413414fb',     // 🍵 Чайний журнал
  log: '9aa43c38-c244-464f-8e02-6d81973b0c5a',      // Чаювання
  settings: '30f0777f-bfff-4c42-bb7d-83144e7477fc'  // Налаштування застосунку
};
// Які властивості чаю застосунок може змінювати і якого вони типу.
var TEA_WRITABLE = {
  'Оцінка': 'select',
  'Статус': 'select',
  'Дата дегустації': 'date',
  'Враження': 'rich_text'
};

// Поля нового чаю, які застосунок може заповнити, і їхні типи в Notion.
var TEA_CREATABLE = {
  'Назва': 'title',
  'Категорія': 'select', 'Формат': 'select', 'Регіон': 'select', 'Статус': 'select',
  'Бренд / виробник': 'rich_text', 'Очікуваний профіль': 'rich_text',
  'Скільки класти': 'rich_text', 'Пропорція': 'rich_text', 'Вода': 'rich_text', 'Промивка': 'rich_text',
  'Проливи': 'rich_text', 'Кількість проливів': 'rich_text', 'Порада': 'rich_text', 'Заварювання': 'rich_text',
  'Коли пити': 'multi_select',
  'Посилання': 'url'
};

function doGet() {
  return json_({ ok: true, app: 'Чайна полиця', hint: 'POST only' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var props = PropertiesService.getScriptProperties();
    var appKey = props.getProperty('APP_KEY');
    if (!appKey || body.key !== appKey) return json_({ ok: false, error: 'bad_key' });
    if (!props.getProperty('NOTION_TOKEN')) return json_({ ok: false, error: 'no_token' });

    switch (body.op) {
      case 'load':
        return json_({
          ok: true,
          teas: queryAll_(DS.teas, [{ timestamp: 'created_time', direction: 'ascending' }]).map(flatten_),
          log: queryAll_(DS.log, [{ property: 'Дата', direction: 'descending' }], 300).map(flatten_),
          settings: queryAll_(DS.settings).map(flatten_)
        });
      case 'createLog':
        return json_({ ok: true, id: createLog_(body.log || {}) });
      case 'createTea':
        return json_({ ok: true, tea: flatten_(createTea_(body.tea || {})) });
      case 'updateTea':
        updateTea_(body.teaId, body.props || {});
        return json_({ ok: true });
      default:
        return json_({ ok: false, error: 'unknown_op' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ------------------------------------------------------------------ Notion

function notion_(method, path, payload) {
  var res = UrlFetchApp.fetch('https://api.notion.com/v1/' + path, {
    method: method,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + PropertiesService.getScriptProperties().getProperty('NOTION_TOKEN'),
      'Notion-Version': NOTION_VERSION
    },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var data = {};
  try { data = JSON.parse(res.getContentText()); } catch (e) {}
  if (code === 401) throw new Error('notion_unauthorized');
  if (code === 404) throw new Error('notion_not_shared');
  if (code >= 300) throw new Error('notion_' + code + ': ' + (data.message || ''));
  return data;
}

function queryAll_(dataSourceId, sorts, cap) {
  var out = [], cursor = null;
  do {
    var body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (sorts) body.sorts = sorts;
    var res = notion_('post', 'data_sources/' + dataSourceId + '/query', body);
    out = out.concat(res.results || []);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor && (!cap || out.length < cap));
  return out;
}

/** Сторінка Notion → плоский об'єкт {назва властивості: текст | масив | число}. */
function flatten_(page) {
  var o = { id: String(page.id).replace(/-/g, ''), url: page.url, created: page.created_time, edited: page.last_edited_time };
  var props = page.properties || {};
  Object.keys(props).forEach(function (name) {
    var p = props[name], v = null;
    switch (p.type) {
      case 'title': v = plain_(p.title); break;
      case 'rich_text': v = plain_(p.rich_text); break;
      case 'select': v = p.select ? p.select.name : ''; break;
      case 'status': v = p.status ? p.status.name : ''; break;
      case 'multi_select': v = (p.multi_select || []).map(function (x) { return x.name; }); break;
      case 'number': v = p.number; break;
      case 'url': v = p.url || ''; break;
      case 'date': v = p.date ? p.date.start : ''; break;
      case 'relation': v = (p.relation || []).map(function (x) { return String(x.id).replace(/-/g, ''); }); break;
      case 'files':
        var f = (p.files || [])[0];
        v = f ? ((f.file && f.file.url) || (f.external && f.external.url) || '') : '';
        break;
      default: return;
    }
    o[name] = v;
  });
  return o;
}

function plain_(rich) {
  return (rich || []).map(function (r) { return r.plain_text || ''; }).join('');
}

function text_(s) {
  s = String(s || '');
  var parts = [];
  for (var i = 0; i < s.length; i += 2000) parts.push({ text: { content: s.slice(i, i + 2000) } });
  return parts;
}

/** Новий рядок у «Чаюванні». Повторна відправка з тим самим clientKey не створює дубля. */
function createLog_(l) {
  if (!l.teaId || !l.action || !l.date) throw new Error('bad_log');
  if (l.clientKey) {
    var found = notion_('post', 'data_sources/' + DS.log + '/query', {
      page_size: 1,
      filter: { property: 'Ключ запису', rich_text: { equals: String(l.clientKey) } }
    });
    if (found.results && found.results.length) return String(found.results[0].id).replace(/-/g, '');
  }
  var properties = {
    'Запис': { title: text_(l.title || l.action) },
    'Чай': { relation: [{ id: l.teaId }] },
    'Дата': { date: { start: l.date } },
    'Час': { rich_text: text_(l.time) },
    'Дія': { select: { name: l.action } },
    'Звідки': { select: { name: 'застосунок' } },
    'Ключ запису': { rich_text: text_(l.clientKey) }
  };
  if (l.verdict) properties['Оцінка'] = { select: { name: l.verdict } };
  if (l.note) properties['Нотатка'] = { rich_text: text_(l.note) };
  if (l.steeps !== undefined && l.steeps !== null && l.steeps !== '') properties['Проливи'] = { number: Number(l.steeps) };
  var page = notion_('post', 'pages', { parent: { type: 'data_source_id', data_source_id: DS.log }, properties: properties });
  return String(page.id).replace(/-/g, '');
}

function updateTea_(teaId, props) {
  if (!teaId) throw new Error('bad_tea');
  var properties = {};
  Object.keys(props).forEach(function (name) {
    var type = TEA_WRITABLE[name], v = props[name];
    if (!type) return;
    if (type === 'select') properties[name] = { select: v ? { name: String(v) } : null };
    if (type === 'date') properties[name] = { date: v ? { start: String(v) } : null };
    if (type === 'rich_text') properties[name] = { rich_text: text_(v) };
  });
  if (Object.keys(properties).length) notion_('patch', 'pages/' + teaId, { properties: properties });
}

/** Нова сторінка в «Чайному журналі». */
function createTea_(tea) {
  var name = String(tea['Назва'] || '').trim();
  if (!name) throw new Error('bad_tea_name');
  var properties = {};
  Object.keys(TEA_CREATABLE).forEach(function (field) {
    var type = TEA_CREATABLE[field], v = tea[field];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return;
    if (type === 'title') properties[field] = { title: text_(v) };
    if (type === 'select') properties[field] = { select: { name: String(v).replace(/,/g, ' ').trim() } };
    if (type === 'rich_text') properties[field] = { rich_text: text_(v) };
    if (type === 'multi_select') properties[field] = { multi_select: [].concat(v).map(function (x) { return { name: String(x).replace(/,/g, ' ').trim() }; }) };
    if (type === 'url') properties[field] = { url: String(v).trim() };
  });
  if (!properties['Статус']) properties['Статус'] = { select: { name: 'В колекції' } };
  return notion_('post', 'pages', { parent: { type: 'data_source_id', data_source_id: DS.teas }, properties: properties, icon: { type: 'emoji', emoji: '🍵' } });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Запусти з редактора (▶), щоб перевірити токен і доступ до баз. */
function testConnection() {
  var teas = queryAll_(DS.teas);
  Logger.log('Чаїв у «Чайному журналі»: ' + teas.length);
}
