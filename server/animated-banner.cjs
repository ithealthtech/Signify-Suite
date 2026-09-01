"use strict";

const sharp = require("sharp");

const MAX_ANIMATED_BANNER_WIDTH = 440,
  MAX_ANIMATED_BANNER_HEIGHT = 220,
  MIN_FRAMES = 2,
  MAX_FRAMES = 60,
  QUALITY_PROFILES = Object.freeze({
    standard: Object.freeze({
      colours: 192,
      effort: 7,
      dither: 0.82,
      interFrameMaxError: 3,
      interPaletteMaxError: 5,
    }),
    high: Object.freeze({
      colours: 256,
      effort: 9,
      dither: 1,
      interFrameMaxError: 1,
      interPaletteMaxError: 2,
    }),
    ultra: Object.freeze({
      colours: 256,
      effort: 10,
      dither: 1,
      interFrameMaxError: 0,
      interPaletteMaxError: 0,
    }),
  });

function inputError(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function decodeFrame(value, expectedBytes) {
  const encoded = String(value || "");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw inputError(
      "GIF_FRAME_INVALID",
      "Animated banner frame data is invalid.",
    );
  const frame = Buffer.from(encoded, "base64");
  if (frame.length !== expectedBytes)
    throw inputError(
      "GIF_FRAME_SIZE_INVALID",
      "Animated banner frame dimensions do not match the requested size.",
    );
  return frame;
}

function parseAnimatedBannerInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw inputError(
      "GIF_INPUT_INVALID",
      "Animated banner data must be an object.",
    );
  if (
    !Array.isArray(body.frames) ||
    body.frames.length < MIN_FRAMES ||
    body.frames.length > MAX_FRAMES
  )
    throw inputError(
      "GIF_FRAMES_INVALID",
      `Animated banner must include ${MIN_FRAMES} to ${MAX_FRAMES} frames.`,
    );
  const width = Number(body.width),
    height = Number(body.height);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_ANIMATED_BANNER_WIDTH ||
    height > MAX_ANIMATED_BANNER_HEIGHT
  )
    throw inputError(
      "GIF_DIMENSIONS_INVALID",
      `Animated banners must fit within ${MAX_ANIMATED_BANNER_WIDTH} by ${MAX_ANIMATED_BANNER_HEIGHT} pixels.`,
    );
  const delay = Number(body.delay);
  if (!Number.isInteger(delay) || delay < 40 || delay > 250 || delay % 10 !== 0)
    throw inputError(
      "GIF_DELAY_INVALID",
      "Animation frame delay must be between 40 and 250 milliseconds in 10 millisecond steps.",
    );
  const quality = String(body.quality || "ultra").toLowerCase();
  if (!QUALITY_PROFILES[quality])
    throw inputError(
      "GIF_QUALITY_INVALID",
      "Choose a valid animation quality profile.",
    );
  const expectedBytes = width * height * 4;
  return {
    width,
    height,
    delay,
    quality,
    frames: body.frames.map((frame) => decodeFrame(frame, expectedBytes)),
  };
}

async function encodeAnimatedBanner(input) {
  const { width, height, delay, quality, frames } = input,
    profile = QUALITY_PROFILES[quality],
    delays = Array(frames.length).fill(delay),
    image = sharp(Buffer.concat(frames), {
      raw: {
        width,
        height: height * frames.length,
        channels: 4,
        pageHeight: height,
      },
    });
  return image
    .gif({
      ...profile,
      delay: delays,
      loop: 0,
      reuse: false,
      progressive: false,
      keepDuplicateFrames: true,
    })
    .toBuffer();
}

module.exports = {
  MAX_ANIMATED_BANNER_HEIGHT,
  MAX_ANIMATED_BANNER_WIDTH,
  MAX_FRAMES,
  MIN_FRAMES,
  QUALITY_PROFILES,
  encodeAnimatedBanner,
  parseAnimatedBannerInput,
};
