const sceneModule = require('./player/scene-composition-player.js');
module.exports = { SceneCompositionPlayer: sceneModule.default, Events: sceneModule.SceneCompositionEvents };
