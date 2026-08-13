const path = require('path');

module.exports = {
    entry: './src/academic-scene-entry.js',
    target: ['web', 'es5'],
    output: {
        filename: 'academic-scene-mse.js',
        path: path.resolve(__dirname, 'dist'),
        library: {
            name: 'AcademicSceneMSE',
            type: 'umd'
        },
        globalObject: 'this'
    },
    devtool: 'source-map',
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json'],
        fallback: {
            'events': require.resolve('events')
        }
    },
    module: {
        rules: [
            {
                test: /\.(ts|js)$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    }
};
