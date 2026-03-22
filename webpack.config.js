const path = require('path');

module.exports = {
  entry: './src/renderer/index.tsx',
  output: {
    filename: 'renderer.js',
    path: path.resolve(__dirname, 'lib/renderer'),
    libraryTarget: 'commonjs2',
  },
  target: 'electron-renderer',
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: {
            configFile: 'tsconfig.renderer.json',
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader'],
      },
    ],
  },
  externals: {
    react: 'react',
    'react-dom': 'react-dom',
    '@getflywheel/local-components': '@getflywheel/local-components',
    '@getflywheel/local': '@getflywheel/local',
  },
};
