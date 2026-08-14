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
      keyboardSceneNavigation: false,
      showSceneTitles: false,
      preloadAheadSeconds: 20
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
  if (browserErrors.length) {
    throw new Error(`browser errors: ${browserErrors.join(' | ')}`);
  }

  console.log(JSON.stringify({ ok: true, topologyError, replacement }));
} finally {
  await browser.close();
}
