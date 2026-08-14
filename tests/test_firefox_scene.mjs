import { firefox } from 'playwright';

const base = process.env.SCENE_TEST_BASE || 'http://127.0.0.1:8765';
const browser = await firefox.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

try {
  await page.goto(`${base}/demo/academic-scene.html`, { waitUntil: 'networkidle' });
  await page.fill('#manifest', '.ci-scenes/compilation.json');
  await page.click('#load');

  await page.waitForFunction(() => {
    const text = document.querySelector('#status')?.textContent || '';
    return text.includes('"event": "ready"');
  }, null, { timeout: 30000 });

  const initial = await page.evaluate(() => {
    return {
      duration: video.duration,
      sceneCount: player.sceneCount,
      currentSceneIndex: player.currentSceneIndex,
      buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)])
    };
  });

  if (!(initial.duration > 8 && initial.duration < 12)) {
    throw new Error(`unexpected compilation duration ${initial.duration}`);
  }
  if (initial.sceneCount !== 2) {
    throw new Error(`unexpected scene count ${initial.sceneCount}`);
  }

  await page.click('#play');
  await page.waitForFunction(() => video.currentTime > 0.4, null, { timeout: 15000 });

  const boundary = await page.evaluate(() => player.getTimeline()[1].timelineStart);
  await page.evaluate((t) => { player.currentTime = t + 0.75; }, boundary);
  await page.waitForFunction(() => player.currentSceneIndex === 1, null, { timeout: 15000 });

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

  await page.waitForFunction(() => player && player.sceneCount === 2 && Number.isFinite(video.duration) && video.duration > 0, null, { timeout: 30000 });

  if (errors.length) {
    throw new Error(`browser errors: ${errors.join(' | ')}`);
  }

  console.log(JSON.stringify({ ok: true, initial, forward }));
} finally {
  await browser.close();
}
