const sceneModule = require('./player/scene-composition-player.js');
const AcademicSceneCompositionPlayer = require('./player/academic-scene-composition-player.js').default;
module.exports = { SceneCompositionPlayer: AcademicSceneCompositionPlayer, Events: sceneModule.SceneCompositionEvents };
