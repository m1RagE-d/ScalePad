const defaultPresets = window.scalePadPresets || [];

const presetStorageKey = 'scalepad_presets_v2';
let presets = loadPresets();

let presetIndex = 0;
let questionIndex = 0;
let answers = [];
let answerByQuestion = {};
let patient = '';
let editingIndex = null;
let directoryHandle = null;
let advanceTimer = null;
let pendingAnswer = null;
const $ = (id) => document.getElementById(id);

function loadPresets() {
  try {
    const saved = JSON.parse(localStorage.getItem(presetStorageKey));
    if (Array.isArray(saved) && saved.length && saved.every(isValidPreset)) {
      const defaultsByName = new Map(defaultPresets.map((preset) => [preset.name, preset]));
      return saved.map((preset) => {
        const builtin = defaultsByName.get(preset.name);
        const hasPromptData = preset.questions.some((question) => question.display || question.audioText || question.section);
        if (builtin && preset.questions.length === builtin.questions.length && !hasPromptData) return clonePreset(builtin);
        return preset;
      });
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
      text: question.text,
      options: [...(question.options || [])],
      response: question.response || 'choice',
      ...(Object.prototype.hasOwnProperty.call(question, 'display') ? { display: question.display } : {}),
      ...(question.audioText ? { audioText: question.audioText } : {}),
      ...(question.section ? { section: question.section } : {}),
      ...(question.image ? { image: question.image } : {})
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

$('chooseSaveFolder').onclick = chooseSaveFolder;
$('homeButton').onclick = goHome;
$('prevQuestion').onclick = () => navigateTo(questionIndex - 1);
$('nextQuestion').onclick = () => navigateTo(questionIndex + 1);
$('questionJump').onchange = () => navigateTo(Number($('questionJump').value));
$('speakQuestion').onclick = () => speakQuestion();

async function chooseSaveFolder() {
  if (!window.showDirectoryPicker) {
    $('saveStatus').textContent = '当前浏览器不支持直接绑定文件夹；导出时将打开系统文件面板';
    return;
  }
  try {
    directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('saveStatus').textContent = `已选择：${directoryHandle.name}`;
  } catch (error) {
    if (error.name !== 'AbortError') $('saveStatus').textContent = '文件夹选择失败，请重试';
  }
}

$('start').onclick = () => {
  patient = $('patient').value.trim() || '未填写';
  presetIndex = Number($('preset').value);
  questionIndex = 0;
  answers = [];
  answerByQuestion = {};
  $('setup').classList.add('hidden');
  $('quiz').classList.remove('hidden');
  updateHomeButton();
  renderQuestion();
};

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
  const questions = [...$('questionEditor').querySelectorAll('.question-edit')].map((row) => ({
    text: row.querySelector('.question-text').value.trim() || '未填写题目',
    response: row.dataset.response || 'choice',
    options: [...row.querySelectorAll('.option-input')].map((input) => input.value.trim() || '未填写选项'),
    ...(row.dataset.hasDisplay === 'true' ? { display: row.dataset.display } : {}),
    ...(row.dataset.audioText ? { audioText: row.dataset.audioText } : {}),
    ...(row.dataset.image ? { image: row.dataset.image } : {})
  })).filter((question) => question.response === 'text' || question.options.length >= 2);
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
    row.dataset.response = question.response || 'choice';
    row.dataset.display = question.display ?? '';
    row.dataset.hasDisplay = Object.prototype.hasOwnProperty.call(question, 'display') ? 'true' : 'false';
    row.dataset.audioText = question.audioText || question.text || '';
    row.dataset.image = question.image || '';
    const head = document.createElement('div');
    head.className = 'question-head';
    const title = document.createElement('span');
    title.textContent = `第 ${questionIndex + 1} 题`;
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
  const question = presets[presetIndex].questions[questionIndex];
  const options = question.options || [];
  const savedAnswer = answerByQuestion[questionIndex];
  updateQuestionJump();
  $('prevQuestion').disabled = questionIndex === 0;
  $('nextQuestion').disabled = questionIndex === presets[presetIndex].questions.length - 1;
  const displayText = question.display ?? question.text;
  $('question').textContent = displayText;
  $('questionWrap').classList.toggle('empty-question', !displayText);
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  $('speakQuestion').classList.remove('speaking');
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
  $('choices').dataset.count = options.length;

  if (question.response === 'text') {
    const input = document.createElement('textarea');
    input.className = 'free-response-input';
    input.placeholder = '请输入或记录患者回答';
    input.value = savedAnswer ? savedAnswer.answer : '';
    const record = document.createElement('button');
    record.className = 'small';
    record.textContent = '下一题';
    if (savedAnswer) record.classList.add('selected');
    record.onclick = () => {
      record.classList.add('selected');
      scheduleNext(question, input.value.trim());
    };
    $('choices').append(input, record);
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
}

function scheduleNext(question, answer) {
  pendingAnswer = { index: questionIndex, question: question.text, answer, time: new Date().toISOString() };
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = window.setTimeout(() => {
    commitPendingAnswer();
    advanceTimer = null;
    questionIndex += 1;
    if (questionIndex < presets[presetIndex].questions.length) renderQuestion();
    else finish();
  }, 2000);
}

function commitPendingAnswer() {
  if (!pendingAnswer) return;
  const { index, ...record } = pendingAnswer;
  answerByQuestion[index] = record;
  pendingAnswer = null;
  answers = Object.keys(answerByQuestion)
    .sort((a, b) => Number(a) - Number(b))
    .map((indexKey) => answerByQuestion[indexKey]);
}

function navigateTo(index) {
  const total = presets[presetIndex].questions.length;
  if (index < 0 || index >= total) return;
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  commitPendingAnswer();
  questionIndex = index;
  renderQuestion();
}

function updateQuestionJump() {
  const select = $('questionJump');
  const questions = presets[presetIndex].questions;
  if (select.options.length !== questions.length || select.dataset.preset !== String(presetIndex)) {
    select.innerHTML = '';
    questions.forEach((question, index) => {
      const section = question.section ? ` · ${question.section}` : '';
      select.add(new Option(`${index + 1} / ${questions.length}${section}`, index));
    });
    select.dataset.preset = String(presetIndex);
  }
  select.value = String(questionIndex);
}

function speakQuestion() {
  const question = presets[presetIndex].questions[questionIndex];
  const text = question.audioText || question.text;
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined' || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 0.9;
  utterance.onend = () => $('speakQuestion').classList.remove('speaking');
  utterance.onerror = () => $('speakQuestion').classList.remove('speaking');
  $('speakQuestion').classList.add('speaking');
  window.speechSynthesis.speak(utterance);
}

function updateHomeButton() {
  const onSetup = !$('setup').classList.contains('hidden');
  $('homeButton').classList.toggle('hidden', onSetup);
}

function goHome() {
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  pendingAnswer = null;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  $('quiz').classList.add('hidden');
  $('editor').classList.add('hidden');
  $('done').classList.add('hidden');
  $('setup').classList.remove('hidden');
  updateHomeButton();
}

function finish() {
  if (advanceTimer) window.clearTimeout(advanceTimer);
  advanceTimer = null;
  $('quiz').classList.add('hidden');
  $('done').classList.remove('hidden');
  updateHomeButton();
  $('summary').textContent = `患者 ${patient} 已完成“${presets[presetIndex].name}”，共记录 ${answers.length} 题。`;
  localStorage.setItem(`scalepad_${Date.now()}`, JSON.stringify({ patient, preset: presets[presetIndex].name, answers }));
}

async function download(extension, type) {
  const data = { patient, preset: presets[presetIndex].name, answers };
  const content = type === 'json'
    ? JSON.stringify(data, null, 2)
    : '\uFEFFpatient,preset,question,answer,time\n' + answers.map((answer) => [patient, presets[presetIndex].name, answer.question, answer.answer, answer.time]
      .map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  const filename = `${patient}_${Date.now()}.${extension}`;
  const mime = type === 'json' ? 'application/json;charset=utf-8' : 'text/csv;charset=utf-8';
  const file = new File([content], filename, { type: mime });

  if (directoryHandle) {
    try {
      const target = await directoryHandle.getFileHandle(filename, { create: true });
      const writable = await target.createWritable();
      await writable.write(content);
      await writable.close();
      $('saveStatus').textContent = `已保存到：${directoryHandle.name}`;
      return;
    } catch (error) {
      directoryHandle = null;
      $('saveStatus').textContent = '无法写入所选文件夹，已改用系统文件面板';
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
}

$('csv').onclick = () => download('csv', 'csv');
$('json').onclick = () => download('json', 'json');
$('again').onclick = () => window.location.reload();
