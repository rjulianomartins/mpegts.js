import { firefox } from 'playwright';

const base = process.env.SCENE_TEST_BASE || 'http://127.0.0.1:8765';
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${String(error)}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

async function snapshot() {
  return page.evaluate(() => {
    const v = document.getElementById('video');
    const status = document.getElementById('status')?.textContent || '';
    const mediaError = v && v.error ? { code: v.error.code, message: v.error.message || '' } : null;
    let playerState = null;
    try {
      playerState = player ? {
        sceneCount: player.sceneCount,
        currentSceneIndex: player.currentSceneIndex,
        currentTime: player.currentTime,
        duration: player.duration,
        loadError: player._load_error ? String(player._load_error.message || player._load_error) : null,
        ready: player._ready === true,
        activeMimeType: player._active_mime_type || null,
        loadedSegments: player._loaded_segments ? player._loaded_segments.size : null
      } : null;
    } catch (e) {
      playerState = { inspectError: String(e) };
    }
    return {
      status,
      media: v ? {
        readyState: v.readyState,
        networkState: v.networkState,
        duration: v.duration,
        currentTime: v.currentTime,
        width: v.videoWidth,
        height: v.videoHeight,
        textTracks: v.textTracks.length,
        currentSrc: v.currentSrc,
        error: mediaError
      } : null,
      player: playerState
    };
  });
}

try {
  await page.goto(`${base}/demo/academic-scene.html`, { waitUntil: 'networkidle' });
  await page.fill('#manifest', '.ci-scenes/compilation.json');
  await page.click('#load');

  try {
    await page.waitForFunction(() => {
      if (!player) return false;
      return player._ready === true || player._load_error != null;
    }, null, { timeout: 30000 });
  } catch (error) {
    const state = await snapshot();
    throw new Error(`ready timeout: ${JSON.stringify({ state, errors }, null, 2)}`);
  }

  const firstState = await snapshot();
  if (firstState.player?.loadError) {
    throw new Error(`player reported load error: ${JSON.stringify({ state: firstState, errors }, null, 2)}`);
  }
  if (!firstState.player?.ready) {
    throw new Error(`player did not become ready: ${JSON.stringify({ state: firstState, errors }, null, 2)}`);
  }
  if (firstState.media?.textTracks !== 0) {
    throw new Error(`Scene titles disabled but ${firstState.media?.textTracks} TextTrack(s) exist`);
  }

  const initial = await page.evaluate(() => ({
    duration: video.duration,
    logicalDuration: player.duration,
    sceneCount: player.sceneCount,
    currentSceneIndex: player.currentSceneIndex,
    width: video.videoWidth,
    height: video.videoHeight,
    buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)])
  }));

  if (!(initial.duration > 8 && initial.duration < 12)) {
    throw new Error(`unexpected compilation duration ${initial.duration}`);
  }
  if (Math.abs(initial.duration - initial.logicalDuration) > 0.05) {
    throw new Error(`native duration drift: native=${initial.duration} logical=${initial.logicalDuration}`);
  }
  if (initial.sceneCount !== 2) {
    throw new Error(`unexpected scene count ${initial.sceneCount}`);
  }
  if (initial.width !== 640 || initial.height !== 360) {
    throw new Error(`unexpected first Scene resolution ${initial.width}x${initial.height}`);
  }

  await page.click('#play');
  await page.waitForFunction(() => video.currentTime > 0.4, null, { timeout: 15000 });

  const boundary = await page.evaluate(() => player.getTimeline()[1].timelineStart);
  await page.evaluate((t) => { player.currentTime = t + 0.75; }, boundary);
  await page.waitForFunction(() => player.currentSceneIndex === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => video.videoWidth === 854 && video.videoHeight === 480, null, { timeout: 15000 });

  const forward = await page.evaluate(() => ({
    currentTime: video.currentTime,
    sceneIndex: player.currentSceneIndex,
    width: video.videoWidth,
    height: video.videoHeight
  }));
  if (forward.sceneIndex !== 1) {
    throw new Error('failed to seek into second scene');
  }

  await page.evaluate(() => { player.currentTime = 0.75; });
  await page.waitForFunction(() => player.currentSceneIndex === 0, null, { timeout: 15000 });
  await page.waitForFunction(() => video.videoWidth === 640 && video.videoHeight === 360, null, { timeout: 15000 });

  await page.evaluate(() => {
    player.destroy();
    player = new AcademicSceneMSE.SceneCompositionPlayer({
      type: 'scenes',
      url: '.ci-scenes/compilation.json'
    }, {
      keyboardSceneNavigation: false,
      showSceneTitles: false,
      preloadAheadSeconds: 20
    });
    player.attachMediaElement(video);
    player.load();
  });

  await page.waitForFunction(() => player && player._ready === true && player.sceneCount === 2 && Number.isFinite(video.duration) && video.duration > 0, null, { timeout: 30000 });
  const reloadedTextTracks = await page.evaluate(() => video.textTracks.length);
  if (reloadedTextTracks !== 0) {
    throw new Error(`reloaded player created ${reloadedTextTracks} TextTrack(s) with titles disabled`);
  }

  if (errors.length) {
    throw new Error(`browser errors: ${errors.join(' | ')}`);
  }

  console.log(JSON.stringify({ ok: true, initial, forward }));
} finally {
  await browser.close();
}
