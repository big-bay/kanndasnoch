import { Composio } from '@composio/core';
import { httpError } from './security.mjs';

const TIKTOK_TOOLS = Object.freeze([
  'TIKTOK_QUERY_CREATOR_INFO',
  'TIKTOK_GET_USER_STATS',
  'TIKTOK_LIST_VIDEOS',
  'TIKTOK_UPLOAD_VIDEO',
  'TIKTOK_FETCH_PUBLISH_STATUS'
]);

function findDeep(value, keys) {
  if (!value || typeof value !== 'object') return undefined;
  for (const key of keys) {
    if (Object.hasOwn(value, key)) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findDeep(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function unwrap(result) {
  if (result?.successful === false || result?.success === false) {
    const message = findDeep(result, ['message', 'error_message']) || 'TikTok hat die Anfrage abgelehnt.';
    const code = findDeep(result, ['error_code', 'code']) || 'tiktok_request_failed';
    throw httpError(502, String(code), String(message));
  }
  return result?.data ?? result;
}

function arrayDeep(value, keys) {
  const found = findDeep(value, keys);
  return Array.isArray(found) ? found : [];
}

export class TikTokComposioService {
  constructor(config, database) {
    this.config = config;
    this.database = database;
    this.client = config.composioReady
      ? new Composio({
          apiKey: config.composioApiKey,
          allowTracking: false,
          dangerouslyAllowAutoUploadDownloadFiles: true,
          sensitiveFileUploadProtection: true,
          fileUploadDirs: [config.uploadsDir]
        })
      : null;
  }

  assertConfigured() {
    if (!this.client) {
      throw httpError(503, 'integration_not_configured', 'Die TikTok-Integration ist auf diesem Server noch nicht aktiviert.');
    }
  }

  async sessionFor(userId) {
    this.assertConfigured();
    const storedSessionId = this.database.getComposioSession(userId);
    if (storedSessionId) {
      try {
        return await this.client.sessions.use(storedSessionId);
      } catch {
        // A server-side session can expire or be removed; create a clean replacement below.
      }
    }
    const session = await this.client.sessions.create(userId, {
      toolkits: ['tiktok'],
      authConfigs: { tiktok: this.config.composioTikTokAuthConfigId },
      manageConnections: false,
      sandbox: { enable: false },
      preload: { tools: TIKTOK_TOOLS }
    });
    this.database.saveComposioSession(userId, session.sessionId);
    return session;
  }

  async connectionState(userId) {
    const session = await this.sessionFor(userId);
    const page = await session.toolkits({ toolkits: ['tiktok'], limit: 10 });
    const toolkit = page.items.find(item => item.slug.toLowerCase() === 'tiktok');
    return {
      connected: Boolean(toolkit?.connection?.isActive),
      connectionId: toolkit?.connection?.connectedAccount?.id || null,
      session
    };
  }

  async createConnectLink(userId) {
    const session = await this.sessionFor(userId);
    const request = await session.authorize('tiktok', {
      callbackUrl: `${this.config.publicBaseUrl}/app.html?connected=tiktok`
    });
    if (!request?.redirectUrl) throw httpError(502, 'missing_redirect_url', 'Die TikTok-Anmeldeseite konnte nicht erzeugt werden.');
    return { redirectUrl: request.redirectUrl };
  }

  async creatorInfo(userId) {
    const state = await this.connectionState(userId);
    if (!state.connected) return { connected: false };
    const [creatorRaw, profileRaw] = await Promise.all([
      state.session.execute('TIKTOK_QUERY_CREATOR_INFO', {}),
      state.session.execute('TIKTOK_GET_USER_STATS', {
        fields: ['username', 'display_name', 'avatar_url', 'profile_deep_link']
      })
    ]);
    const creator = unwrap(creatorRaw);
    const profile = unwrap(profileRaw);
    return {
      connected: true,
      username: String(findDeep(profile, ['username']) || ''),
      displayName: String(findDeep(profile, ['display_name', 'displayName']) || ''),
      avatarUrl: String(findDeep(profile, ['avatar_url', 'avatarUrl']) || ''),
      profileUrl: String(findDeep(profile, ['profile_deep_link', 'profileDeepLink']) || ''),
      privacyOptions: arrayDeep(creator, ['privacy_level_options', 'privacyLevelOptions']).map(String),
      maxVideoDurationSeconds: Number(findDeep(creator, ['max_video_post_duration_sec', 'maxVideoPostDurationSec']) || 0),
      commentDisabled: Boolean(findDeep(creator, ['comment_disabled', 'commentDisabled'])),
      duetDisabled: Boolean(findDeep(creator, ['duet_disabled', 'duetDisabled'])),
      stitchDisabled: Boolean(findDeep(creator, ['stitch_disabled', 'stitchDisabled']))
    };
  }

  async listAllPublicVideos(session) {
    const videos = [];
    let cursor;
    for (let page = 0; page < 100; page += 1) {
      const result = unwrap(await session.execute('TIKTOK_LIST_VIDEOS', {
        max_count: 20,
        ...(cursor === undefined ? {} : { cursor })
      }));
      videos.push(...arrayDeep(result, ['videos', 'items']));
      const hasMore = Boolean(findDeep(result, ['has_more', 'hasMore']));
      const nextCursor = findDeep(result, ['cursor', 'next_cursor', 'nextCursor']);
      if (!hasMore || nextCursor === undefined || nextCursor === null) break;
      cursor = Number(nextCursor);
    }
    return videos;
  }

  async publish(userId, intent, upload) {
    const state = await this.connectionState(userId);
    if (!state.connected) throw httpError(409, 'tiktok_not_connected', 'Verbinde zuerst dein TikTok-Konto.');
    const creator = await this.creatorInfo(userId);
    if (!creator.username) throw httpError(502, 'username_not_confirmed', 'TikTok hat den Kontonamen nicht bestätigt.');
    if (!creator.privacyOptions.includes(intent.privacy_level)) {
      throw httpError(409, 'privacy_not_available', 'Die gewählte Sichtbarkeit wird für dieses Konto aktuell nicht angeboten.', {
        allowed: creator.privacyOptions
      });
    }
    if (!Number.isFinite(upload.duration_seconds) || upload.duration_seconds <= 0) {
      throw httpError(409, 'video_duration_missing', 'Die Videodauer konnte nicht sicher bestätigt werden. Lade die Datei bitte erneut hoch.');
    }
    if (creator.maxVideoDurationSeconds > 0 && upload.duration_seconds > creator.maxVideoDurationSeconds) {
      throw httpError(409, 'video_duration_too_long', 'Das Video überschreitet die aktuell von TikTok erlaubte Dauer.', {
        durationSeconds: upload.duration_seconds,
        maximumSeconds: creator.maxVideoDurationSeconds
      });
    }

    if (intent.privacy_level === 'PUBLIC_TO_EVERYONE') {
      const videos = await this.listAllPublicVideos(state.session);
      const normalizedCaption = intent.caption.trim().replace(/\s+/g, ' ').toLowerCase();
      const duplicate = videos.some(video => {
        const title = String(findDeep(video, ['title', 'video_description', 'description']) || '').trim().replace(/\s+/g, ' ').toLowerCase();
        return title && title === normalizedCaption;
      });
      if (duplicate) throw httpError(409, 'public_duplicate_detected', 'Ein öffentlicher TikTok-Beitrag mit identischem Text ist bereits vorhanden.');
    }

    const result = unwrap(await state.session.execute('TIKTOK_UPLOAD_VIDEO', {
      file_to_upload: upload.local_path,
      publish: true,
      caption: intent.caption,
      privacy_level: intent.privacy_level,
      disable_comment: creator.commentDisabled || Boolean(intent.disable_comment),
      disable_duet: creator.duetDisabled || Boolean(intent.disable_duet),
      disable_stitch: creator.stitchDisabled || Boolean(intent.disable_stitch),
      is_aigc: Boolean(intent.is_aigc),
      brand_content_toggle: Boolean(intent.brand_content_toggle),
      brand_organic_toggle: Boolean(intent.brand_organic_toggle)
    }));
    const publishId = findDeep(result, ['publish_id', 'publishId']);
    if (!publishId) throw httpError(502, 'missing_publish_id', 'TikTok hat keine Veröffentlichungs-ID zurückgegeben.');
    return { publishId: String(publishId), username: creator.username, result };
  }

  async publishStatus(userId, publishId) {
    const state = await this.connectionState(userId);
    if (!state.connected) throw httpError(409, 'tiktok_not_connected', 'Die TikTok-Verbindung ist nicht aktiv.');
    const result = unwrap(await state.session.execute('TIKTOK_FETCH_PUBLISH_STATUS', { publish_id: publishId }));
    const status = String(findDeep(result, ['status']) || 'PROCESSING_UPLOAD');
    const publicVideoId = findDeep(result, ['publicaly_available_post_id', 'publicly_available_post_id', 'video_id', 'videoId']);
    const errorCode = findDeep(result, ['fail_reason', 'error_code', 'errorCode']);
    return { status, publicVideoId: publicVideoId ? String(publicVideoId) : null, errorCode: errorCode ? String(errorCode) : null, result };
  }
}
