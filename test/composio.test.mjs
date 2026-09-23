import test from 'node:test';
import assert from 'node:assert/strict';
import { TikTokComposioService } from '../server/lib/composio.mjs';

function serviceFixture(creator, executeResponse = {
  data: {
    data: {
      publish_id: 'publish-test-1',
      published: true,
      upload_completed: true,
      upload_url: 'https://temporary-upload.invalid/signed-secret'
    },
    successful: true
  }
}) {
  const service = Object.create(TikTokComposioService.prototype);
  let execution;
  let staging;
  const session = {
    async execute(tool, input) {
      execution = { tool, input };
      return executeResponse;
    }
  };
  service.client = {
    files: {
      async upload(input) {
        staging = input;
        return { name: 'video.mp4', mimetype: 'video/mp4', s3key: 'staged/tiktok/video.mp4' };
      }
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
  return { service, getExecution: () => execution, getStaging: () => staging };
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
  const { service, getExecution, getStaging } = serviceFixture({ commentDisabled: true, stitchDisabled: true });
  const result = await service.publish('user-1', intentFixture(), {
    local_path: 'D:/safe/video.mp4',
    duration_seconds: 12.5
  });
  assert.equal(result.publishId, 'publish-test-1');
  assert.deepEqual(result.result, { published: true, uploadCompleted: true });
  assert.equal(JSON.stringify(result).includes('upload_url'), false);
  assert.deepEqual(getStaging(), {
    file: 'D:/safe/video.mp4',
    toolSlug: 'TIKTOK_UPLOAD_VIDEO',
    toolkitSlug: 'tiktok'
  });
  assert.equal(getExecution().tool, 'TIKTOK_UPLOAD_VIDEO');
  assert.deepEqual(getExecution().input.file_to_upload, {
    name: 'video.mp4',
    mimetype: 'video/mp4',
    s3key: 'staged/tiktok/video.mp4'
  });
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

test('nested Composio validation failures are surfaced instead of becoming missing publish IDs', async () => {
  const { service } = serviceFixture({}, {
    data: {
      successfull: false,
      successful: false,
      error: 'Input should be a valid FileUploadable object',
      data: { status_code: 400 }
    },
    error: null
  });
  await assert.rejects(
    service.publish('user-1', intentFixture(), {
      local_path: 'D:/safe/video.mp4',
      duration_seconds: 12.5
    }),
    error => error.code === '400' && /FileUploadable/.test(error.message)
  );
});
