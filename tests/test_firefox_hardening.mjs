import { firefox } from 'playwright';

const base = process.env.SCENE_TEST_BASE || 'http://127.0.0.1:8765';
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage();
const browserErrors = [];
page.on('pageerror', (error) => browserErrors.push(`pageerror: ${String(error)}`));
page.on('console', (message) => {
  if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
});

try {
  await page.goto(`${base}/demo/academic-scene.html`, { waitUntil: 'networkidle' });

  // Track topology must be stable across one multiplexed SourceBuffer.
  await page.evaluate(async () => {
    const manifest = await fetch('.ci-scenes/compilation.json').then((response) => response.json());
    manifest.scenes[1].mimeType = manifest.scenes[1].mimeType.replace(/,\s*mp4a\.40\.2/i, '');
    player = new AcademicSceneMSE.SceneCompositionPlayer({ type: 'scenes', manifest }, {
      keyboardSceneNavigation: false,
      showSceneTitles: false
    });
    player.attachMediaElement(video);
    player.load();
  });

  await page.waitForFunction(() => player && player._load_error != null, null, { timeout: 10000 });
  const topologyError = await page.evaluate(() => String(player._load_error && player._load_error.message));
  if (!topologyError.includes('same audio/video track topology')) {
    throw new Error(`unexpected topology validation error: ${topologyError}`);
  }
  await page.evaluate(() => player.destroy());

  // Hold media requests long enough to destroy the first generation mid-load.
  await page.route('**/*.m4s', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try {
      await route.continue();
    } catch (e) {
      // Aborted requests are expected when the first player is destroyed.
    }
  });

  await page.evaluate(() => {
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

  await page.waitForFunction(() => player && player._pending_segments && player._pending_segments.size > 0, null, { timeout: 10000 });
  await page.waitForTimeout(100);
  await page.evaluate(() => player.destroy());
  await page.unroute('**/*.m4s');

  await page.evaluate(() => {
    player = new AcademicSceneMSE.SceneCompositionPlayer({
      type: 'scenes',
      url: '.ci-scenes/compilation.json'
    }, {
      keyboardSceneNavigation: true,
      showSceneTitles: false,
      preloadAheadSeconds: 20,
      maxBufferBehindSeconds: 0.5,
      cleanupIntervalSeconds: 0
    });
    player.attachMediaElement(video);
    player.load();
  });

  await page.waitForFunction(() => player && (player._ready === true || player._load_error != null), null, { timeout: 30000 });
  const replacement = await page.evaluate(() => ({
    ready: player._ready === true,
    error: player._load_error ? String(player._load_error.message || player._load_error) : null,
    loadedSegments: player._loaded_segments ? player._loaded_segments.size : 0,
    mediaError: video.error ? { code: video.error.code, message: video.error.message || '' } : null,
    textTracks: video.textTracks.length
  }));

  if (!replacement.ready || replacement.error) {
    throw new Error(`replacement player failed after cancellation: ${JSON.stringify(replacement)}`);
  }
  if (replacement.loadedSegments !== 6) {
    throw new Error(`replacement player loaded ${replacement.loadedSegments} segments instead of 6`);
  }
  if (replacement.mediaError) {
    throw new Error(`replacement media error: ${JSON.stringify(replacement.mediaError)}`);
  }
  if (replacement.textTracks !== 0) {
    throw new Error(`titles disabled but replacement has ${replacement.textTracks} TextTrack(s)`);
  }

  // Move near the end, evict only the completed first Scene, then verify a
  // backward seek reloads its three fragments and decodes it again.
  await page.evaluate(() => {
    video.currentTime = player.duration - 0.25;
    player._cleanupOldBuffer();
  });
  await page.waitForFunction(() => player._loaded_segments && player._loaded_segments.size === 3, null, { timeout: 10000 });
  const afterEviction = await page.evaluate(() => ({
    loadedSegments: player._loaded_segments.size,
    keys: Array.from(player._loaded_segments).sort()
  }));
  if (afterEviction.keys.some((key) => key.startsWith('0:'))) {
    throw new Error(`Scene 1 fragments were not fully evicted: ${JSON.stringify(afterEviction)}`);
  }

  await page.evaluate(() => { player.currentTime = 0.75; });
  await page.waitForFunction(() => player.currentSceneIndex === 0, null, { timeout: 15000 });
  await page.waitForFunction(() => player._loaded_segments && player._loaded_segments.size === 6, null, { timeout: 15000 });
  await page.waitForFunction(() => video.videoWidth === 640 && video.videoHeight === 360, null, { timeout: 15000 });
  const afterReload = await page.evaluate(() => ({
    loadedSegments: player._loaded_segments.size,
    sceneIndex: player.currentSceneIndex,
    width: video.videoWidth,
    height: video.videoHeight,
    mediaError: video.error ? { code: video.error.code, message: video.error.message || '' } : null
  }));
  if (afterReload.mediaError) {
    throw new Error(`media error after backward reload: ${JSON.stringify(afterReload.mediaError)}`);
  }

  // Arrow keys belong to Scene navigation only when the native video itself is
  // the active player context. Other page controls must keep their arrows.
  await page.locator('#load').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  const unrelatedControlScene = await page.evaluate(() => player.currentSceneIndex);
  if (unrelatedControlScene !== 0) {
    throw new Error(`ArrowRight changed Scene while unrelated control was focused: ${unrelatedControlScene}`);
  }

  await page.locator('#video').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => player.currentSceneIndex === 1, null, { timeout: 10000 });
  const videoFocusedScene = await page.evaluate(() => player.currentSceneIndex);
  if (videoFocusedScene !== 1) {
    throw new Error(`ArrowRight did not navigate Scene while video was focused: ${videoFocusedScene}`);
  }

  // Native Scene titles are opt-in. Prove the cue contract separately from the
  // pristine titles-disabled/VSR path above.
  await page.evaluate(() => player.destroy());
  const titlePage = await browser.newPage();
  const titleErrors = [];
  titlePage.on('pageerror', (error) => titleErrors.push(`pageerror: ${String(error)}`));
  titlePage.on('console', (message) => {
    if (message.type() === 'error') titleErrors.push(`console: ${message.text()}`);
  });
  await titlePage.goto(`${base}/demo/academic-scene.html`, { waitUntil: 'networkidle' });
  await titlePage.evaluate(() => {
    player = new AcademicSceneMSE.SceneCompositionPlayer({
      type: 'scenes',
      url: '.ci-scenes/compilation.json'
    }, {
      keyboardSceneNavigation: false,
      showSceneTitles: true,
      sceneTitleCueDuration: 4
    });
    player.attachMediaElement(video);
    player.load();
  });
  await titlePage.waitForFunction(() => player && (player._ready === true || player._load_error != null), null, { timeout: 30000 });
  const titles = await titlePage.evaluate(() => {
    const track = video.textTracks[0];
    const cues = track && track.cues ? Array.from(track.cues).map((cue) => ({
      id: cue.id,
      text: cue.text,
      startTime: cue.startTime,
      endTime: cue.endTime
    })) : [];
    return {
      ready: player._ready === true,
      error: player._load_error ? String(player._load_error.message || player._load_error) : null,
      trackCount: video.textTracks.length,
      mode: track ? track.mode : null,
      cues
    };
  });
  await titlePage.close();

  if (!titles.ready || titles.error) {
    throw new Error(`title-cue player failed: ${JSON.stringify(titles)}`);
  }
  if (titles.trackCount !== 1 || titles.mode !== 'showing') {
    throw new Error(`unexpected native Scene title track: ${JSON.stringify(titles)}`);
  }
  if (titles.cues.length !== 2 || titles.cues[0].text !== 'Scene 1' || titles.cues[1].text !== 'Scene 2') {
    throw new Error(`unexpected Scene title cues: ${JSON.stringify(titles.cues)}`);
  }
  if (!(titles.cues[0].startTime === 0 && titles.cues[1].startTime > titles.cues[0].startTime)) {
    throw new Error(`unexpected Scene cue timing: ${JSON.stringify(titles.cues)}`);
  }
  if (titleErrors.length) {
    throw new Error(`title browser errors: ${titleErrors.join(' | ')}`);
  }

  if (browserErrors.length) {
    throw new Error(`browser errors: ${browserErrors.join(' | ')}`);
  }

  console.log(JSON.stringify({
    ok: true,
    topologyError,
    replacement,
    afterEviction,
    afterReload,
    keyboard: { unrelatedControlScene, videoFocusedScene },
    titles
  }));
} finally {
  await browser.close();
}
