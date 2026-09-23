import test from 'node:test';
import assert from 'node:assert/strict';
import { TikTokComposioService } from '../server/lib/composio.mjs';

function serviceFixture(creator) {
  const service = Object.create(TikTokComposioService.prototype);
  let execution;
  const session = {
    async execute(tool, input) {
      execution = { tool, input };
      return { data: { publish_id: 'publish-test-1' } };
    }
  };
  service.connectionState = async () => ({ connected: true, session });
  service.creatorInfo = async () => ({
    connected: true,
    username: 'creator_test',
    privacyOptions: ['SELF_ONLY'],
    maxVideoDurationSeconds: 30,
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    ...creator
  });
  return { service, getExecution: () => execution };
}

function intentFixture() {
  return {
    caption: 'Eigener Retro-Test',
    privacy_level: 'SELF_ONLY',
    disable_comment: 0,
    disable_duet: 0,
    disable_stitch: 0,
    is_aigc: 0,
    brand_content_toggle: 0,
    brand_organic_toggle: 0
  };
}

test('creator restrictions are enforced in the TikTok upload request', async () => {
  const { service, getExecution } = serviceFixture({ commentDisabled: true, stitchDisabled: true });
  const result = await service.publish('user-1', intentFixture(), {
    local_path: 'D:/safe/video.mp4',
    duration_seconds: 12.5
  });
  assert.equal(result.publishId, 'publish-test-1');
  assert.equal(getExecution().tool, 'TIKTOK_UPLOAD_VIDEO');
  assert.equal(getExecution().input.disable_comment, true);
  assert.equal(getExecution().input.disable_duet, false);
  assert.equal(getExecution().input.disable_stitch, true);
});

test('video longer than the fresh creator limit is rejected before upload initialization', async () => {
  const { service, getExecution } = serviceFixture({ maxVideoDurationSeconds: 10 });
  await assert.rejects(
    service.publish('user-1', intentFixture(), {
      local_path: 'D:/safe/video.mp4',
      duration_seconds: 12.5
    }),
    error => error.code === 'video_duration_too_long' && error.status === 409
  );
  assert.equal(getExecution(), undefined);
});
