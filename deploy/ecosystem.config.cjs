module.exports = {
  apps: [
    {
      name: "meteora-bidask-flip",
      cwd: __dirname + "/..",
      script: "dist/cli.js",
      args: "run --config config.yaml",
      interpreter: "node",
      autorestart: true,
      max_restarts: 20,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
