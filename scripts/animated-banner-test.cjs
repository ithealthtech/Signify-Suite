"use strict";

const assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  MAX_ANIMATED_BANNER_HEIGHT,
  MAX_ANIMATED_BANNER_WIDTH,
  MAX_FRAMES,
  QUALITY_PROFILES,
  encodeAnimatedBanner,
  parseAnimatedBannerInput,
} = require("../server/animated-banner.cjs");

const TEST_WIDTH = 440,
  TEST_HEIGHT = 190;

function frame(seed, width = TEST_WIDTH, height = TEST_HEIGHT) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      bytes[offset] = (x + seed * 31) % 256;
      bytes[offset + 1] = (y * 2 + seed * 47) % 256;
      bytes[offset + 2] = (x + y + seed * 59) % 256;
      bytes[offset + 3] = 255;
    }
  return bytes.toString("base64");
}

function payload(overrides = {}) {
  return {
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    delay: 80,
    quality: "high",
    frames: [frame(1), frame(2), frame(3)],
    ...overrides,
  };
}

assert.deepEqual(Object.keys(QUALITY_PROFILES), ["standard", "high", "ultra"]);
assert.throws(
  () => parseAnimatedBannerInput(payload({ frames: [frame(1)] })),
  (error) => error.code === "GIF_FRAMES_INVALID" && error.status === 400,
);
assert.throws(
  () =>
    parseAnimatedBannerInput(
      payload({
        frames: Array.from({ length: MAX_FRAMES + 1 }, (_, i) => frame(i)),
      }),
    ),
  (error) => error.code === "GIF_FRAMES_INVALID",
);
assert.throws(
  () =>
    parseAnimatedBannerInput(payload({ width: MAX_ANIMATED_BANNER_WIDTH + 1 })),
  (error) => error.code === "GIF_DIMENSIONS_INVALID",
);
assert.throws(
  () =>
    parseAnimatedBannerInput(
      payload({ height: MAX_ANIMATED_BANNER_HEIGHT + 1 }),
    ),
  (error) => error.code === "GIF_DIMENSIONS_INVALID",
);
assert.throws(
  () => parseAnimatedBannerInput(payload({ delay: 39 })),
  (error) => error.code === "GIF_DELAY_INVALID",
);
assert.throws(
  () => parseAnimatedBannerInput(payload({ delay: 75 })),
  (error) => error.code === "GIF_DELAY_INVALID",
);
assert.throws(
  () => parseAnimatedBannerInput(payload({ quality: "maximum" })),
  (error) => error.code === "GIF_QUALITY_INVALID",
);
assert.throws(
  () => parseAnimatedBannerInput(payload({ frames: ["%%%", frame(2)] })),
  (error) => error.code === "GIF_FRAME_INVALID",
);
assert.throws(
  () =>
    parseAnimatedBannerInput(
      payload({ frames: [Buffer.alloc(8).toString("base64"), frame(2)] }),
    ),
  (error) => error.code === "GIF_FRAME_SIZE_INVALID",
);

(async () => {
  const input = parseAnimatedBannerInput(payload({ quality: "ultra" })),
    bytes = await encodeAnimatedBanner(input),
    metadata = await sharp(bytes, { animated: true }).metadata();
  assert.equal(metadata.format, "gif");
  assert.equal(metadata.width, TEST_WIDTH);
  assert.equal(metadata.pageHeight, TEST_HEIGHT);
  assert.equal(metadata.height, TEST_HEIGHT * input.frames.length);
  assert.equal(metadata.pages, input.frames.length);
  assert.deepEqual(
    metadata.delay,
    Array(input.frames.length).fill(input.delay),
  );
  assert.equal(metadata.loop, 0);
  assert.ok(bytes.length > 1000, "Encoded animation is unexpectedly empty");
  console.log(
    `Animated banner tests passed: ${metadata.pages} frames, ${bytes.length} bytes`,
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
