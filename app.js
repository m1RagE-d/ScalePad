const defaultPresets = window.scalePadPresets || [];

const presetStorageKey = 'scalepad_presets_v3';
const voiceStorageKey = 'scalepad_voice_v1';
let presets = loadPresets();

let presetIndex = 0;
let questionIndex = 0;
let activeQuestions = [];
let ageBand = '';
let epilepsy = '';
let voiceEnabled = localStorage.getItem(voiceStorageKey) !== 'off';
let isSpeaking = false;
let answers = [];
let answerByQuestion = {};
let patient = '';
let patientAge = '';
let editingIndex = null;
let directoryHandle = null;
let advanceTimer = null;
let pendingAnswer = null;
let pendingRevision = 0;
let logDb = null;
let sessionId = null;
let sessionStartedAt = 0;
let sessionSequence = 0;
let sessionEventCache = [];
let currentQuestionTelemetry = null;
let storageReady = false;
let storageFailure = '';
let storageAlertShown = false;
let opfsLogDirectory = null;
let opfsWriteQueue = Promise.resolve();
let directoryWriteQueue = Promise.resolve();
let directoryLogFileName = '';
let isStarting = false;
const eventWritePromises = new Set();
const logDbName = 'scalepad_live_logs_v1';
const logDbVersion = 1;
const $ = (id) => document.getElementById(id);

function safeFilePart(value) {
  return String(value || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80) || 'session';
}

function openLogDb() {
  if (!window.indexedDB) return Promise.reject(new Error('当前浏览器不支持 IndexedDB'));
  if (logDb) return Promise.resolve(logDb);
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(logDbName, logDbVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('events')) {
        const events = database.createObjectStore('events', { keyPath: 'id' });
        events.createIndex('sessionId', 'sessionId', { unique: false });
      }
      if (!database.objectStoreNames.contains('probes')) database.createObjectStore('probes', { keyPath: 'id' });
    };
    request.onsuccess = () => { logDb = request.result; resolve(logDb); };
    request.onerror = () => reject(request.error || new Error('无法打开本机记录数据库'));
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    const transaction = logDb.transaction(storeName, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error(`无法写入 ${storeName}`));
    transaction.objectStore(storeName).put(value);
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = logDb.transaction(storeName, 'readonly');
    const request = transaction.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error(`无法读取 ${storeName}`));
  });
}

function idbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const transaction = logDb.transaction(storeName, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error(`无法清理 ${storeName}`));
    transaction.objectStore(storeName).delete(key);
  });
}

function idbGetSessionEvents(id) {
  return new Promise((resolve, reject) => {
    const transaction = logDb.transaction('events', 'readonly');
    const request = transaction.objectStore('events').index('sessionId').getAll(IDBKeyRange.only(id));
    request.onsuccess = () => resolve((request.result || []).sort((a, b) => a.sequence - b.sequence));
    request.onerror = () => reject(request.error || new Error('无法读取答题记录'));
  });
}

function setStorageStatus(message, state = '') {
  const status = $('storageStatus');
  if (!status) return;
  status.textContent = message;
  status.className = `storage-status ${state}`.trim();
}

function reportStorageFailure(error, source = '本机记录') {
  storageFailure = `${source}失败：${error?.message || error}`;
  storageReady = false;
  setStorageStatus(`${storageFailure}，答题已暂停，请先处理保存问题。`, 'error');
  if (!storageAlertShown) {
    storageAlertShown = true;
    window.alert(`答题记录${source}失败。当前答案没有被安全保存，系统已暂停继续答题。\n\n${error?.message || error}`);
  }
}

async function verifyDirectoryHandle(handle) {
  if (!handle) return false;
  if (handle.queryPermission) {
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted' && handle.requestPermission) permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') throw new Error('没有该文件夹的写入权限');
  }
  const probeName = `.scalepad-write-test-${Date.now()}.tmp`;
  const target = await handle.getFileHandle(probeName, { create: true });
  const writable = await target.createWritable();
  await writable.write('ScalePad write test');
  await writable.close();
  const content = await (await target.getFile()).text();
  if (content !== 'ScalePad write test') throw new Error('文件夹写入校验内容不一致');
  if (handle.removeEntry) await handle.removeEntry(probeName);
  return true;
}

async function prepareOpfs() {
  opfsLogDirectory = null;
  if (!navigator.storage?.getDirectory) return false;
  const root = await navigator.storage.getDirectory();
  opfsLogDirectory = await root.getDirectoryHandle('ScalePad-logs', { create: true });
  return true;
}

async function prepareStorage() {
  storageAlertShown = false;
  try {
    await openLogDb();
    const probe = { id: `startup-${Date.now()}`, checkedAt: new Date().toISOString() };
    await idbPut('probes', probe);
    const savedProbe = await idbGet('probes', probe.id);
    await idbDelete('probes', probe.id);
    if (!savedProbe) throw new Error('本机记录读回校验失败');
    let opfsReady = false;
    try { opfsReady = await prepareOpfs(); } catch (error) { console.warn('OPFS 不可用，将使用 IndexedDB。', error); }
    if (directoryHandle) await verifyDirectoryHandle(directoryHandle);
    if (navigator.storage?.persist) {
      try { await navigator.storage.persist(); } catch (error) { console.warn('无法请求持久化存储权限。', error); }
    }
    storageReady = true;
    storageFailure = '';
    const destinations = [`IndexedDB 本机实时记录${opfsReady ? '、OPFS 副本' : ''}`];
    if (directoryHandle) destinations.push(`自定义文件夹：${directoryHandle.name}`);
    setStorageStatus(`存储校验通过：${destinations.join('；')}`, 'ok');
    return true;
  } catch (error) {
    reportStorageFailure(error, '存储校验');
    return false;
  }
}

async function writeDirectoryLine(line) {
  if (!directoryHandle || !directoryLogFileName) return;
  const target = await directoryHandle.getFileHandle(directoryLogFileName, { create: true });
  const existing = await (await target.getFile()).text();
  const writable = await target.createWritable();
  await writable.write(existing + line);
  await writable.close();
}

async function writeOpfsEvent(record) {
  if (!opfsLogDirectory) return;
  const name = `${sessionId}-${String(record.sequence).padStart(6, '0')}.json`;
  const target = await opfsLogDirectory.getFileHandle(name, { create: true });
  const writable = await target.createWritable();
  await writable.write(JSON.stringify(record, null, 2));
  await writable.close();
}

async function persistEvent(event) {
  if (!storageReady || !sessionId) return false;
  const record = {
    id: `${sessionId}:${String(sessionSequence).padStart(8, '0')}`,
    sessionId,
    sequence: sessionSequence,
    recordedAt: new Date().toISOString(),
    ...event
  };
  sessionSequence += 1;
  try {
    await idbPut('events', record);
    sessionEventCache.push(record);
  } catch (error) {
    reportStorageFailure(error, '本机记录');
    return false;
  }
  opfsWriteQueue = opfsWriteQueue.then(() => writeOpfsEvent(record)).catch((error) => {
    console.warn('OPFS 副本写入失败。', error);
    setStorageStatus('本机 IndexedDB 仍可用，但 OPFS 副本写入失败。', 'error');
  });
  if (directoryHandle) {
    directoryWriteQueue = directoryWriteQueue.then(() => writeDirectoryLine(`${JSON.stringify(record)}\n`)).catch((error) => {
      directoryHandle = null;
      setStorageStatus(`自定义文件夹写入失败；本机记录仍已保存。${error?.message || error}`, 'error');
      window.alert(`自定义文件夹无法继续写入。当前题目仍已保存到本机记录，但请检查文件夹权限。\n\n${error?.message || error}`);
    });
  }
  return true;
}

function writeEvent(event) {
  const promise = persistEvent(event);
  eventWritePromises.add(promise);
  promise.then(() => eventWritePromises.delete(promise), () => eventWritePromises.delete(promise));
  return promise;
}

function questionFields(question, index = questionIndex) {
  return {
    questionIndex: index,
    section: question.section || '',
    question: question.text || '',
    display: question.display ?? question.text ?? ''
  };
}

/* ---------- 评分 ---------- */

function normalizeAnswer(value) {
  return String(value ?? '').toLowerCase().replace(/[\s\/、，,。．.·:：;；!！?？"'“”‘’()（）\-—_]/g, '');
}

function isCorrect(question, answer) {
  const expected = question.correct;
  if (expected === undefined || expected === null || expected === '') return false;
  const given = normalizeAnswer(answer);
  if (!given) return false;
  return [String(expected), ...String(expected).split('/')].some((candidate) => normalizeAnswer(candidate) === given);
}

function scaleScore(question, answer) {
  const position = (question.options || []).indexOf(answer);
  if (position < 0 || !Array.isArray(question.values)) return 0;
  return question.values[position] ?? 0;
}

function hasAnswer(record) {
  return Boolean(record) && String(record.answer ?? '').trim() !== '';
}

/* 按分区汇总：答对 / 已答（总题数） */
function sectionStats() {
  const order = [];
  const groups = new Map();
  activeQuestions.forEach((question, index) => {
    const name = question.section || '未分区';
    if (!groups.has(name)) {
      groups.set(name, { name, scoring: question.scoring || 'auto', total: 0, answered: 0, correct: 0, score: 0, maxScore: 0 });
      order.push(name);
    }
    const group = groups.get(name);
    group.total += 1;
    if (group.scoring === 'scale' && Array.isArray(question.values)) group.maxScore += Math.max(...question.values);
    const record = answerByQuestion[index];
    if (!hasAnswer(record)) return;
    group.answered += 1;
    if (group.scoring === 'scale') group.score += scaleScore(question, record.answer);
    else if (group.scoring === 'auto' && isCorrect(question, record.answer)) group.correct += 1;
  });
  return order.map((name) => groups.get(name));
}

function beginQuestionTelemetry(question) {
  currentQuestionTelemetry = {
    ...questionFields(question),
    presentedAt: new Date().toISOString(),
    presentedAtMs: Date.now(),
    firstActionAt: null,
    firstActionAtMs: null,
    reactionTimeMs: null,
    choiceClicks: 0,
    answerChanges: 0,
    inputChangeCount: 0,
    audioPlayCount: 0,
    lastAnswer: null
  };
}

function registerAction(answer, kind = 'choice') {
  if (!currentQuestionTelemetry) return;
  const now = Date.now();
  if (!currentQuestionTelemetry.firstActionAtMs) {
    currentQuestionTelemetry.firstActionAtMs = now;
    currentQuestionTelemetry.firstActionAt = new Date(now).toISOString();
    currentQuestionTelemetry.reactionTimeMs = Math.max(0, now - currentQuestionTelemetry.presentedAtMs);
  }
  if (kind === 'choice') {
    currentQuestionTelemetry.choiceClicks += 1;
    if (currentQuestionTelemetry.lastAnswer !== null && currentQuestionTelemetry.lastAnswer !== answer) currentQuestionTelemetry.answerChanges += 1;
    currentQuestionTelemetry.lastAnswer = answer;
  }
}

function telemetrySnapshot() {
  if (!currentQuestionTelemetry) return {};
  const { presentedAtMs, firstActionAtMs, lastAnswer, ...snapshot } = currentQuestionTelemetry;
  return { ...snapshot, lastAnswer };
}

function loadPresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(presetStorageKey));
    if (Array.isArray(saved) && saved.length && saved.every(isValidPreset)) {
      const savedByName = new Map(saved.map((preset) => [preset.name, preset]));
      const merged = defaultPresets.map((preset) => {
        const custom = savedByName.get(preset.name);
        savedByName.delete(preset.name);
        return custom || clonePreset(preset);
      });
      return [...merged, ...savedByName.values()];
    }
  } catch (error) {
    console.warn('无法读取本地问卷，将使用默认问卷。', error);
  }
  return defaultPresets.map(clonePreset);
}

function clonePreset(preset) {
  return {
    name: preset.name,
    questions: preset.questions.map((question) => ({
      ...question,
      options: [...(question.options || [])],
      ...(Array.isArray(question.values) ? { values: [...question.values] } : {})
    }))
  };
}

function isValidPreset(preset) {
  return preset && typeof preset.name === 'string' && Array.isArray(preset.questions) && preset.questions.every((question) => question && typeof question.text === 'string' && ((question.response === 'text') || (Array.isArray(question.options) && question.options.length >= 2)));
}

function savePresets() {
  localStorage.setItem(presetStorageKey, JSON.stringify(presets));
}

function refreshPresetSelect() {
  $('preset').innerHTML = '';
  presets.forEach((preset, index) => $('preset').add(new Option(preset.name, index)));
}

refreshPresetSelect();
updateHomeButton();
renderVoiceToggle();

$('chooseSaveFolder').onclick = chooseSaveFolder;
$('homeButton').onclick = goHome;
$('prevQuestion').onclick = () => navigateTo(questionIndex - 1);
$('nextQuestion').onclick = () => navigateTo(questionIndex + 1);
$('speakQuestion').onclick = toggleSpeech;

function renderVoiceToggle() {
  const button = $('voiceToggle');
  button.textContent = voiceEnabled ? '已开启' : '已关闭';
  button.classList.toggle('selected', voiceEnabled);
}

$('voiceToggle').onclick = () => {
  voiceEnabled = !voiceEnabled;
  localStorage.setItem(voiceStorageKey, voiceEnabled ? 'on' : 'off');
  if (!voiceEnabled) stopSpeaking();
  renderVoiceToggle();
};

async function chooseSaveFolder() {
  if (!window.showDirectoryPicker) {
    $('saveStatus').textContent = '当前浏览器不支持直接绑定文件夹；本机记录仍会逐题保存，完成后可导出到“下载”';
    return;
  }
  try {
    const selected = await window.showDirectoryPicker({ mode: 'readwrite' });
    await verifyDirectoryHandle(selected);
    directoryHandle = selected;
    directoryLogFileName = '';
    $('saveStatus').textContent = `已选择并验证：${directoryHandle.name}`;
    setStorageStatus('自定义文件夹写入校验通过。开始测试前仍会再次检查。', 'ok');
  } catch (error) {
    if (error.name !== 'AbortError') {
      directoryHandle = null;
      $('saveStatus').textContent = '文件夹选择或写入校验失败，请重试';
      setStorageStatus(error.message || '文件夹校验失败', 'error');
    }
  }
}

/* 年龄 <31 用 18–30 岁版本，其余用 31–60 岁版本；也可在开始前手动指定 */
function resolveAgeBand() {
  const choice = $('ageBand').value;
  if (choice) return choice;
  if (!patientAge) return '';
  return Number(patientAge) < 31 ? 'young' : 'older';
}

async function startSession() {
  if (isStarting) return;
  isStarting = true;
  $('start').disabled = true;
  const unlock = () => { $('start').disabled = false; isStarting = false; };
  patient = $('patient').value.trim() || '未填写';
  patientAge = $('patientAge').value.trim();
  if (patientAge && (!/^\d+$/.test(patientAge) || Number(patientAge) > 120)) {
    window.alert('年龄请输入 0 到 120 之间的整数。');
    unlock();
    return;
  }
  epilepsy = $('epilepsy').value;
  if (!epilepsy) {
    window.alert('请先完成癫痫病史确认，再开始测试。');
    unlock();
    return;
  }
  if (epilepsy === 'yes' && !window.confirm('受试者有癫痫病史。本测试包含图片与画面切换材料，是否仍要继续？')) {
    unlock();
    return;
  }
  ageBand = resolveAgeBand();
  presetIndex = Number($('preset').value);
  const questions = presets[presetIndex].questions;
  if (!ageBand && questions.some((question) => question.ageBand)) {
    window.alert('该问卷的名人题分 18–30 岁与 31–60 岁两个版本，请填写年龄或手动选择版本。');
    unlock();
    return;
  }
  activeQuestions = questions.filter((question) => !question.ageBand || question.ageBand === ageBand);
  if (!activeQuestions.length) {
    window.alert('该问卷没有可用题目。');
    unlock();
    return;
  }
  if (!(await prepareStorage())) {
    unlock();
    return;
  }
  sessionId = `${safeFilePart(patient)}-${Date.now()}`;
  sessionStartedAt = Date.now();
  sessionSequence = 0;
  sessionEventCache = [];
  directoryLogFileName = `${safeFilePart(patient)}_${sessionId}.jsonl`;
  try {
    await idbPut('sessions', {
      id: sessionId,
      patient,
      age: patientAge || null,
      preset: presets[presetIndex].name,
      ageBand,
      epilepsy,
      questionCount: activeQuestions.length,
      startedAt: new Date(sessionStartedAt).toISOString(),
      status: 'active'
    });
    if (!(await writeEvent({ type: 'session_started', patient, age: patientAge || null, preset: presets[presetIndex].name, ageBand, epilepsy, questionCount: activeQuestions.length }))) throw new Error('无法写入测试开始记录');
  } catch (error) {
    reportStorageFailure(error, '测试开始记录');
    unlock();
    return;
  }
  questionIndex = 0;
  answers = [];
  answerByQuestion = {};
  $('setup').classList.add('hidden');
  $('quiz').classList.remove('hidden');
  updateHomeButton();
  renderQuestion();
  isStarting = false;
}

$('start').onclick = () => { void startSession(); };

$('openEditor').onclick = () => {
  $('setup').classList.add('hidden');
  $('editor').classList.remove('hidden');
  updateHomeButton();
  $('presetFilter').value = '';
  renderPresetList();
};

$('backToSetup').onclick = () => {
  $('editor').classList.add('hidden');
  $('setup').classList.remove('hidden');
  updateHomeButton();
  refreshPresetSelect();
};

$('presetFilter').oninput = renderPresetList;

$('newPreset').onclick = () => {
  presets.push({ name: '新建问卷', questions: [{ text: '请输入题目', options: ['是', '否'] }] });
  editingIndex = presets.length - 1;
  savePresets();
  refreshPresetSelect();
  renderPresetList();
  renderEditorForm();
};

$('addQuestion').onclick = () => {
  if (editingIndex === null) return;
  const draft = collectEditorDraft();
  if (draft) presets[editingIndex] = draft;
  presets[editingIndex].questions.push({ text: '请输入题目', options: ['是', '否'] });
  renderEditorForm();
};

$('savePreset').onclick = () => {
  if (editingIndex === null) return;
  const draft = collectEditorDraft();
  if (!draft) return;
  presets[editingIndex] = draft;
  savePresets();
  refreshPresetSelect();
  renderPresetList();
  renderEditorForm();
};

function collectEditorDraft() {
  if (editingIndex === null) return null;
  const source = presets[editingIndex].questions;
  const questions = [...$('questionEditor').querySelectorAll('.question-edit')].map((row) => {
    const base = source[Number(row.dataset.index)] || {};
    const text = row.querySelector('.question-text').value.trim() || '未填写题目';
    return {
      ...base,
      response: base.response || 'choice',
      text,
      /* 题干改了就同步屏幕文字与朗读文字，除非它们本来就是另外写的 */
      ...(base.display === base.text ? { display: text } : {}),
      ...(base.audioText === base.text ? { audioText: text } : {}),
      options: [...row.querySelectorAll('.option-input')].map((input) => input.value.trim() || '未填写选项')
    };
  }).filter((question) => question.response === 'text' || question.options.length >= 2);
  return {
    name: $('editorName').value.trim() || '未命名问卷',
    questions: questions.length ? questions : [{ text: '请输入题目', options: ['是', '否'] }]
  };
}

function renderPresetList() {
  const filter = $('presetFilter').value.trim().toLowerCase();
  const list = $('presetList');
  list.innerHTML = '';
  presets.forEach((preset, index) => {
    if (filter && !preset.name.toLowerCase().includes(filter)) return;
    const item = document.createElement('button');
    item.className = `preset-item${index === editingIndex ? ' active' : ''}`;
    const name = document.createElement('span');
    name.textContent = preset.name;
    const count = document.createElement('small');
    count.textContent = `${preset.questions.length} 题`;
    item.append(name, count);
    item.onclick = () => {
      editingIndex = index;
      renderPresetList();
      renderEditorForm();
    };
    list.append(item);
  });
  if (!list.children.length) list.innerHTML = '<div class="empty-state">没有匹配的问卷</div>';
}

function renderEditorForm() {
  const form = $('editorForm');
  if (editingIndex === null || !presets[editingIndex]) {
    form.classList.add('hidden');
    return;
  }
  form.classList.remove('hidden');
  $('editorName').value = presets[editingIndex].name;
  const questionEditor = $('questionEditor');
  questionEditor.innerHTML = '';
  presets[editingIndex].questions.forEach((question, questionIndex) => {
    const row = document.createElement('div');
    row.className = 'question-edit';
    row.dataset.index = String(questionIndex);
    const head = document.createElement('div');
    head.className = 'question-head';
    const title = document.createElement('span');
    title.textContent = question.section ? `第 ${questionIndex + 1} 题 · ${question.section}` : `第 ${questionIndex + 1} 题`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '删除题目';
    remove.onclick = () => {
      if (presets[editingIndex].questions.length <= 1) return;
      const draft = collectEditorDraft();
      if (draft) presets[editingIndex] = draft;
      presets[editingIndex].questions.splice(questionIndex, 1);
      renderEditorForm();
    };
    head.append(title, remove);
    const text = document.createElement(question.response === 'text' ? 'textarea' : 'input');
    text.className = 'question-text';
    text.value = question.text;
    text.placeholder = '输入题目';
    row.append(head, text);
    question.options.forEach((option, optionIndex) => {
      const optionRow = document.createElement('div');
      optionRow.className = 'option-row';
      const input = document.createElement('input');
      input.className = 'option-input';
      input.value = option;
      input.placeholder = `选项 ${optionIndex + 1}`;
      optionRow.append(input);
      if (question.options.length > 2) {
        const removeOption = document.createElement('button');
      removeOption.type = 'button';
      removeOption.textContent = '删除';
      removeOption.onclick = () => {
          const draft = collectEditorDraft();
          if (draft) presets[editingIndex] = draft;
          const currentQuestion = presets[editingIndex].questions[questionIndex];
          if (currentQuestion.options.length <= 2) return;
          currentQuestion.options.splice(optionIndex, 1);
          renderEditorForm();
        };
        optionRow.append(removeOption);
      }
      row.append(optionRow);
    });
    if (question.response === 'text') {
      questionEditor.append(row);
      return;
    }
    const addOption = document.createElement('button');
    addOption.type = 'button';
    addOption.className = 'small';
    addOption.textContent = '添加选项';
    addOption.onclick = () => {
      const draft = collectEditorDraft();
      if (draft) presets[editingIndex] = draft;
      presets[editingIndex].questions[questionIndex].options.push('新选项');
      renderEditorForm();
    };
    row.append(addOption);
    questionEditor.append(row);
  });
}

function renderQuestion() {
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  pendingAnswer = null;
  const question = activeQuestions[questionIndex];
  const options = question.options || [];
  const savedAnswer = answerByQuestion[questionIndex];
  $('prevQuestion').disabled = questionIndex === 0;
  $('nextQuestion').disabled = questionIndex === activeQuestions.length - 1;
  beginQuestionTelemetry(question);
  if (sessionId && storageReady) void writeEvent({ type: 'question_presented', ...questionFields(question), presentedAt: currentQuestionTelemetry.presentedAt });
  const displayText = question.display ?? question.text;
  $('sectionName').textContent = question.section || presets[presetIndex].name;
  $('sectionIntro').textContent = question.sectionIntro || '';
  $('sectionIntro').classList.toggle('hidden', !question.sectionIntro);
  $('question').textContent = displayText;
  $('question').className = `q${displayText.length > 34 ? ' small' : displayText.length > 14 ? ' medium' : ''}`;
  $('questionWrap').classList.toggle('empty-question', !displayText);
  /* 题干需要靠想象、不能让患者看到时，仅给研究员留一行小字提示 */
  const script = !displayText && !question.image ? question.text : '';
  $('researcherScript').textContent = script ? `研究员朗读：${script}` : '';
  $('researcherScript').classList.toggle('hidden', !script);
  stopSpeaking();
  $('questionMedia').innerHTML = '';
  if (question.image) {
    const image = document.createElement('img');
    image.src = question.image;
    image.alt = '题目材料';
    $('questionMedia').append(image);
  }
  $('choices').innerHTML = '';
  $('choices').classList.toggle('free-response', question.response === 'text');
  $('choices').classList.toggle('many', question.response !== 'text' && options.length > 2);
  $('choices').classList.toggle('long-options', options.some((option) => option.length > 5));
  $('choices').dataset.count = options.length;

  if (question.response === 'text') {
    const input = document.createElement('textarea');
    input.className = 'free-response-input';
    input.placeholder = '请输入或记录患者回答';
    input.value = savedAnswer ? savedAnswer.answer : '';
    input.addEventListener('input', () => {
      if (!currentQuestionTelemetry) return;
      registerAction(input.value, 'input');
      currentQuestionTelemetry.inputChangeCount += 1;
      void writeEvent({ type: 'input_activity', ...questionFields(question), valueLength: input.value.length, inputChangeCount: currentQuestionTelemetry.inputChangeCount });
    });
    const record = document.createElement('button');
    record.className = 'choice';
    record.textContent = '下一题';
    if (savedAnswer) record.classList.add('selected');
    record.onclick = () => {
      record.classList.add('selected');
      scheduleNext(question, input.value.trim());
    };
    $('choices').append(input, record);
    autoSpeak();
    return;
  }

  options.forEach((option) => {
    const button = document.createElement('button');
    button.className = 'choice';
    button.textContent = option;
    if (savedAnswer && savedAnswer.answer === option) button.classList.add('selected');
    button.onclick = () => {
      document.querySelectorAll('.choice').forEach((item) => { item.classList.remove('selected'); });
      button.classList.add('selected');
      scheduleNext(question, option);
    };
    $('choices').append(button);
  });
  autoSpeak();
}

function scheduleNext(question, answer) {
  registerAction(answer, question.response === 'text' ? 'input' : 'choice');
  const revision = pendingRevision + 1;
  pendingRevision = revision;
  const selectionEvent = writeEvent({
    type: 'selection',
    ...questionFields(question),
    answer,
    selectedAt: new Date().toISOString(),
    ...telemetrySnapshot()
  });
  pendingAnswer = {
    index: questionIndex,
    question: question.text,
    answer,
    selectedAt: new Date().toISOString(),
    revision,
    selectionEvent
  };
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = window.setTimeout(() => { void advanceAfterDelay(revision); }, 2000);
}

async function advanceAfterDelay(revision) {
  const pending = pendingAnswer;
  if (!pending || pending.revision !== revision) return;
  const selectionSaved = await pending.selectionEvent;
  if (!selectionSaved || pendingAnswer?.revision !== revision) return;
  const committed = await commitPendingAnswer();
  if (!committed || pendingAnswer) return;
  advanceTimer = null;
  questionIndex += 1;
  if (questionIndex < activeQuestions.length) renderQuestion();
  else await finish();
}

async function commitPendingAnswer() {
  if (!pendingAnswer) return true;
  const pending = pendingAnswer;
  const completedAt = Date.now();
  const telemetry = telemetrySnapshot();
  const record = {
    index: pending.index,
    question: pending.question,
    answer: pending.answer,
    selectedAt: pending.selectedAt,
    time: new Date(completedAt).toISOString(),
    answerDurationMs: Math.max(0, new Date(pending.selectedAt).getTime() - (currentQuestionTelemetry?.presentedAtMs || completedAt)),
    confirmationDelayMs: Math.max(0, completedAt - new Date(pending.selectedAt).getTime()),
    ...telemetry
  };
  if (!(await writeEvent({ type: 'answer_committed', ...record }))) return false;
  answerByQuestion[pending.index] = record;
  answers = Object.keys(answerByQuestion)
    .sort((a, b) => Number(a) - Number(b))
    .map((indexKey) => answerByQuestion[indexKey]);
  pendingAnswer = null;
  currentQuestionTelemetry = null;
  return true;
}

async function navigateTo(index) {
  const total = activeQuestions.length;
  if (index < 0 || index >= total) return;
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  if (pendingAnswer) {
    const saved = await pendingAnswer.selectionEvent;
    if (!saved || !(await commitPendingAnswer())) return;
  }
  questionIndex = index;
  renderQuestion();
}

function stopSpeaking() {
  isSpeaking = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  const button = $('speakQuestion');
  if (!button) return;
  button.classList.remove('speaking');
  button.textContent = '🔊';
  button.title = '朗读题目';
}

/* 手动点击时：正在朗读就停止，否则开始朗读 */
function toggleSpeech() {
  if (isSpeaking) {
    stopSpeaking();
    return;
  }
  speakQuestion(false);
}

function autoSpeak() {
  if (!voiceEnabled) return;
  window.setTimeout(() => speakQuestion(true), 80);
}

function speakQuestion(auto = false) {
  const question = activeQuestions[questionIndex];
  const text = question?.audioText || question?.text;
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined' || !text) return;
  if (currentQuestionTelemetry) {
    currentQuestionTelemetry.audioPlayCount += 1;
    void writeEvent({ type: 'question_audio', ...questionFields(question), auto, audioPlayCount: currentQuestionTelemetry.audioPlayCount });
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.9;
  utterance.onend = stopSpeaking;
  utterance.onerror = stopSpeaking;
  isSpeaking = true;
  $('speakQuestion').classList.add('speaking');
  $('speakQuestion').textContent = '⏹';
  $('speakQuestion').title = '停止朗读';
  window.speechSynthesis.speak(utterance);
}

function updateHomeButton() {
  const onSetup = !$('setup').classList.contains('hidden');
  $('homeButton').classList.toggle('hidden', onSetup);
}

function goHome() {
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  pendingRevision += 1;
  pendingAnswer = null;
  currentQuestionTelemetry = null;
  stopSpeaking();
  $('quiz').classList.add('hidden');
  $('editor').classList.add('hidden');
  $('done').classList.add('hidden');
  $('setup').classList.remove('hidden');
  updateHomeButton();
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} 秒`;
}

const escapeHtml = (value) => String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char]));

/* 每部分一行：答对/已答（总题数）。量表显示总分。 */
function renderSectionResults() {
  const stats = sectionStats();
  const rows = stats.map((group) => {
    const skipped = group.total - group.answered;
    let result;
    let rate;
    if (group.scoring === 'scale') {
      result = `总分 ${group.score}${group.maxScore ? ` / ${group.maxScore}` : ''}`;
      rate = `已答 ${group.answered}/${group.total}`;
    } else if (group.scoring === 'manual') {
      result = `${group.answered} / ${group.total}`;
      rate = '人工评分';
    } else {
      result = `${group.correct}/${group.answered} (${group.total})`;
      rate = group.answered ? `${Math.round((group.correct / group.answered) * 100)}%` : '未作答';
    }
    return `<tr><td>${escapeHtml(group.name)}</td><td class="result">${escapeHtml(result)}</td><td class="rate">${escapeHtml(rate)}</td><td class="skip">${skipped ? `跳过 ${skipped}` : ''}</td></tr>`;
  });
  const scored = stats.filter((group) => group.scoring === 'auto');
  const totals = scored.reduce((sum, group) => ({
    correct: sum.correct + group.correct,
    answered: sum.answered + group.answered,
    total: sum.total + group.total
  }), { correct: 0, answered: 0, total: 0 });
  const totalRow = scored.length
    ? `<tr class="total"><td>客观题合计</td><td class="result">${totals.correct}/${totals.answered} (${totals.total})</td><td class="rate">${totals.answered ? `${Math.round((totals.correct / totals.answered) * 100)}%` : '—'}</td><td class="skip"></td></tr>`
    : '';
  $('sectionResults').innerHTML = `<table class="section-table"><thead><tr><th>分区</th><th>答对/已答（总题数）</th><th>正确率</th><th></th></tr></thead><tbody>${rows.join('')}${totalRow}</tbody></table>`;
}

function renderDashboard() {
  const completed = answers.filter(hasAnswer);
  const answered = completed.length;
  const averageReaction = answered ? completed.reduce((sum, answer) => sum + (answer.reactionTimeMs || 0), 0) / answered : 0;
  const averageDuration = answered ? completed.reduce((sum, answer) => sum + (answer.answerDurationMs || 0), 0) / answered : 0;
  const changes = answers.reduce((sum, answer) => sum + (answer.answerChanges || 0), 0);
  const audioCount = answers.reduce((sum, answer) => sum + (answer.audioPlayCount || 0), 0);
  $('dashboard').innerHTML = [
    ['已完成题数', `${answered} / ${activeQuestions.length}`],
    ['平均反应时间', formatDuration(averageReaction)],
    ['平均答题耗时', formatDuration(averageDuration)],
    ['选项修改次数', `${changes}`],
    ['题干播放次数', `${audioCount}`],
    ['记录状态', storageFailure ? '有保存警告' : '已逐题保存']
  ].map(([label, value]) => `<div class="metric"><strong>${label}</strong><span>${value}</span></div>`).join('');
}

async function finalizeSessionLog() {
  await Promise.all([...eventWritePromises]);
  await opfsWriteQueue;
  await directoryWriteQueue;
  if (!sessionId || !logDb) return [];
  const events = await idbGetSessionEvents(sessionId);
  if (directoryHandle) {
    try {
      const filename = directoryLogFileName || `${safeFilePart(patient)}_${sessionId}.jsonl`;
      const target = await directoryHandle.getFileHandle(filename, { create: true });
      const writable = await target.createWritable();
      await writable.write(events.map((event) => JSON.stringify(event)).join('\n') + '\n');
      await writable.close();
      $('saveStatus').textContent = `实时日志已保存到：${directoryHandle.name}/${filename}`;
    } catch (error) {
      setStorageStatus(`自定义日志文件最终写入失败；本机记录仍已保存。${error?.message || error}`, 'error');
    }
  }
  if (opfsLogDirectory) {
    try {
      const manifest = await opfsLogDirectory.getFileHandle(`${sessionId}-manifest.json`, { create: true });
      const writable = await manifest.createWritable();
      await writable.write(JSON.stringify({ sessionId, patient, age: patientAge || null, preset: presets[presetIndex].name, events }, null, 2));
      await writable.close();
    } catch (error) {
      console.warn('OPFS 最终清单写入失败。', error);
    }
  }
  return events;
}

async function finish() {
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  await Promise.all([...eventWritePromises]);
  const completedAt = new Date().toISOString();
  try {
    await idbPut('sessions', {
      id: sessionId,
      patient,
      age: patientAge || null,
      preset: presets[presetIndex].name,
      startedAt: new Date(sessionStartedAt).toISOString(),
      completedAt,
      status: 'completed',
      answerCount: answers.length
    });
  } catch (error) {
    reportStorageFailure(error, '测试完成记录');
  }
  await writeEvent({ type: 'session_completed', completedAt, answerCount: answers.length });
  try { await finalizeSessionLog(); } catch (error) { reportStorageFailure(error, '日志整理'); }
  $('quiz').classList.add('hidden');
  $('done').classList.remove('hidden');
  updateHomeButton();
  $('summary').textContent = `患者 ${patient}${patientAge ? `（${patientAge} 岁）` : ''} 已完成“${presets[presetIndex].name}”${ageBand ? `（名人题：${ageBand === 'young' ? '18–30 岁版' : '31–60 岁版'}）` : ''}。`;
  renderSectionResults();
  renderDashboard();
  $('logPath').textContent = directoryHandle
    ? `实时日志路径：${directoryHandle.name}/${directoryLogFileName}`
    : `实时日志路径：本机离线存储 / ScalePad-logs / ${sessionId}（完成后可导出到“下载”或自定义位置）`;
}

async function download(extension, type) {
  const events = sessionId && logDb ? await idbGetSessionEvents(sessionId) : sessionEventCache;
  const stats = sectionStats();
  const data = {
    schemaVersion: 3,
    sessionId,
    patient,
    age: patientAge || null,
    ageBand,
    epilepsy,
    preset: presets[presetIndex].name,
    startedAt: sessionStartedAt ? new Date(sessionStartedAt).toISOString() : null,
    completedAt: new Date().toISOString(),
    sections: stats,
    answers,
    events
  };
  const describe = (answer) => {
    const question = activeQuestions[answer.questionIndex];
    if (!question) return ['', '', ''];
    if (question.scoring === 'scale') return ['', String(scaleScore(question, answer.answer)), ''];
    if (question.scoring === 'manual') return ['', '', question.correct ?? ''];
    return [isCorrect(question, answer.answer) ? '1' : '0', '', question.correct ?? ''];
  };
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const answerRows = answers.map((answer) => {
    const [correct, score, expected] = describe(answer);
    return [patient, patientAge, ageBand, presets[presetIndex].name, answer.questionIndex, answer.section, answer.question, answer.answer, expected, correct, score,
      answer.time, answer.answerDurationMs, answer.confirmationDelayMs, answer.reactionTimeMs, answer.answerChanges, answer.audioPlayCount].map(quote).join(',');
  });
  const statRows = stats.map((group) => ['分区汇总', group.name, group.scoring, group.correct, group.answered, group.total, group.score].map(quote).join(','));
  const content = type === 'json'
    ? JSON.stringify(data, null, 2)
    : '\uFEFFpatient,age,ageBand,preset,questionIndex,section,question,answer,expected,correct,score,time,answerDurationMs,confirmationDelayMs,reactionTimeMs,answerChanges,audioPlayCount\n'
      + answerRows.join('\n')
      + '\n\n\uFEFF类型,分区,评分方式,答对,已答,总题数,量表总分\n'
      + statRows.join('\n');
  const filename = `${safeFilePart(patient)}_${sessionId || Date.now()}.${extension}`;
  const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8';
  const file = new File([content], filename, { type: mime });

  if (directoryHandle) {
    try {
      const target = await directoryHandle.getFileHandle(filename, { create: true });
      const writable = await target.createWritable();
      await writable.write(content);
      await writable.close();
      $('saveStatus').textContent = `已保存到：${directoryHandle.name}/${filename}`;
      return;
    } catch (error) {
      directoryHandle = null;
      $('saveStatus').textContent = '无法写入所选文件夹，已改用系统文件面板或下载';
    }
  }

  if (window.showSaveFilePicker) {
    try {
      const target = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: type === 'json' ? 'JSON 文件' : 'CSV 文件', accept: { [mime.split(';')[0]]: [`.${extension}`] } }]
      });
      const writable = await target.createWritable();
      await writable.write(content);
      await writable.close();
      $('saveStatus').textContent = `已保存：${filename}`;
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }

  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ title: 'BIP评估答题记录', files: [file] });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }

  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
  $('logPath').textContent = `已请求下载：${filename}。请在 iPad“文件”App 的“下载”中确认文件。`;
}

$('csv').onclick = () => download('csv', 'csv');
$('json').onclick = () => download('json', 'json');
$('again').onclick = () => window.location.reload();
