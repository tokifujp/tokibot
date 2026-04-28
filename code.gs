const props = PropertiesService.getScriptProperties();
const WORKSPACE_DOMAIN = props.getProperty('WORKSPACE_DOMAIN');
const SLACK_TOKEN = props.getProperty('SLACK_TOKEN');
const LIST_ID = props.getProperty('LIST_ID');
const CHANNEL_ID = props.getProperty('CHANNEL_ID');
const USER_ID = props.getProperty('USER_ID');

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.type === 'url_verification') {
      return ContentService.createTextOutput(payload.challenge);
    }

    const eventId = payload.event_id;
    const cache = CacheService.getScriptCache();
    if (cache.get(eventId)) return ContentService.createTextOutput('ok');
    cache.put(eventId, '1', 60);

    const event = payload.event;
    if (!event || event.type !== 'message' || event.subtype) {
      return ContentService.createTextOutput('ok');
    }
    if (event.user !== USER_ID) return ContentService.createTextOutput('ok');

    const text = event.text?.trim();
    const userId = event.user;

    // 非同期的に処理（Slackへの200応答を先に返すため）
    handleCommand(text, userId);

  } catch (err) {
    console.log('doPost error: ' + err.message + '\n' + err.stack);
    // Slackには必ず200を返す（リトライさせない）
  }

  return ContentService.createTextOutput('ok');
}

function clearCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('list_schema');
  cache.remove('eod_' + new Date().toDateString());
}

function getListSchema() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('list_schema');
  if (cached) return JSON.parse(cached);
  
  // まず1件取得してIDを得る
  const listRes = UrlFetchApp.fetch('https://slack.com/api/slackLists.items.list', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ list_id: LIST_ID, channel_id: CHANNEL_ID, limit: 1 })
  });
  const listData = JSON.parse(listRes.getContentText());
  const recordId = listData.items?.[0]?.id;
  if (!recordId) {
    if (!recordId) throw new Error('リストにアイテムがありません');
    return null;
  }
  
  // スキーマ取得
  const res = UrlFetchApp.fetch('https://slack.com/api/slackLists.items.info', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ list_id: LIST_ID, id: recordId })
  });
  const data = JSON.parse(res.getContentText());
  const schema = data.list?.list_metadata?.schema;

  const nameCol = schema.find(c => c.key === 'name')?.id;
  const statusCol = schema.find(c => c.type === 'select')?.id;
  const statusOptions = schema.find(c => c.id === statusCol)?.options?.choices
    .reduce((acc, c) => ({ ...acc, [c.label]: c.value }), {});
  
  const result = { nameCol, statusCol, statusOptions };
  cache.put('list_schema', JSON.stringify(result), 3600); // 1時間キャッシュ
  return result;
}

function handleCommand(text, userId) {
  // ユーザーフィルタ
  const USER_ID = props.getProperty('USER_ID');
  if (userId !== USER_ID) return;

  if (text === 'ls') { showList(); return; }
  if (text === ':q' || text === ':wq' || text === 'exit' || text === 'quit') {
    postEndOfDay(); return;
  }
  if (text === 'help') { showHelp(); return; }

  const addMatch = text.match(/^add\s+(.+)$/);
  if (addMatch) { addTask(addMatch[1].trim()); return; }

  const startMatch = text.match(/^start\s+(\d+|.+)$/);
  if (startMatch) {
    const arg = startMatch[1].trim();
    isNaN(arg) ? changeStatusByName(arg, 'start') : changeStatusByNumber(parseInt(arg), 'start');
    return;
  }

  const endMatch = text.match(/^end\s+(\d+|.+)$/);
  if (endMatch) {
    const arg = endMatch[1].trim();
    isNaN(arg) ? changeStatusByName(arg, 'done') : changeStatusByNumber(parseInt(arg), 'done');
    return;
  }

  const waitMatch = text.match(/^wait\s+(\d+|.+)$/);
  if (waitMatch) {
    const arg = waitMatch[1].trim();
    isNaN(arg) ? changeStatusByName(arg, 'wait') : changeStatusByNumber(parseInt(arg), 'wait');
    return;
  }

  const rmMatch = text.match(/^rm\s+(\d+|.+)$/);
  if (rmMatch) {
    const arg = rmMatch[1].trim();
    isNaN(arg) ? deleteTaskByName(arg) : deleteTaskByNumber(parseInt(arg));
    return;
  }

  const lsMatch = text.match(/^ls\s+(today|yesterday|last\s+week|today)$/);
  if (lsMatch) {
    showFilteredList(lsMatch[1].trim());
    return;
  }

  // cacheクリア
  if (text === 'reset') { clearCache(); postMessage('🔄 キャッシュをクリアしました'); return; }
}

function getItems() {
  const res = UrlFetchApp.fetch('https://slack.com/api/slackLists.items.list', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ list_id: LIST_ID, channel_id: CHANNEL_ID })
  });
  const data = JSON.parse(res.getContentText());
  return data.items || [];
}

function getTaskName(item) {
  const { nameCol: NAME_COL } = getListSchema();
  const field = item.fields.find(f => f.column_id === NAME_COL);
  return (field?.text || '').replace(/\n/g, ' ');
}

function getStatus(item) {
  const { statusCol: STATUS_COL, statusOptions: STATUS_IDS } = getListSchema();
  const field = item.fields.find(f => f.column_id === STATUS_COL);
  const optId = field?.select?.[0];
  // STATUS_IDSは { todo: 'OptXXX', wip: 'OptYYY', ... } なので逆引き
  return Object.keys(STATUS_IDS).find(k => STATUS_IDS[k] === optId) || 'todo';
}

function addTask(name) {
  const { nameCol: NAME_COL, statusCol: STATUS_COL, statusOptions: STATUS_IDS } = getListSchema();
  const res = UrlFetchApp.fetch('https://slack.com/api/slackLists.items.create', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({
      list_id: LIST_ID,
      channel_id: CHANNEL_ID,
      initial_fields: [
        {
          column_id: NAME_COL,
          rich_text: [{
            type: 'rich_text',
            elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: name }] }]
          }]
        },
        { column_id: STATUS_COL, select: [STATUS_IDS.todo] }
      ]
    })
  });
  const data = JSON.parse(res.getContentText());
  const itemId = data.item?.id;
  postMessage(`✅ 追加しました: *<${getItemUrl(itemId)}|${name}>* (todo)`);
}

function changeStatusByNumber(num, statusInput) {
  const items = getItems().filter(i => getStatus(i) !== 'done');
  const item = items[num - 1];
  if (!item) { postMessage(`❌ ${num}番のタスクが見つかりません`); return; }
  changeStatus(item, statusInput);
}

function changeStatusByName(name, statusInput) {
  const items = getItems();
  const item = items.find(i => getTaskName(i).includes(name));
  if (!item) { postMessage(`❌ "${name}"が見つかりません`); return; }
  changeStatus(item, statusInput);
}

function changeStatus(item, statusInput) {
  const { nameCol: NAME_COL, statusCol: STATUS_COL, statusOptions: STATUS_IDS } = getListSchema();
  const statusMap = { '開始': 'wip', 'start': 'wip', '完了': 'done', 'done': 'done', '保留': 'pending', 'wait': 'pending' };
  const newStatus = statusMap[statusInput];
  const name = getTaskName(item);
  
  UrlFetchApp.fetch('https://slack.com/api/slackLists.items.update', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({
      list_id: LIST_ID,
      cells: [{ column_id: STATUS_COL, select: [STATUS_IDS[newStatus]], row_id: item.id }]
    })
  });
  postMessage(`✅ *<${getItemUrl(item.id)}|${name}>* → ${newStatus}`);
}

function showList() {
  const items = getItems();
  const active = items.filter(i => getStatus(i) !== 'done');
  
  if (active.length === 0) {
    postMessage('📋 タスクはありません');
    return;
  }
  
  let msg = '*📋 タスク一覧*\n\n';
  active.forEach((item, idx) => {
    const status = getStatus(item);
    const emoji = { backlog: '⬜', wip: '🔵', pending: '🟡' }[status] || '⬜';
    msg += `${idx + 1}. ${emoji} [${status}] <${getItemUrl(item.id)}|${getTaskName(item)}>\n`;
  });
  
  postMessage(msg);
}

function deleteTaskByNumber(num) {
  const items = getItems();
  const item = items[num - 1];
  if (!item) { postMessage(`❌ ${num}番のタスクが見つかりません`); return; }
  
  UrlFetchApp.fetch('https://slack.com/api/slackLists.items.delete', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ list_id: LIST_ID, id: item.id })
  });
  postMessage(`🗑️ 削除しました: *${getTaskName(item)}*`);
}

function deleteTaskByName(name) {
  const items = getItems();
  const item = items.find(i => getTaskName(i).includes(name));
  if (!item) { postMessage(`❌ "${name}"が見つかりません`); return; }
  UrlFetchApp.fetch('https://slack.com/api/slackLists.items.delete', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
    payload: JSON.stringify({ list_id: LIST_ID, id: item.id })
  });
  postMessage(`🗑️ 削除しました: *${getTaskName(item)}*`);
}

function showHelp() {
  const msg = `*📖 tokibot コマンド一覧*

\`ls\` — タスク一覧を表示
\`ls today\` | \`ls yesterday\` | \`ls last week\` — 完了タスクを期間で表示
\`add <タスク名>\` — タスクを追加 (todo)
\`start <番号|タスク名>\` — WIPに変更
\`end <番号|タスク名>\` — 完了に変更
\`wait <番号|タスク名>\` — 保留に変更
\`rm <番号|タスク名>\` — タスクを削除
\`reset\` — Cacheを削除
\`:q\` | \`:wq\` | \`exit\` | \`quit\` — 本日の終業報告を投稿`;
  postMessage(msg);
}

function postEndOfDay() {
  const cache = CacheService.getScriptCache();
  const today = new Date().toDateString();
  const key = 'eod_' + today;
  if (cache.get(key)) return; // 今日すでに実行済み
  cache.put(key, '1', 3600 * 12);

  const items = getItems();
  
  const done = items.filter(i => {
    const status = getStatus(i);
    const updated = new Date(parseInt(i.updated_timestamp) * 1000).toDateString();
    return status === 'done' && updated === today;
  });
  
  const remaining = items.filter(i => getStatus(i) !== 'done');
  
  let msg = '*📋 本日の終業報告*\n\n';
  msg += `*✅ 完了 (${done.length}件)*\n`;
  done.forEach(i => msg += `• <${getItemUrl(i.id)}|${getTaskName(i)}>\n`);
  msg += `\n*📌 残タスク (${remaining.length}件)*\n`;
  remaining.forEach((i, idx) => msg += `${idx + 1}. [${getStatus(i)}] <${getItemUrl(i.id)}|${getTaskName(i)}>\n`);
  
  postMessage(msg);
}

function showFilteredList(period) {
  const now = new Date();
  let start, end;
  
  if (period === 'today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    end = now;
  } else if (period === 'yesterday') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'last week') {
    const day = now.getDay();
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day - 6);
    end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
  }
  
  const items = getItems().filter(i => {
    const updated = new Date(parseInt(i.updated_timestamp) * 1000);
    return getStatus(i) === 'done' && updated >= start && updated <= end;
  });
  
  if (items.length === 0) {
    postMessage(`📋 ${period}に完了したタスクはありません`);
    return;
  }
  
  let msg = `*📋 ${period}に完了したタスク*\n\n`;
  items.forEach((item, idx) => {
    msg += `${idx + 1}. ✅ <${getItemUrl(item.id)}|${getTaskName(item)}>\n`;
  });
  
  postMessage(msg);
}

function autoClean() {
  const items = getItems();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  
  const targets = items.filter(i => {
    if (getStatus(i) !== 'done') return false;
    const updated = new Date(parseInt(i.updated_timestamp) * 1000);
    return updated < oneWeekAgo;
  });

  if (targets.length === 0) {
    postMessage('🧹 削除対象のタスクはありませんでした');
    return;
  }

  targets.forEach(item => {
    UrlFetchApp.fetch('https://slack.com/api/slackLists.items.delete', {
      method: 'post',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
      payload: JSON.stringify({ list_id: LIST_ID, id: item.id })
    });
  });

  postMessage(`🧹 ${targets.length}件の完了タスク（1週間以上前）を削除しました`);
}

function getItemUrl(itemId) {
  return `https://${WORKSPACE_DOMAIN}.slack.com/lists/${LIST_ID}?record_id=${itemId}`;
}

function postMessage(text) {
  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    payload: JSON.stringify({ channel: CHANNEL_ID, text: text })
  });
}
