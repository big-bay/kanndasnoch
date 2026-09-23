const elements = Object.fromEntries(
  [
    'server-status', 'global-message', 'app-loading', 'login-panel', 'login-form', 'dashboard', 'logout-button',
    'welcome-copy', 'connection-copy', 'connect-button', 'account-avatar', 'target-account',
    'publish-form', 'video-file', 'upload-zone', 'upload-state', 'video-preview', 'file-details',
    'file-name', 'file-size', 'file-duration', 'file-hash', 'upload-limits', 'caption', 'caption-count', 'privacy',
    'allow-comment', 'allow-duet', 'allow-stitch', 'is-aigc', 'commercial-content',
    'commercial-options', 'commercial-note', 'brand-organic', 'brand-content', 'accepted-rights',
    'rights-copy', 'publish-button', 'refresh-history', 'history-empty',
    'history-list'
  ].map(id => [id, document.getElementById(id)])
);

const state = {
  user: null,
  creator: null,
  upload: null,
  intent: null,
  idempotencyKey: null,
  previewUrl: null,
  busy: false
};

const appBaseUrl = new URL('.', location.href);

const privacyLabels = {
  PUBLIC_TO_EVERYONE: 'Öffentlich',
  MUTUAL_FOLLOW_FRIENDS: 'Freunde (gegenseitiges Folgen)',
  FOLLOWER_OF_CREATOR: 'Follower',
  SELF_ONLY: 'Nur ich'
};

const statusLabels = {
  VALIDATING: 'Wird geprüft',
  PROCESSING_UPLOAD: 'Wird verarbeitet',
  PROCESSING_DOWNLOAD: 'Wird verarbeitet',
  SEND_TO_USER_INBOX: 'In TikTok-Inbox',
  PUBLISH_COMPLETE: 'Veröffentlicht',
  FAILED: 'Fehlgeschlagen',
  REJECTED: 'Abgelehnt',
  CANCELLED: 'Abgebrochen'
};

function setServerStatus(kind, text) {
  elements['server-status'].className = `status-badge ${kind}`.trim();
  elements['server-status'].lastChild.textContent = ` ${text}`;
}

function message(text, kind = 'info') {
  elements['global-message'].textContent = text;
  elements['global-message'].className = `notice ${kind === 'info' ? '' : kind}`.trim();
  elements['global-message'].hidden = !text;
}

async function api(path, options = {}) {
  const endpoint = new URL(String(path).replace(/^\/+/, ''), appBaseUrl);
  const response = await fetch(endpoint, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.headers || {}) }
  });
  const raw = await response.text();
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { payload = { error: { code: 'invalid_server_response', message: 'Der Server hat unerwartet geantwortet.' } }; }
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || 'Die Anfrage ist fehlgeschlagen.');
    error.status = response.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

function formatBytes(bytes) {
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(bytes / 1_000_000) + ' MB';
}

function formatDuration(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')} min`;
}

function readVideoDuration(video) {
  if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration);
  return new Promise((resolve, reject) => {
    const finish = () => {
      cleanup();
      if (Number.isFinite(video.duration) && video.duration > 0) resolve(video.duration);
      else reject(new Error('Die Videodauer konnte nicht gelesen werden.'));
    };
    const fail = () => {
      cleanup();
      reject(new Error('Die Videodauer konnte nicht gelesen werden.'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', finish);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('loadedmetadata', finish, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
}

function formatDate(value) {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function showLogin() {
  document.body.classList.add('app-ready');
  elements['app-loading'].hidden = true;
  elements['login-panel'].hidden = false;
  elements.dashboard.hidden = true;
  elements['logout-button'].hidden = true;
}

function showDashboard() {
  document.body.classList.add('app-ready');
  elements['app-loading'].hidden = true;
  elements['login-panel'].hidden = true;
  elements.dashboard.hidden = false;
  elements['logout-button'].hidden = false;
  elements['welcome-copy'].textContent = `${state.user.label}: Konto verbinden, Video prüfen, bewusst posten.`;
}

function setBusy(busy, label) {
  state.busy = busy;
  if (label) elements['publish-button'].textContent = label;
  updatePublishButton();
}

function updatePublishButton() {
  const commercialValid = !elements['commercial-content'].checked || elements['brand-organic'].checked || elements['brand-content'].checked;
  const privacyValid = !(elements['brand-content'].checked && elements.privacy.value === 'SELF_ONLY');
  const ready = state.creator?.connected && state.upload && elements.caption.value.trim() && elements.privacy.value && elements['accepted-rights'].checked && commercialValid && privacyValid && !state.busy && !state.intent;
  elements['publish-button'].disabled = !ready;
  if (!state.busy) elements['publish-button'].textContent = state.intent ? 'Auftrag bereits gestartet' : 'Auf TikTok veröffentlichen';
}

function syncCommercialContent() {
  const enabled = elements['commercial-content'].checked;
  elements['commercial-options'].hidden = !enabled;
  elements['brand-organic'].disabled = !enabled;
  if (!enabled) {
    elements['brand-organic'].checked = false;
    elements['brand-content'].checked = false;
  }

  const selfOnly = elements.privacy.value === 'SELF_ONLY';
  if (selfOnly) elements['brand-content'].checked = false;
  elements['brand-content'].disabled = !enabled || selfOnly;
  const branded = enabled && elements['brand-content'].checked;
  const selfOnlyOption = Array.from(elements.privacy.options).find(option => option.value === 'SELF_ONLY');
  if (selfOnlyOption) selfOnlyOption.disabled = branded;

  elements['commercial-note'].classList.toggle('error', enabled && !elements['brand-organic'].checked && !elements['brand-content'].checked);
  elements['commercial-note'].textContent = !enabled
    ? ''
    : selfOnly
      ? 'Bezahlte Partnerschaften können nicht mit „Nur ich“ veröffentlicht werden.'
      : branded
        ? 'Der Beitrag wird als „Bezahlte Partnerschaft“ gekennzeichnet.'
        : elements['brand-organic'].checked
          ? 'Der Beitrag wird als „Werbeinhalte“ gekennzeichnet.'
          : 'Wähle „Eigene Marke“, „Bezahlte Partnerschaft“ oder beides.';
  elements['rights-copy'].textContent = branded
    ? 'Ich habe die nötigen Rechte. Mit dem Veröffentlichen stimme ich TikToks Branded Content Policy und Music Usage Confirmation zu.'
    : 'Ich habe die nötigen Rechte an Video, Ton, Text und Marken. Mit dem Veröffentlichen stimme ich TikToks Music Usage Confirmation zu.';
  updatePublishButton();
}

function renderCreator(creator) {
  state.creator = creator;
  elements['connect-button'].disabled = false;
  if (!creator.connected) {
    elements['connection-copy'].textContent = creator.configured === false
      ? 'Die sichere TikTok-Serververbindung wird noch eingerichtet.'
      : 'Noch kein TikTok-Konto verbunden.';
    elements['connect-button'].textContent = 'TikTok verbinden';
    elements['connect-button'].hidden = creator.configured === false;
    elements['target-account'].textContent = 'Kein Zielkonto';
    elements.privacy.innerHTML = '<option value="">Zuerst TikTok verbinden</option>';
    elements.privacy.disabled = true;
    elements['upload-limits'].textContent = 'MP4, MOV oder WebM · maximal 500 MB';
    for (const id of ['allow-comment', 'allow-duet', 'allow-stitch']) {
      elements[id].checked = false;
      elements[id].disabled = true;
      elements[id].closest('.toggle-row').classList.add('disabled');
    }
    updatePublishButton();
    return;
  }

  const username = creator.username ? `@${creator.username}` : 'Verbundenes TikTok-Konto';
  const identity = creator.displayName ? `${creator.displayName} (${username})` : username;
  elements['connection-copy'].textContent = `${identity} ist über TikTok OAuth verbunden.`;
  elements['connect-button'].hidden = true;
  elements['target-account'].textContent = identity;
  if (creator.avatarUrl) {
    const image = document.createElement('img');
    image.src = creator.avatarUrl;
    image.alt = '';
    elements['account-avatar'].replaceChildren(image);
  } else {
    elements['account-avatar'].textContent = '@';
  }

  elements.privacy.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Bitte bewusst wählen';
  elements.privacy.append(placeholder);
  for (const value of creator.privacyOptions || []) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = privacyLabels[value] || value;
    elements.privacy.append(option);
  }
  elements.privacy.disabled = false;
  elements['upload-limits'].textContent = creator.maxVideoDurationSeconds > 0
    ? `MP4, MOV oder WebM · maximal 500 MB · TikTok-Limit ${formatDuration(creator.maxVideoDurationSeconds)}`
    : 'MP4, MOV oder WebM · maximal 500 MB';
  for (const [id, disabled] of [
    ['allow-comment', creator.commentDisabled],
    ['allow-duet', creator.duetDisabled],
    ['allow-stitch', creator.stitchDisabled]
  ]) {
    elements[id].checked = false;
    elements[id].disabled = Boolean(disabled);
    elements[id].closest('.toggle-row').classList.toggle('disabled', Boolean(disabled));
  }
  syncCommercialContent();
}

async function loadCreator() {
  elements['connection-copy'].textContent = 'Verbindungsstatus wird geladen.';
  elements['connect-button'].disabled = true;
  try {
    renderCreator(await api('/api/v1/tiktok/connection'));
    const params = new URLSearchParams(location.search);
    if (params.get('connected') === 'tiktok') {
      message(state.creator.connected ? 'TikTok-Konto wurde erfolgreich verbunden.' : 'Die Verbindung ist noch nicht aktiv. Bitte versuche es erneut.', state.creator.connected ? 'success' : 'error');
      history.replaceState({}, '', location.pathname);
    }
  } catch (error) {
    elements['connection-copy'].textContent = error.message;
    elements['connect-button'].disabled = false;
    if (error.code === 'integration_not_configured') message('Der Betaserver ist vorbereitet, aber die sichere TikTok-Serververbindung ist noch nicht aktiviert.', 'error');
  }
}

function renderHistory(items) {
  elements['history-list'].replaceChildren();
  elements['history-empty'].hidden = items.length > 0;
  for (const item of items) {
    const entry = document.createElement('li');
    entry.className = 'history-item';
    const detail = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.asset.fileName;
    const meta = document.createElement('small');
    meta.textContent = `${item.tiktokUsername ? `@${item.tiktokUsername} · ` : ''}${privacyLabels[item.privacyLevel] || item.privacyLevel} · ${formatDate(item.createdAt)}`;
    detail.append(title, meta);
    const badge = document.createElement('span');
    badge.className = `history-status ${item.status === 'PUBLISH_COMPLETE' ? 'success' : ['FAILED', 'REJECTED', 'CANCELLED'].includes(item.status) ? 'error' : ''}`.trim();
    badge.textContent = statusLabels[item.status] || item.status;
    entry.append(detail, badge);
    if (item.error) {
      const error = document.createElement('p');
      error.className = 'history-error';
      error.textContent = `${item.error.code}: ${item.error.message}`;
      entry.append(error);
    }
    elements['history-list'].append(entry);
  }
}

async function loadHistory() {
  try {
    const payload = await api('/api/v1/publish-intents');
    renderHistory(payload.items || []);
  } catch (error) {
    message(error.message, 'error');
  }
}

async function initialize() {
  try {
    const health = await api('/api/v1/health');
    setServerStatus(health.integrationConfigured ? '' : 'neutral', health.integrationConfigured ? 'Server bereit' : 'Server im Einrichtungsmodus');
  } catch {
    setServerStatus('error', 'Betaserver nicht erreichbar');
    showLogin();
    message('Der geschützte Betaserver ist unter dieser Adresse noch nicht erreichbar. Die öffentliche Infoseite funktioniert bereits; der Publisher wird nach der Serverfreigabe aktiviert.', 'error');
    return;
  }

  try {
    const payload = await api('/api/v1/auth/session');
    if (!payload.authenticated) return showLogin();
    state.user = payload.user;
    showDashboard();
    await Promise.all([loadCreator(), loadHistory()]);
  } catch (error) {
    showLogin();
    message(error.message, 'error');
  }
}

elements['login-form'].addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = event.submitter;
  button.disabled = true;
  button.textContent = 'Anmeldung wird geprüft…';
  message('');
  try {
    const data = new FormData(form);
    const payload = await api('/api/v1/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: data.get('email'), inviteCode: data.get('inviteCode') })
    });
    state.user = payload.user;
    form.reset();
    showDashboard();
    message('Anmeldung erfolgreich.', 'success');
    await Promise.all([loadCreator(), loadHistory()]);
  } catch (error) {
    message(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Sicher anmelden';
  }
});

elements['logout-button'].addEventListener('click', async () => {
  try { await api('/api/v1/auth/session', { method: 'DELETE' }); }
  catch { /* The local UI still returns to signed-out state. */ }
  state.user = null;
  state.creator = null;
  state.upload = null;
  state.intent = null;
  showLogin();
  message('Du bist abgemeldet.', 'success');
});

elements['connect-button'].addEventListener('click', async () => {
  elements['connect-button'].disabled = true;
  elements['connect-button'].textContent = 'TikTok wird geöffnet…';
  message('');
  try {
    const payload = await api('/api/v1/tiktok/connections', { method: 'POST' });
    if (payload.connected) await loadCreator();
    else location.assign(payload.redirectUrl);
  } catch (error) {
    message(error.message, 'error');
    elements['connect-button'].disabled = false;
    elements['connect-button'].textContent = 'TikTok verbinden';
  }
});

for (const eventName of ['dragenter', 'dragover']) {
  elements['upload-zone'].addEventListener(eventName, event => {
    event.preventDefault();
    elements['upload-zone'].classList.add('dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  elements['upload-zone'].addEventListener(eventName, event => {
    event.preventDefault();
    elements['upload-zone'].classList.remove('dragging');
  });
}
elements['upload-zone'].addEventListener('drop', event => {
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadFile(file);
});
elements['video-file'].addEventListener('change', event => {
  const file = event.target.files?.[0];
  if (file) uploadFile(file);
});

async function uploadFile(file) {
  const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
  if (!allowedTypes.includes(file.type)) return message('Bitte wähle ein MP4-, MOV- oder WebM-Video.', 'error');
  if (file.size > 500_000_000) return message('Das Video ist größer als 500 MB.', 'error');
  state.upload = null;
  state.intent = null;
  state.idempotencyKey = crypto.randomUUID();
  elements['upload-state'].textContent = 'Upload läuft…';
  updatePublishButton();
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(file);
  elements['video-preview'].src = state.previewUrl;
  elements['video-preview'].hidden = false;
  try {
    const durationSeconds = await readVideoDuration(elements['video-preview']);
    if (state.creator?.maxVideoDurationSeconds > 0 && durationSeconds > state.creator.maxVideoDurationSeconds) {
      throw new Error(`Das Video ist ${formatDuration(durationSeconds)} lang. TikTok erlaubt für dieses Konto aktuell höchstens ${formatDuration(state.creator.maxVideoDurationSeconds)}.`);
    }
    const payload = await api('/api/v1/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'X-File-Name': file.name,
        'X-Video-Duration-Seconds': durationSeconds.toFixed(3)
      },
      body: file
    });
    state.upload = payload.upload;
    elements['upload-state'].textContent = payload.upload.duplicate ? 'Bereits sicher hochgeladen' : 'Sicher hochgeladen';
    elements['file-name'].textContent = payload.upload.fileName;
    elements['file-size'].textContent = formatBytes(payload.upload.sizeBytes);
    elements['file-duration'].textContent = formatDuration(payload.upload.durationSeconds);
    elements['file-hash'].textContent = payload.upload.sha256.slice(0, 16) + '…';
    elements['file-details'].hidden = false;
    message(payload.upload.duplicate ? 'Diese identische Datei war bereits vorhanden. Es wurde keine zweite Kopie angelegt.' : 'Video wurde sicher hochgeladen.', 'success');
  } catch (error) {
    elements['upload-state'].textContent = 'Upload fehlgeschlagen';
    message(error.message, 'error');
  }
  updatePublishButton();
}

elements.caption.addEventListener('input', () => {
  elements['caption-count'].textContent = String(elements.caption.value.length);
  updatePublishButton();
});
elements.privacy.addEventListener('change', syncCommercialContent);
elements['commercial-content'].addEventListener('change', syncCommercialContent);
elements['brand-organic'].addEventListener('change', syncCommercialContent);
elements['brand-content'].addEventListener('change', syncCommercialContent);
elements['accepted-rights'].addEventListener('change', updatePublishButton);

elements['publish-form'].addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity() || !state.upload || !state.creator?.connected || state.intent) return;
  if (elements['commercial-content'].checked && !elements['brand-organic'].checked && !elements['brand-content'].checked) {
    message('Gib an, ob der kommerzielle Inhalt dich, eine dritte Partei oder beide bewirbt.', 'error');
    return;
  }
  setBusy(true, 'Veröffentlichung wird gestartet…');
  message('Zielkonto und aktuelle TikTok-Optionen werden noch einmal geprüft.');
  try {
    const payload = await api('/api/v1/publish-intents', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': state.idempotencyKey
      },
      body: JSON.stringify({
        uploadId: state.upload.id,
        caption: elements.caption.value,
        privacyLevel: elements.privacy.value,
        disableComment: !elements['allow-comment'].checked,
        disableDuet: !elements['allow-duet'].checked,
        disableStitch: !elements['allow-stitch'].checked,
        isAigc: elements['is-aigc'].checked,
        commercialContent: elements['commercial-content'].checked,
        brandOrganicToggle: elements['brand-organic'].checked,
        brandContentToggle: elements['brand-content'].checked,
        acceptedRights: elements['accepted-rights'].checked
      })
    });
    state.intent = payload.intent;
    message(payload.replayed ? 'Der vorhandene Auftrag wurde sicher wiedergefunden; es wurde kein zweiter Post gestartet.' : 'TikTok verarbeitet den einmaligen Veröffentlichungsauftrag.', 'success');
    await loadHistory();
    await pollIntent(payload.intent.id);
  } catch (error) {
    if (error.details?.intent) state.intent = error.details.intent;
    message(error.message, 'error');
    await loadHistory();
  } finally {
    setBusy(false);
  }
});

async function pollIntent(intentId) {
  for (const delay of [5_000, 10_000, 20_000, 20_000]) {
    await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const payload = await api(`/api/v1/publish-intents/${encodeURIComponent(intentId)}`);
      state.intent = payload.intent;
      await loadHistory();
      if (payload.intent.status === 'PUBLISH_COMPLETE') {
        message(`Veröffentlichung auf @${payload.intent.tiktokUsername} ist abgeschlossen.`, 'success');
        return;
      }
      if (['FAILED', 'REJECTED', 'CANCELLED'].includes(payload.intent.status)) {
        message(payload.intent.error?.message || 'TikTok konnte das Video nicht veröffentlichen.', 'error');
        return;
      }
    } catch (error) {
      message(`Der Status wird später erneut geprüft: ${error.message}`, 'error');
      return;
    }
  }
  message('TikTok verarbeitet den Auftrag weiter. Der Status kann unten mit „Aktualisieren“ geprüft werden.');
}

elements['refresh-history'].addEventListener('click', loadHistory);
window.addEventListener('beforeunload', () => {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
});

initialize();
