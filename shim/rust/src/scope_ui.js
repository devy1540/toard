window.opener?.postMessage({ protocol: 'toard-helper-v1', nonce: boot.nonce, ready: true, scopeReady: true }, boot.openerOrigin);
const names = { codex: 'Codex', claude_code: 'Claude Code', cursor: 'Cursor', gemini: 'Gemini', qwen: 'Qwen' };
const $ = id => document.getElementById(id);
$('endpoint').textContent = boot.endpoint;
let preview = null, finished = false;
const rules = new Map();
addEventListener('beforeunload', () => { if (!finished)
    window.opener?.postMessage({ protocol: 'toard-helper-v1', nonce: boot.nonce, action: 'scope', ok: false, error: 'scope_cancelled' }, boot.openerOrigin); });
const request = async (path, options = {}) => { const response = await fetch(path, { ...options, credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${boot.capability}`, ...options.headers } }); const value = await response.json(); if (!response.ok) {
    throw new Error(value.error || 'request_failed');
} return value; };
const errorText = code => ({ experimental_otlp_active: '이 서버로 직접 보내는 experimental OTLP 설정이 남아 있습니다. toard-shim otlp off 실행 후 AI 도구를 다시 시작해 주세요. 직접 작성한 OTLP 설정은 별도로 해제해야 합니다.', legacy_settings_unreadable: '기존 AI 도구의 설정 파일을 확인하지 못했습니다. 파일을 보존하고 설정 오류를 해결한 뒤 다시 적용해 주세요.', scope_session_expired: '확인 시간이 만료되었습니다. 이 창을 닫고 다시 열어 주세요.', target_changed: '서버 연결 설정이 변경되었습니다. 이 창을 닫고 다시 확인해 주세요.', invalid_scope: '선택한 범위를 저장할 수 없습니다. 프로젝트는 최대 256개까지 지정할 수 있습니다.', scope_not_saved: '설정을 저장하지 못했습니다. 연결 설정이 바뀌었는지 확인해 주세요.' }[code] || '로컬 설정을 확인하지 못했습니다. 잠시 후 다시 열어 주세요.');
function policy() { const mode = $('mode').value; return { schemaVersion: 1, mode, providers: mode === 'custom' ? Object.fromEntries([...rules].map(([key, rule]) => [key, rule.mode === 'all' || rule.mode === 'off' ? { mode: rule.mode } : { mode: rule.mode, projects: [...rule.projects].sort() }])) : {} }; }
function refresh() { const mode = $('mode').value; $('custom').hidden = mode !== 'custom'; let selected = 0, unknown = 0, pending = 0; for (const provider of preview.providers) {
    const rule = rules.get(provider.key);
    const enabled = mode === 'all' || (mode === 'custom' && rule.mode !== 'off');
    if (enabled) {
        if (mode === 'all' || rule.mode === 'all') {
            selected += provider.projects.reduce((sum, p) => sum + p.usageRecords, 0);
            unknown += provider.unidentifiedRecords;
            pending += provider.unidentifiedPending;
        }
        for (const project of provider.projects) {
            const allowed = mode === 'all' || rule.mode === 'all' || (rule.mode === 'include' ? rule.projects.has(project.id) : !rule.projects.has(project.id));
            if (allowed) {
                if (mode !== 'all' && rule.mode !== 'all')
                    selected += project.usageRecords;
                pending += project.pendingRecords;
            }
        }
    }
} $('summary').textContent = mode === 'paused' ? '이 서버로 사용량·본문·도구 활동을 보내지 않습니다.' : `현재 로컬 기록에서 사용량 ${selected.toLocaleString()}건${unknown ? `, 미식별 기록 ${unknown.toLocaleString()}건` : ''}이 범위에 들어갑니다. 전송 대기 중 이 범위에 해당하는 기록은 ${pending.toLocaleString()}건입니다. 이미 전송된 기록은 서버에서 중복 처리합니다.`; }
function renderProvider(provider) { const rule = { mode: provider.rule.mode, projects: new Set(provider.rule.projects || []) }; rules.set(provider.key, rule); const card = document.createElement('section'); card.className = 'card'; const header = document.createElement('div'); header.className = 'row'; const title = document.createElement('h2'); title.textContent = names[provider.key] || provider.key; const select = document.createElement('select'); select.setAttribute('aria-label', `${names[provider.key] || provider.key} 수집 범위`); for (const [value, label] of [['all', '모든 프로젝트'], ['off', '수집 안 함'], ['include', '선택한 프로젝트만 포함'], ['exclude', '선택한 프로젝트 제외']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
} select.value = rule.mode; header.append(title, select); card.append(header); const note = document.createElement('p'); note.className = 'muted'; note.textContent = `파일 ${provider.filesChecked.toLocaleString()}개 확인 · 미식별 사용량 ${provider.unidentifiedRecords.toLocaleString()}건 · 미식별 대기 ${provider.unidentifiedPending.toLocaleString()}건${provider.parseErrors || provider.readFailures || provider.unsupportedFiles ? ` · 읽기·파싱 문제 ${(provider.parseErrors + provider.readFailures).toLocaleString()}건 · 형식 미지원 ${(provider.unsupportedFiles || 0).toLocaleString()}개` : ''}`; card.append(note); const list = document.createElement('div'); list.className = 'projects'; for (const project of provider.projects) {
    const item = document.createElement('div');
    item.className = 'project';
    item.dataset.search = project.label.toLocaleLowerCase();
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = rule.projects.has(project.id);
    const text = document.createElement('span');
    text.textContent = project.label;
    const meta = document.createElement('small');
    meta.className = 'muted';
    meta.textContent = `${{ cwd: '작업 경로', group: '로그 그룹', opaque: '원본 경로 미확인' }[project.kind] || '프로젝트'} · 사용량 ${project.usageRecords.toLocaleString()}건 · 전송 대기 ${project.pendingRecords.toLocaleString()}건`;
    text.append(meta);
    label.append(checkbox, text);
    item.append(label);
    if (project.sample) {
        const detail = document.createElement('details'), summary = document.createElement('summary'), code = document.createElement('pre');
        summary.textContent = '사용량 전송 항목 예시';
        code.textContent = JSON.stringify(project.sample, null, 2);
        detail.append(summary, code);
        item.append(detail);
    }
    checkbox.addEventListener('change', () => { checkbox.checked ? rule.projects.add(project.id) : rule.projects.delete(project.id); refresh(); });
    list.append(item);
} if (!provider.projects.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '아직 식별한 프로젝트가 없습니다. AI 도구를 사용한 뒤 다시 확인하거나 모든 프로젝트 수집을 선택할 수 있습니다.';
    if (provider.filesChecked || provider.unidentifiedPending)
        list.append(empty);
} const update = () => { rule.mode = select.value; for (const input of list.querySelectorAll('input'))
    input.disabled = rule.mode === 'all' || rule.mode === 'off'; refresh(); }; select.addEventListener('change', update); card.append(list); $('providers').append(card); for (const input of list.querySelectorAll('input'))
    input.disabled = rule.mode === 'all' || rule.mode === 'off'; }
$('mode').addEventListener('change', refresh);
$('search').addEventListener('input', () => { const query = $('search').value.toLocaleLowerCase(); for (const item of document.querySelectorAll('.project'))
    item.hidden = !item.dataset.search.includes(query); });
$('cancel').addEventListener('click', () => window.close());
$('form').addEventListener('submit', async (event) => { event.preventDefault(); $('save').disabled = true; $('status').className = ''; $('status').textContent = '선택한 범위를 저장하고 있습니다…'; try {
    const value = await request('/v1/scope/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy()) });
    finished = true;
    $('status').textContent = '수집 범위를 저장했습니다. 다음 수집부터 적용됩니다.';
    $('form').hidden = true;
    window.opener?.postMessage({ protocol: 'toard-helper-v1', nonce: boot.nonce, action: 'scope', ok: true, value }, boot.openerOrigin);
}
catch (error) {
    $('status').className = 'error';
    $('status').textContent = errorText(error.message);
    $('save').disabled = false;
} });
request('/v1/scope/preview').then(value => { preview = value; $('mode').value = value.policy.mode; $('fields').textContent = `선택한 범위에서 전송할 항목: 사용량 · 본문 ${value.sends.content ? '켜짐' : '꺼짐'} · 도구 활동 ${value.sends.tools ? '켜짐' : '꺼짐'}. 이 창에서는 수집할 프로젝트만 변경합니다.`; value.providers.sort((a, b) => b.projects.length - a.projects.length); for (const provider of value.providers)
    renderProvider(provider); $('status').textContent = value.queueReadable ? '로컬 확인을 마쳤습니다. 전송할 범위를 선택해 주세요.' : '로컬 보관함을 읽지 못했습니다. 파일을 보존하고 진단을 실행하세요.'; $('form').hidden = false; refresh(); }).catch(error => { $('status').className = 'error'; $('status').textContent = errorText(error.message); });
